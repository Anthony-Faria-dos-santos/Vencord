/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Anthony aka NIXshade and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ============================================================
 * GuildVoiceManager v2 — Plugin de gestion vocale GvG
 * ============================================================
 *
 * OBJECTIF :
 *   Permettre a chaque joueur d'un event GvG (Guerre de Guilde)
 *   de muter localement les groupes adverses pour n'entendre que
 *   son propre groupe pendant les phases de briefing et de combat.
 *   Le mute est LOCAL : seul le joueur qui lance la commande est
 *   affecte, les autres n'entendent aucun changement.
 *
 * ARCHITECTURE DES ROLES (7 roles Discord) :
 *   Groupes de joueurs : ATK (attaquants), DEF (defenseurs), ROM (roamers)
 *   Leaders de groupe  : L.ATK, L.DEF, L.ROM
 *   Chef des leaders    : Chief.L
 *
 *   Un joueur appartient a UN groupe (ATK, DEF ou ROM).
 *   Un leader a son role leader (L.ATK, L.DEF, L.ROM) ET peut
 *   avoir le role de groupe correspondant.
 *   Le Chief.L supervise tous les leaders.
 *
 * FLUX D'UTILISATION TYPIQUE :
 *   1. Les joueurs rejoignent le vocal GvG
 *   2. /gvgcheck  → le leader verifie la presence de tous
 *   3. /brief     → chaque joueur mute les 2 autres groupes (briefing)
 *   4. /go        → mute additif des leaders adverses + message de lancement
 *   5. /lead      → le Chief.L mute tout sauf les leaders pour coordonner
 *   6. /unmute    → debriefing, tout le monde se re-entend
 *
 * CONTRAINTE DE SALON :
 *   Toutes les commandes sauf /unmute sont verrouilees au salon
 *   vocal configure (gvgChannelId). Si le joueur est dans un autre
 *   vocal, un message lui indique de rejoindre le bon salon.
 *   /unmute fonctionne depuis n'importe quel vocal (pour le debriefing
 *   si les joueurs changent de salon apres la GvG).
 *
 * API DISCORD UTILISEES (via Vencord webpack) :
 *   - AudioActions.setLocalVolume(userId, 0|100) : mute/unmute local
 *     ATTENTION : setLocalMute() n'existe plus depuis ~2024.
 *     On utilise setLocalVolume(0) pour muter, setLocalVolume(100)
 *     pour remettre le volume normal. C'est deterministe (pas besoin
 *     de connaitre l'etat actuel contrairement a toggleLocalMute).
 *   - VoiceStateStore.getVoiceStatesForChannel(channelId) : retourne
 *     un Record<userId, VoiceState> de tous les users dans un vocal.
 *   - GuildMemberStore.getMember(guildId, userId) : retourne l'objet
 *     membre avec .roles (array de roleIds) et .nick (surnom serveur).
 *   - GuildRoleStore.getRole(guildId, roleId) : retourne l'objet role
 *     avec .name (nom du role tel qu'affiche dans Discord).
 *   - SelectedChannelStore.getVoiceChannelId() : ID du vocal actuel.
 *   - ChannelStore.getChannel(channelId) : objet channel avec .guild_id.
 *   - UserStore.getCurrentUser() / .getUser(userId) : profils utilisateur.
 *
 * RISQUES DE CASSE APRES MISE A JOUR DISCORD :
 *   - AudioActions : si Discord renomme setLocalVolume ou toggleLocalMute,
 *     le findByPropsLazy ne trouvera plus le module → /vdebug le detecte.
 *   - VoiceStateStore : si Discord renomme ce store, findStoreLazy echoue.
 *   - Les stores importes depuis @webpack/common (GuildRoleStore, etc.)
 *     sont plus stables car maintenus par Vencord. Risque faible.
 *   → En cas de casse, /vdebug affiche exactement ce qui ne marche plus.
 *
 * MAINTENABILITE :
 *   - Tous les noms de roles sont configurables depuis le menu plugin.
 *   - L'ID du salon vocal est configurable (pas hardcode).
 *   - Le tracking des mutes est en memoire (Map<userId, displayName>).
 *     Il est perdu au restart de Discord, ce qui est intentionnel :
 *     un restart remet tout a zero proprement.
 */

// ============================================================
// IMPORTS
// ============================================================

/*
 * @api/Settings : systeme de parametrage Vencord.
 *   definePluginSettings() cree un objet de settings accessible
 *   via settings.store.<key> et affiche dans l'UI plugin.
 */
import { definePluginSettings } from "@api/Settings";

/*
 * @api/Commands : systeme de commandes slash Vencord.
 *   ApplicationCommandInputType.BUILT_IN : commande visible uniquement
 *   par l'utilisateur (pas envoyee au serveur Discord).
 *   sendBotMessage() : affiche un message ephemere dans le chat,
 *   visible uniquement par le joueur (comme un message de bot local).
 */
import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";

/*
 * @utils/types : types Vencord pour la definition de plugin.
 *   definePlugin() : point d'entree obligatoire de tout plugin.
 *   OptionType.STRING : type de champ texte dans les settings.
 */
import definePlugin, { OptionType } from "@utils/types";

/*
 * @webpack : acces aux modules internes de Discord.
 *   findByPropsLazy("prop1", "prop2") : cherche un module webpack
 *   qui exporte les proprietes specifiees. Lazy = cherche au moment
 *   du premier acces, pas au chargement du plugin.
 *   findStoreLazy("StoreName") : cherche un Flux store Discord par nom.
 */
import { findByPropsLazy, findStoreLazy } from "@webpack";

/*
 * @webpack/common : stores Discord pre-resolus par Vencord.
 *   Ces imports sont plus fiables que findStoreLazy car maintenus
 *   par l'equipe Vencord. A privilegier quand disponibles.
 */
import { ChannelStore, GuildMemberStore, GuildRoleStore, SelectedChannelStore, UserStore } from "@webpack/common";

// ============================================================
// MODULES DISCORD INTERNES (resolus dynamiquement)
// ============================================================

/*
 * VoiceStateStore : store Flux contenant l'etat vocal de tous les users.
 *   Methode cle : getVoiceStatesForChannel(channelId)
 *   Retourne Record<userId, { channelId, deaf, mute, selfDeaf, selfMute, ... }>
 *   RISQUE : si Discord renomme ce store, findStoreLazy echoue.
 */
const VoiceStateStore = findStoreLazy("VoiceStateStore");

/*
 * AudioActions : module contenant les actions audio locales.
 *   - setLocalVolume(userId, volume) : volume de 0 (mute) a 200 (x2).
 *     On utilise 0 pour muter et 100 pour le volume normal.
 *   - toggleLocalMute(userId) : bascule mute/unmute (non utilise car
 *     non-deterministe, on ne sait pas l'etat actuel).
 *   RISQUE : c'est le point le plus fragile du plugin. Si Discord
 *   renomme ces methodes, le mute ne fonctionnera plus.
 *   /vdebug verifie leur existence.
 */
const AudioActions = findByPropsLazy("toggleLocalMute", "setLocalVolume");

// ============================================================
// ETAT INTERNE
// ============================================================

/*
 * mutedUsers : tracking des joueurs actuellement mutes.
 *   Cle   : userId Discord (snowflake string)
 *   Valeur : displayName au moment du mute (pour affichage dans /muted)
 *
 *   Cet etat est en memoire volatile. Il est perdu quand :
 *   - Discord redemarre (Ctrl+R ou restart)
 *   - Le plugin est desactive puis reactive
 *   C'est voulu : un restart = etat propre, pas de mutes orphelins.
 *
 *   IMPORTANT : cette Map est la source de verite pour savoir qui
 *   est mute. /unmute itere dessus + les users du vocal actuel
 *   pour etre sur de tout demuter.
 */
const mutedUsers = new Map<string, string>();

// ============================================================
// SETTINGS (configurables depuis l'UI Vencord)
// ============================================================

/*
 * Tous les parametres sont des STRING car Vencord ne propose pas
 * de type "channel picker" ou "role picker" dans definePluginSettings.
 *
 * Pour modifier ces valeurs :
 *   Parametres Discord > Vencord > Plugins > GuildVoiceManager
 *
 * IMPORTANT : les noms de roles doivent correspondre EXACTEMENT
 * (insensible a la casse) aux noms dans Discord.
 * Ex: si le role Discord s'appelle "L.ATK", le setting doit etre "L.ATK".
 */
const settings = definePluginSettings({
    /* ID du salon vocal GvG. Toutes les commandes (sauf /unmute)
     * verront leur execution bloquee si le joueur n'est pas dans ce salon.
     * Recuperer l'ID : clic droit sur le vocal > Copier l'identifiant du salon. */
    gvgChannelId: {
        type: OptionType.STRING,
        description: "ID du salon vocal GvG (obligatoire)",
        default: "1459968132234875142"
    },
    /* Roles de GROUPE (joueurs de base) */
    atkRole: {
        type: OptionType.STRING,
        description: "Nom du role ATK",
        default: "ATK"
    },
    defRole: {
        type: OptionType.STRING,
        description: "Nom du role DEF",
        default: "DEF"
    },
    romRole: {
        type: OptionType.STRING,
        description: "Nom du role ROM",
        default: "ROM"
    },
    /* Roles de LEADER (un par groupe, coordonnent les joueurs) */
    lAtkRole: {
        type: OptionType.STRING,
        description: "Nom du role Leader ATK",
        default: "L.ATK"
    },
    lDefRole: {
        type: OptionType.STRING,
        description: "Nom du role Leader DEF",
        default: "L.DEF"
    },
    lRomRole: {
        type: OptionType.STRING,
        description: "Nom du role Leader ROM",
        default: "L.ROM"
    },
    /* Role CHIEF (supervise tous les leaders, acces a /lead) */
    chiefRole: {
        type: OptionType.STRING,
        description: "Nom du role Chief Leader",
        default: "Chief.L"
    }
});

// ============================================================
// FONCTIONS UTILITAIRES
// ============================================================

/** Raccourci pour acceder aux settings. Evite de repeter settings.store partout. */
function s() { return settings.store; }

/**
 * Recupere le nom d'affichage d'un membre pour les messages du plugin.
 *
 * Ordre de priorite (comme Discord) :
 *   1. Surnom serveur (member.nick) — specifique au serveur
 *   2. Nom d'affichage global (user.globalName) — profil Discord
 *   3. Nom d'utilisateur (user.username) — identifiant unique
 *   4. userId brut — fallback si tout echoue
 *
 * Le try/catch protege contre les cas ou UserStore.getUser()
 * echoue (utilisateur cache ou API indisponible).
 */
function getDisplayName(guildId: string, userId: string): string {
    const member = GuildMemberStore.getMember(guildId, userId);
    if (member?.nick) return member.nick;
    try {
        const user = UserStore.getUser(userId);
        return user?.globalName || user?.username || userId;
    } catch { return userId; }
}

/**
 * Verifie si un membre possede un role Discord par son NOM.
 *
 * Fonctionnement :
 *   1. Recupere le membre via GuildMemberStore (contient .roles = array de roleIds)
 *   2. Pour chaque roleId, recupere l'objet role via GuildRoleStore
 *   3. Compare le nom du role (insensible a la casse, trim)
 *
 * POURQUOI par nom et pas par ID ?
 *   Les IDs de role changent entre serveurs. Les noms sont configurables
 *   dans les settings, plus intuitifs pour les admins.
 *   Le trade-off : si un admin renomme le role dans Discord, il faut
 *   aussi mettre a jour le setting dans le plugin.
 *
 * @param guildId - ID du serveur Discord
 * @param userId - ID de l'utilisateur a verifier
 * @param roleName - Nom du role a chercher (insensible a la casse)
 */
function memberHasRole(guildId: string, userId: string, roleName: string): boolean {
    const member = GuildMemberStore.getMember(guildId, userId);
    if (!member?.roles?.length) return false;
    const target = roleName.toLowerCase().trim();
    return member.roles.some((roleId: string) => {
        try {
            const role = GuildRoleStore.getRole(guildId, roleId);
            return role?.name?.toLowerCase().trim() === target;
        } catch { return false; }
    });
}

/**
 * Retourne la liste de TOUS les noms de roles GvG configures.
 * Utilise par /gvgcheck pour savoir quels roles sont pertinents.
 */
function getGvgRoles(): string[] {
    return [s().atkRole, s().defRole, s().romRole, s().lAtkRole, s().lDefRole, s().lRomRole, s().chiefRole];
}

/**
 * Determine le role GvG principal d'un utilisateur.
 *
 * L'ordre de priorite est important : on verifie Chief > Leader > Joueur.
 * Cela garantit qu'un Chief.L qui aurait aussi le role ATK sera detecte
 * comme Chief en premier.
 *
 * Retourne le NOM du role (string) ou null si aucun role GvG.
 */
function getMyGvgRole(guildId: string, userId: string): string | null {
    const checks: string[] = [
        s().chiefRole,
        s().lAtkRole, s().lDefRole, s().lRomRole,
        s().atkRole, s().defRole, s().romRole
    ];
    for (const r of checks) {
        if (memberHasRole(guildId, userId, r)) return r;
    }
    return null;
}

/**
 * Detecte le GROUPE (ATK/DEF/ROM) auquel appartient un utilisateur.
 *
 * Un leader (L.ATK) appartient au groupe ATK.
 * Un Chief.L n'appartient a aucun groupe (retourne null) car il
 * supervise tous les groupes et utilise /lead au lieu de /brief.
 *
 * IMPORTANT : cette fonction est utilisee par /brief et /go pour
 * determiner automatiquement quels roles muter. Si un joueur a
 * PLUSIEURS roles de groupe (ex: ATK + DEF), seul le premier
 * match est retourne (ATK dans cet exemple). Ce cas ne devrait
 * pas se produire en pratique.
 */
function getMyGroup(guildId: string, userId: string): "ATK" | "DEF" | "ROM" | null {
    if (memberHasRole(guildId, userId, s().atkRole) || memberHasRole(guildId, userId, s().lAtkRole)) return "ATK";
    if (memberHasRole(guildId, userId, s().defRole) || memberHasRole(guildId, userId, s().lDefRole)) return "DEF";
    if (memberHasRole(guildId, userId, s().romRole) || memberHasRole(guildId, userId, s().lRomRole)) return "ROM";
    /* Chief.L sans role de groupe → null (il utilise /lead, pas /brief) */
    if (memberHasRole(guildId, userId, s().chiefRole)) return null;
    return null;
}

/**
 * Informations sur le salon vocal actuel du joueur.
 *   guildId  : ID du serveur (pour acceder aux roles/membres)
 *   channelId : ID du salon vocal (pour verifier si c'est le bon)
 *   userIds  : liste de tous les userId presents dans ce vocal
 */
interface VoiceInfo {
    guildId: string;
    channelId: string;
    userIds: string[];
}

/**
 * Recupere les informations du salon vocal actuel de l'utilisateur.
 *
 * Pipeline :
 *   1. SelectedChannelStore.getVoiceChannelId() → ID du vocal rejoint
 *   2. ChannelStore.getChannel() → objet channel avec guild_id
 *   3. VoiceStateStore.getVoiceStatesForChannel() → tous les users presents
 *   4. Object.keys(states) → extraction des userIds
 *
 * Retourne null si le joueur n'est dans aucun vocal, si le channel
 * n'est pas un vocal de serveur (ex: DM), ou si le VoiceStateStore
 * echoue (module introuvable apres mise a jour Discord).
 */
function getVoiceInfo(): VoiceInfo | null {
    const channelId = SelectedChannelStore.getVoiceChannelId();
    if (!channelId) return null;
    const channel = ChannelStore.getChannel(channelId);
    if (!channel?.guild_id) return null;
    let states: Record<string, any> | null = null;
    try { states = VoiceStateStore.getVoiceStatesForChannel(channelId); } catch {}
    if (!states) return null;
    return { guildId: channel.guild_id, channelId, userIds: Object.keys(states) };
}

/**
 * GARDE DE SALON : verifie que le joueur est dans le vocal GvG configure.
 *
 * Retourne :
 *   - null : tout est OK, le joueur est dans le bon salon
 *   - string : message d'erreur a afficher (pas en vocal, ou mauvais salon)
 *
 * Si le joueur est dans un autre vocal, le message inclut le NOM du salon
 * GvG (recupere via ChannelStore) pour l'aider a trouver le bon.
 *
 * EXCEPTION : /unmute n'appelle PAS cette fonction car il doit
 * fonctionner depuis n'importe quel vocal.
 */
function checkGvgChannel(): string | null {
    const info = getVoiceInfo();
    if (!info) return "Tu dois etre connecte a un canal vocal.";
    if (info.channelId !== s().gvgChannelId) {
        const gvgChannel = ChannelStore.getChannel(s().gvgChannelId);
        const name = gvgChannel?.name || s().gvgChannelId;
        return `Cette commande ne fonctionne que dans le vocal GvG : **${name}**\nRejoins-le avant de lancer cette commande.`;
    }
    return null;
}

/**
 * Mute un utilisateur localement et l'enregistre dans le tracking.
 *
 * setLocalVolume(userId, 0) met le volume a 0% = silence complet.
 * L'utilisateur ne sait pas qu'il est mute (c'est purement local).
 *
 * @returns true si le mute a reussi, false si AudioActions a plante
 */
function muteUser(uid: string, name: string): boolean {
    try {
        AudioActions.setLocalVolume(uid, 0);
        mutedUsers.set(uid, name);
        return true;
    } catch { return false; }
}

/**
 * Unmute un utilisateur et le retire du tracking.
 *
 * setLocalVolume(userId, 100) remet le volume a 100% = normal.
 * Si l'utilisateur avait un volume custom avant le mute, il sera
 * remis a 100% (on ne sauvegarde pas le volume original).
 * C'est acceptable pour un contexte d'event temporaire.
 *
 * @returns true si l'unmute a reussi
 */
function unmuteUser(uid: string): boolean {
    try {
        AudioActions.setLocalVolume(uid, 100);
        mutedUsers.delete(uid);
        return true;
    } catch { return false; }
}

/**
 * Cherche le pseudo du premier utilisateur en vocal ayant un role donne.
 *
 * Utilise par /go pour afficher le nom du leader dans le message de
 * lancement ("accepter l'invitation de **NomDuLeader** (L.ATK)").
 *
 * Retourne null si personne en vocal n'a ce role (leader absent).
 */
function findLeaderName(info: VoiceInfo, roleName: string): string | null {
    for (const uid of info.userIds) {
        if (memberHasRole(info.guildId, uid, roleName)) {
            return getDisplayName(info.guildId, uid);
        }
    }
    return null;
}

// ============================================================
// COMMANDES — LOGIQUE METIER
// ============================================================

/**
 * /brief — Phase de briefing avant la GvG.
 *
 * COMPORTEMENT :
 *   1. Detecte automatiquement le groupe du joueur (ATK/DEF/ROM)
 *   2. RESET tous les mutes precedents (clean slate)
 *   3. Mute les joueurs des 2 AUTRES groupes
 *   4. Ne mute PAS les leaders ni le Chief.L (seulement les roles de base)
 *
 * MATRICE DE MUTE (par groupe du joueur) :
 *   ATK → mute DEF + ROM
 *   DEF → mute ATK + ROM
 *   ROM → mute ATK + DEF
 *
 * NOTE : /brief ne mute que les roles de base (ATK/DEF/ROM), pas les
 * leaders. C'est /go qui se charge de muter les leaders adverses
 * de maniere additive par-dessus /brief.
 *
 * ERREUR : si le joueur n'a aucun role de groupe (ou est Chief.L sans
 * role de groupe), un message d'erreur est affiche.
 */
function cmdBrief(): string {
    const err = checkGvgChannel();
    if (err) return err;
    const info = getVoiceInfo()!;
    const me = UserStore.getCurrentUser()?.id;
    if (!me) return "Impossible de recuperer ton profil.";

    const group = getMyGroup(info.guildId, me);
    if (!group) return "Tu n'as aucun role de groupe (ATK/DEF/ROM). Verifie tes roles Discord.";

    /* Determine les roles a muter selon le groupe du joueur */
    let rolesToMute: string[] = [];
    if (group === "ATK") rolesToMute = [s().defRole, s().romRole];
    else if (group === "DEF") rolesToMute = [s().atkRole, s().romRole];
    else if (group === "ROM") rolesToMute = [s().atkRole, s().defRole];

    /* Reset complet avant d'appliquer les nouveaux mutes.
     * Cela evite l'accumulation de mutes si /brief est relance. */
    for (const [uid] of mutedUsers) { unmuteUser(uid); }

    const mutedNames: string[] = [];
    const keptNames: string[] = [];
    let errors = 0;

    for (const uid of info.userIds) {
        if (uid === me) continue; /* ne jamais se muter soi-meme */
        const name = getDisplayName(info.guildId, uid);
        const shouldMute = rolesToMute.some(r => memberHasRole(info.guildId, uid, r));
        if (shouldMute) {
            if (muteUser(uid, name)) mutedNames.push(name);
            else errors++;
        } else {
            keptNames.push(name);
        }
    }

    /* Message de retour avec recap des mutes/gardes */
    let msg = `**BRIEFING ${group}**\n`;
    msg += `**${mutedNames.length}** mute(s), **${keptNames.length}** garde(s)\n`;
    if (mutedNames.length > 0) msg += `\n**Mutes :**\n${mutedNames.map(n => `> ${n}`).join("\n")}`;
    if (keptNames.length > 0) msg += `\n\n**Gardes :**\n${keptNames.map(n => `> ${n}`).join("\n")}`;
    if (errors > 0) msg += `\n\n${errors} erreur(s)`;
    return msg;
}

/**
 * /go — Lancement de la GvG.
 *
 * COMPORTEMENT ADDITIF :
 *   /go ne reset PAS les mutes existants. Il AJOUTE le mute des
 *   leaders adverses par-dessus les mutes de /brief.
 *   Ainsi l'enchainement /brief puis /go donne le resultat final :
 *     - Joueurs adverses : mutes (par /brief)
 *     - Leaders adverses : mutes (par /go)
 *     - Mon groupe + mon leader : gardes
 *
 * MATRICE DE MUTE LEADERS (par groupe du joueur) :
 *   ATK → mute L.DEF + L.ROM (garde L.ATK)
 *   DEF → mute L.ATK + L.ROM (garde L.DEF)
 *   ROM → mute L.DEF + L.ATK (garde L.ROM)
 *
 * MESSAGE DYNAMIQUE :
 *   Affiche un message personnalise avec :
 *   - Le role du joueur (ATK/DEF/ROM)
 *   - Le pseudo du leader de son groupe (recupere via findLeaderName)
 *   - Les instructions de debut de GvG (buff, positionnement)
 */
function cmdGo(): string {
    const err = checkGvgChannel();
    if (err) return err;
    const info = getVoiceInfo()!;
    const me = UserStore.getCurrentUser()?.id;
    if (!me) return "Impossible de recuperer ton profil.";

    const group = getMyGroup(info.guildId, me);
    if (!group) return "Tu n'as aucun role de groupe (ATK/DEF/ROM). Verifie tes roles Discord.";

    /* Roles de leader des groupes ADVERSES a muter */
    let leaderRolesToMute: string[] = [];
    if (group === "ATK") leaderRolesToMute = [s().lDefRole, s().lRomRole];
    else if (group === "DEF") leaderRolesToMute = [s().lAtkRole, s().lRomRole];
    else if (group === "ROM") leaderRolesToMute = [s().lDefRole, s().lAtkRole];

    const newMuted: string[] = [];
    let errors = 0;

    for (const uid of info.userIds) {
        if (uid === me) continue;
        /* Skip les users deja mutes par /brief — additif seulement */
        if (mutedUsers.has(uid)) continue;
        const shouldMute = leaderRolesToMute.some(r => memberHasRole(info.guildId, uid, r));
        if (shouldMute) {
            const name = getDisplayName(info.guildId, uid);
            if (muteUser(uid, name)) newMuted.push(name);
            else errors++;
        }
    }

    /* Determination du leader de MON groupe pour le message */
    let leaderRole: string;
    let leaderName: string;
    let roleLabel: string;

    if (group === "ATK") {
        leaderRole = s().lAtkRole;
        roleLabel = "ATK (attaquant)";
    } else if (group === "DEF") {
        leaderRole = s().lDefRole;
        roleLabel = "DEF (defenseur)";
    } else {
        leaderRole = s().lRomRole;
        roleLabel = "ROM (roamer)";
    }

    /* Cherche le pseudo du leader en vocal. Si absent, affiche un placeholder. */
    leaderName = findLeaderName(info, leaderRole) || "[leader absent]";

    /* Message de lancement GvG avec instructions */
    let msg = `**GvG LANCEE !**\n\n`;
    msg += `Vous etes **${roleLabel}**.\n`;
    msg += `La GvG demarre, veuillez entrer au plus vite et accepter l'invitation de **${leaderName}** (${leaderRole}).\n`;
    msg += `Prenez vos buff *nourriture et parcho* et placez-vous a cote de votre groupe sur la ligne de depart.\n`;

    if (newMuted.length > 0) {
        msg += `\n**Leaders adverses mutes :**\n${newMuted.map(n => `> ${n}`).join("\n")}`;
    }

    msg += `\n\n**Total mutes : ${mutedUsers.size}**`;
    if (errors > 0) msg += `\n${errors} erreur(s)`;
    return msg;
}

/**
 * /lead — Mode coordination des leaders (reserve au Chief.L).
 *
 * COMPORTEMENT :
 *   1. Verifie que le joueur a le role Chief.L (sinon erreur)
 *   2. RESET tous les mutes precedents
 *   3. Mute TOUS les joueurs de base (ATK, DEF, ROM)
 *   4. GARDE tous les leaders (L.ATK, L.DEF, L.ROM) et le Chief.L
 *
 * LOGIQUE :
 *   On itere sur chaque user en vocal :
 *   - Si l'user a un role de LEADER → garde (non mute)
 *   - Si l'user a un role de GROUPE (ATK/DEF/ROM) mais PAS leader → mute
 *   - Si l'user n'a aucun role GvG → garde (probablement un modo/spectateur)
 *
 * CAS D'USAGE :
 *   Le Chief.L veut parler uniquement avec les leaders pour coordonner
 *   la strategie sans que les 30 joueurs n'interferent.
 */
function cmdLead(): string {
    const err = checkGvgChannel();
    if (err) return err;
    const info = getVoiceInfo()!;
    const me = UserStore.getCurrentUser()?.id;
    if (!me) return "Impossible de recuperer ton profil.";

    /* Garde : seul le Chief.L peut utiliser /lead */
    if (!memberHasRole(info.guildId, me, s().chiefRole)) {
        return `Cette commande est reservee au **${s().chiefRole}**.`;
    }

    /* Reset complet avant d'appliquer le mode lead */
    for (const [uid] of mutedUsers) { unmuteUser(uid); }

    const groupRoles = [s().atkRole, s().defRole, s().romRole];
    const leaderRoles = [s().lAtkRole, s().lDefRole, s().lRomRole, s().chiefRole];

    const mutedNames: string[] = [];
    const keptNames: string[] = [];
    let errors = 0;

    for (const uid of info.userIds) {
        if (uid === me) continue;
        const name = getDisplayName(info.guildId, uid);

        /* Priorite au role de leader : si c'est un leader, on le garde */
        const isLeader = leaderRoles.some(r => memberHasRole(info.guildId, uid, r));
        if (isLeader) {
            keptNames.push(name);
            continue;
        }

        /* Sinon, si c'est un joueur de groupe → mute */
        const isGroup = groupRoles.some(r => memberHasRole(info.guildId, uid, r));
        if (isGroup) {
            if (muteUser(uid, name)) mutedNames.push(name);
            else errors++;
        } else {
            /* Pas de role GvG (spectateur, modo, etc.) → garde */
            keptNames.push(name);
        }
    }

    let msg = `**MODE LEAD -- ${s().chiefRole}**\n`;
    msg += `**${mutedNames.length}** joueur(s) mute(s), **${keptNames.length}** leader(s) garde(s)\n`;
    if (keptNames.length > 0) msg += `\n**Leaders gardes :**\n${keptNames.map(n => `> ${n}`).join("\n")}`;
    if (mutedNames.length > 0) msg += `\n\n**Joueurs mutes :**\n${mutedNames.map(n => `> ${n}`).join("\n")}`;
    if (errors > 0) msg += `\n\n${errors} erreur(s)`;
    return msg;
}

/**
 * /unmute — Remet tout le monde a volume normal.
 *
 * EXCEPTION DE SALON : c'est la seule commande qui fonctionne
 * depuis N'IMPORTE QUEL vocal (pas seulement le salon GvG).
 * Raison : apres la GvG, les joueurs peuvent changer de salon
 * pour le debriefing et ont besoin de demuter.
 *
 * DOUBLE NETTOYAGE :
 *   1. Unmute tous les users presents dans le vocal actuel
 *   2. Unmute les users trackes dans mutedUsers qui ont quitte le vocal
 *      (ils ne sont plus dans info.userIds mais restent dans notre Map)
 *   3. Vide completement la Map mutedUsers
 */
function cmdUnmute(): string {
    /* PAS de checkGvgChannel() ici — /unmute fonctionne partout */
    const info = getVoiceInfo();
    if (!info) return "Tu dois etre connecte a un canal vocal.";

    const me = UserStore.getCurrentUser()?.id;
    let count = 0;
    let errors = 0;

    /* Phase 1 : unmute tous les users presents dans le vocal */
    for (const uid of info.userIds) {
        if (uid === me) continue;
        if (unmuteUser(uid)) count++;
        else {
            /* Fallback : si unmuteUser echoue (user pas dans la Map),
             * essaye quand meme de remettre le volume */
            try { AudioActions.setLocalVolume(uid, 100); count++; } catch { errors++; }
        }
    }

    /* Phase 2 : cleanup des users qui ont quitte le vocal
     * (ils sont dans mutedUsers mais plus dans info.userIds) */
    for (const [uid] of mutedUsers) {
        if (!info.userIds.includes(uid)) {
            try { AudioActions.setLocalVolume(uid, 100); } catch {}
        }
    }
    mutedUsers.clear();

    let msg = `**${count}** unmute(s) -- bon debriefing !`;
    if (errors > 0) msg += `\n${errors} erreur(s)`;
    return msg;
}

/**
 * /muted — Affiche la liste des joueurs actuellement mutes.
 *
 * Lit simplement la Map mutedUsers et formate les noms.
 * Utile pour verifier l'etat des mutes sans tout demuter.
 */
function cmdMuted(): string {
    const err = checkGvgChannel();
    if (err) return err;

    if (mutedUsers.size === 0) return "Personne n'est mute actuellement.";

    const lines = [`**${mutedUsers.size} joueur(s) mute(s) :**`, ""];
    for (const [uid, name] of mutedUsers) {
        lines.push(`> **${name}** (${uid})`);
    }
    return lines.join("\n");
}

/**
 * /gvgcheck — Appel des troupes avant la GvG.
 *
 * Affiche tous les joueurs en vocal, regroupes par role GvG.
 * Ne prend en compte QUE les 7 roles GvG (ATK, DEF, ROM,
 * L.ATK, L.DEF, L.ROM, Chief.L) — les autres roles Discord
 * sont ignores.
 *
 * FORMAT DE SORTIE :
 *   === APPEL GvG ===
 *   X joueur(s) en vocal
 *
 *   Chief Leader [Chief.L] -- 1
 *     > NomDuChief
 *
 *   Leader ATK [L.ATK] -- 1
 *     > NomDuLeaderATK
 *   ...
 *   Attaquants [ATK] -- 8
 *     > Joueur1
 *     > Joueur2
 *   ...
 *   ---
 *   Total GvG : 28 joueur(s) avec role
 *   ATK: 9 | DEF: 10 | ROM: 9 | Chief: 1
 *
 *   Sans role GvG : 2
 *     > Spectateur1
 *
 * NOTE : un joueur avec PLUSIEURS roles GvG apparaitra dans
 * chaque categorie correspondante (ex: un L.ATK qui a aussi ATK
 * apparaitra dans les deux). Le total peut donc depasser le nombre
 * reel de joueurs. C'est voulu pour identifier les doubles-roles.
 */
function cmdGvgCheck(): string {
    const err = checkGvgChannel();
    if (err) return err;
    const info = getVoiceInfo()!;
    const me = UserStore.getCurrentUser()?.id;

    /* Initialise un tableau vide pour chaque role GvG */
    const groups: Record<string, string[]> = {};
    const roleOrder = [
        s().chiefRole,
        s().lAtkRole, s().lDefRole, s().lRomRole,
        s().atkRole, s().defRole, s().romRole
    ];
    for (const r of roleOrder) groups[r] = [];

    /* Joueurs sans aucun role GvG (spectateurs, modos, etc.) */
    const noGvgRole: string[] = [];

    for (const uid of info.userIds) {
        const name = getDisplayName(info.guildId, uid);
        const suffix = uid === me ? " (toi)" : "";
        let hasGvgRole = false;

        /* Un joueur peut apparaitre dans plusieurs groupes
         * s'il a plusieurs roles GvG (ex: L.ATK + ATK) */
        for (const r of roleOrder) {
            if (memberHasRole(info.guildId, uid, r)) {
                groups[r].push(name + suffix);
                hasGvgRole = true;
            }
        }

        if (!hasGvgRole) noGvgRole.push(name + suffix);
    }

    const lines: string[] = [
        `**=== APPEL GvG ===**`,
        `**${info.userIds.length}** joueur(s) en vocal`,
        ``
    ];

    /* Labels lisibles pour chaque role */
    const labels: Record<string, string> = {
        [s().chiefRole]: "Chief Leader",
        [s().lAtkRole]: "Leader ATK",
        [s().lDefRole]: "Leader DEF",
        [s().lRomRole]: "Leader ROM",
        [s().atkRole]: "Attaquants",
        [s().defRole]: "Defenseurs",
        [s().romRole]: "Roamers"
    };

    for (const r of roleOrder) {
        const members = groups[r];
        const label = labels[r] || r;
        lines.push(`**${label}** [${r}] -- ${members.length}`);
        if (members.length > 0) {
            for (const n of members) lines.push(`  > ${n}`);
        } else {
            lines.push(`  > (aucun)`);
        }
        lines.push(``);
    }

    /* Resume avec totaux par grande famille (leader + joueurs) */
    const totalGvg = roleOrder.reduce((sum, r) => sum + groups[r].length, 0);
    lines.push(`---`);
    lines.push(`**Total GvG : ${totalGvg}** joueur(s) avec role`);

    const atkTotal = groups[s().atkRole].length + groups[s().lAtkRole].length;
    const defTotal = groups[s().defRole].length + groups[s().lDefRole].length;
    const romTotal = groups[s().romRole].length + groups[s().lRomRole].length;
    const chiefTotal = groups[s().chiefRole].length;

    lines.push(`ATK: ${atkTotal} | DEF: ${defTotal} | ROM: ${romTotal} | Chief: ${chiefTotal}`);

    if (noGvgRole.length > 0) {
        lines.push(``);
        lines.push(`**Sans role GvG : ${noGvgRole.length}**`);
        for (const n of noGvgRole) lines.push(`  > ${n}`);
    }

    return lines.join("\n");
}

/**
 * /vdebug — Diagnostic complet du plugin.
 *
 * Verifie et affiche :
 *   1. CANAL : le vocal actuel vs le canal GvG configure
 *   2. AUDIO API : existence de setLocalVolume et toggleLocalMute
 *      → Si absents, Discord a probablement modifie son API audio.
 *      → Message CRITIQUE indiquant de contacter NIXshade.
 *   3. STORES : existence des methodes sur VoiceStateStore,
 *      GuildRoleStore, GuildMemberStore
 *   4. ROLES : affiche les 7 noms de roles configures
 *   5. MUTES : nombre de joueurs trackes dans mutedUsers
 *   6. LISTE DES USERS : pour chaque user en vocal, affiche :
 *      - Son pseudo
 *      - Si c'est toi (<< toi)
 *      - Si il est mute ([MUTE])
 *      - Ses roles GvG detectes
 *
 * Cette commande est essentielle apres une mise a jour Discord
 * pour verifier que rien n'est casse. Si un store ou une methode
 * est ABSENT, le plugin ne fonctionnera pas correctement.
 */
function cmdDebug(): string {
    const info = getVoiceInfo();
    if (!info) return "Pas en vocal.";
    const me = UserStore.getCurrentUser()?.id;

    const gvgChannel = ChannelStore.getChannel(s().gvgChannelId);
    const inGvg = info.channelId === s().gvgChannelId;

    const lines: string[] = [
        `**Debug GuildVoiceManager v2**`,
        ``,
        `**Canal actuel :** ${info.channelId} ${inGvg ? "(GvG OK)" : "(PAS le canal GvG)"}`,
        `**Canal GvG configure :** ${s().gvgChannelId} (${gvgChannel?.name || "introuvable"})`,
        `**Guild :** ${info.guildId}`,
        `**Membres en vocal :** ${info.userIds.length}`,
        ``
    ];

    /* ---- Verification des modules audio ---- */
    try {
        const hasToggle = typeof AudioActions?.toggleLocalMute === "function";
        const hasVolume = typeof AudioActions?.setLocalVolume === "function";
        lines.push(`**AudioActions :**`);
        lines.push(`  toggleLocalMute: ${hasToggle ? "OK" : "ABSENT"}`);
        lines.push(`  setLocalVolume: ${hasVolume ? "OK" : "ABSENT"}`);
        if (!hasToggle && !hasVolume) {
            lines.push(`  >> CRITIQUE : Discord a peut-etre modifie son API audio.`);
            lines.push(`  >> Contacte NIXshade pour une mise a jour du plugin.`);
        }
    } catch { lines.push(`AudioActions: ERREUR proxy -- mise a jour necessaire`); }

    /* ---- Verification des stores ---- */
    try {
        const hasVS = typeof VoiceStateStore?.getVoiceStatesForChannel === "function";
        lines.push(`  VoiceStateStore: ${hasVS ? "OK" : "ABSENT"}`);
    } catch { lines.push(`  VoiceStateStore: ERREUR`); }

    lines.push(`  GuildRoleStore: ${typeof GuildRoleStore?.getRole === "function" ? "OK" : "ABSENT"}`);
    lines.push(`  GuildMemberStore: ${typeof GuildMemberStore?.getMember === "function" ? "OK" : "ABSENT"}`);
    lines.push(``);

    /* ---- Roles configures ---- */
    lines.push(`**Roles configures :**`);
    const allRoles = [
        ["ATK", s().atkRole], ["DEF", s().defRole], ["ROM", s().romRole],
        ["L.ATK", s().lAtkRole], ["L.DEF", s().lDefRole], ["L.ROM", s().lRomRole],
        ["Chief", s().chiefRole]
    ];
    for (const [label, role] of allRoles) lines.push(`  ${label}: "${role}"`);
    lines.push(``);

    /* ---- Etat des mutes ---- */
    lines.push(`**Mutes en cours :** ${mutedUsers.size}`);
    lines.push(``);

    /* ---- Liste detaillee des users en vocal ---- */
    for (const uid of info.userIds) {
        const name = getDisplayName(info.guildId, uid);
        const isMe = uid === me ? " << toi" : "";
        const isMuted = mutedUsers.has(uid) ? " [MUTE]" : "";
        const gvgRoles: string[] = [];
        for (const [label, role] of allRoles) {
            if (memberHasRole(info.guildId, uid, role as string)) gvgRoles.push(label);
        }
        const tags = gvgRoles.length > 0 ? gvgRoles.join("/") : "aucun role GvG";
        lines.push(`- **${name}**${isMe}${isMuted} [${tags}]`);
    }

    return lines.join("\n");
}

// ============================================================
// DEFINITION DU PLUGIN (point d'entree Vencord)
// ============================================================

/*
 * definePlugin() est la fonction obligatoire de tout plugin Vencord.
 * Elle enregistre le plugin dans le systeme et expose :
 *   - name : identifiant unique (affiche dans l'UI Vencord)
 *   - description : texte explicatif
 *   - authors : credits (id: 0n = pas d'ID Discord specifique)
 *   - settings : objet de parametres (affiche dans l'UI)
 *   - commands : liste des commandes slash
 *
 * Chaque commande utilise :
 *   - inputType: BUILT_IN → commande locale, pas envoyee au serveur
 *   - execute: callback recevant (args, context)
 *   - sendBotMessage() → affiche un message ephemere local
 */
export default definePlugin({
    name: "GuildVoiceManager",
    description: "Gestion vocale GvG : mute/unmute par role (ATK/DEF/ROM/Leaders/Chief)",
    authors: [{ name: "Anthony aka NIXshade", id: 0n }],
    settings,

    commands: [
        {
            name: "brief",
            description: "Briefing : mute les autres groupes selon ton role",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                sendBotMessage(ctx.channel.id, { content: cmdBrief() });
            }
        },
        {
            name: "go",
            description: "Lancer la GvG : mute les leaders adverses + message de lancement",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                sendBotMessage(ctx.channel.id, { content: cmdGo() });
            }
        },
        {
            name: "lead",
            description: "Mode Lead (Chief.L) : mute tout sauf les Leaders",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                sendBotMessage(ctx.channel.id, { content: cmdLead() });
            }
        },
        {
            name: "unmute",
            description: "Unmute tout le monde",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                sendBotMessage(ctx.channel.id, { content: cmdUnmute() });
            }
        },
        {
            name: "muted",
            description: "Liste des joueurs mutes",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                sendBotMessage(ctx.channel.id, { content: cmdMuted() });
            }
        },
        {
            name: "gvgcheck",
            description: "Appel GvG : liste des membres par role",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                sendBotMessage(ctx.channel.id, { content: cmdGvgCheck() });
            }
        },
        {
            name: "vdebug",
            description: "Maintenance : verifie les stores et l'etat du plugin",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                sendBotMessage(ctx.channel.id, { content: cmdDebug() });
            }
        }
    ]
});
