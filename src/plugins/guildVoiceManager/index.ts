/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Anthony aka NIXshade and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * ============================================================
 * GuildVoiceManager v3 — Plugin de gestion vocale GvG
 * ============================================================
 *
 * OBJECTIF :
 *   Permettre a chaque joueur d'un event GvG (Guerre de Guilde)
 *   de muter localement les groupes adverses pour n'entendre que
 *   son propre groupe. Mute LOCAL uniquement.
 *
 * ARCHITECTURE DES ROLES (7 roles Discord) :
 *   Groupes : ATK, DEF, ROM
 *   Leaders : L.ATK, L.DEF, L.ROM
 *   Chef    : Chief.L
 *
 * COMMANDES :
 *   /gvg      - Commande principale (auto-transfert + mute par role + message)
 *   /gvgcheck - Appel des troupes (comptage par role, objectif 30)
 *   /unmute   - Demute tout le monde (restaure volumes originaux)
 *   /muted    - Liste des mutes avec volume original
 *   /vdebug   - Diagnostic complet
 *   /gvghelp  - Aide des commandes
 *
 * FLUX : /gvgcheck → /gvg → (GvG) → /unmute
 *
 * VOLUME MEMORY :
 *   Avant chaque mute, le volume original de l'utilisateur est
 *   sauvegarde via MediaEngineStore.getLocalVolume(). Au /unmute,
 *   le volume est restaure a sa valeur d'origine (pas force a 100).
 *   La Map est videe a chaque /unmute ou deconnexion.
 */

import { definePluginSettings } from "@api/Settings";
import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { ChannelStore, GuildMemberStore, GuildRoleStore, SelectedChannelStore, UserStore } from "@webpack/common";

// ============================================================
// MODULES DISCORD INTERNES
// ============================================================

const VoiceStateStore = findStoreLazy("VoiceStateStore");
const AudioActions = findByPropsLazy("toggleLocalMute", "setLocalVolume");

/*
 * MediaEngineStore : permet de lire le volume local actuel d'un user.
 *   getLocalVolume(userId, "default") → nombre de 0 a 200
 *   Utilise pour sauvegarder le volume AVANT de muter.
 *   RISQUE : si Discord renomme ce store, on fallback a 100.
 */
const MediaEngineStore = findStoreLazy("MediaEngineStore");

/*
 * selectVoiceChannel : permet de deplacer le joueur vers un vocal.
 *   Utilise par /gvg pour auto-transfert vers le salon GvG.
 */
const VoiceChannelActions = findByPropsLazy("selectVoiceChannel");

// ============================================================
// ETAT INTERNE
// ============================================================

/*
 * mutedUsers : tracking des joueurs mutes.
 *   Cle   : userId
 *   Valeur : { name: displayName, volume: volume original avant mute }
 *   Volatile : perdu au restart Discord (voulu).
 *   Vide a chaque /unmute.
 */
const mutedUsers = new Map<string, { name: string; volume: number }>();

/*
 * IDs des leaders/admins a contacter en cas de probleme de role.
 * Affiche dans les messages d'erreur de /gvg.
 */
const ADMIN_IDS = [
    "690132931133702154",
    "444498213563531265",
    "999599789614321765",
    "962313292079063120"
];

// ============================================================
// SETTINGS
// ============================================================

const settings = definePluginSettings({
    gvgChannelId: {
        type: OptionType.STRING,
        description: "ID du salon vocal GvG",
        default: "1459968132234875142"
    },
    atkRole: { type: OptionType.STRING, description: "Nom du role ATK", default: "ATK" },
    defRole: { type: OptionType.STRING, description: "Nom du role DEF", default: "DEF" },
    romRole: { type: OptionType.STRING, description: "Nom du role ROM", default: "ROM" },
    lAtkRole: { type: OptionType.STRING, description: "Nom du role Leader ATK", default: "L.ATK" },
    lDefRole: { type: OptionType.STRING, description: "Nom du role Leader DEF", default: "L.DEF" },
    lRomRole: { type: OptionType.STRING, description: "Nom du role Leader ROM", default: "L.ROM" },
    chiefRole: { type: OptionType.STRING, description: "Nom du role Chief Leader", default: "Chief.L" },
    autoJoinGvg: { type: OptionType.BOOLEAN, description: "Rejoindre automatiquement le salon GvG avec /gvg", default: true }
});

// ============================================================
// FONCTIONS UTILITAIRES
// ============================================================

function s() { return settings.store; }

function getDisplayName(guildId: string, userId: string): string {
    const member = GuildMemberStore.getMember(guildId, userId);
    if (member?.nick) return member.nick;
    try {
        const user = UserStore.getUser(userId);
        return user?.globalName || user?.username || userId;
    } catch { return userId; }
}

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

interface VoiceInfo {
    guildId: string;
    channelId: string;
    userIds: string[];
}

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
 * Recupere le volume local actuel d'un user.
 * Tente MediaEngineStore.getLocalVolume, fallback a 100.
 */
function getLocalVolume(userId: string): number {
    try {
        const vol = MediaEngineStore?.getLocalVolume?.(userId, "default");
        if (typeof vol === "number" && vol >= 0) return vol;
    } catch {}
    try {
        const vol = MediaEngineStore?.getLocalVolume?.(userId);
        if (typeof vol === "number" && vol >= 0) return vol;
    } catch {}
    return 100;
}

/**
 * Mute un user : sauvegarde son volume original puis met a 0.
 */
function muteUser(uid: string, name: string): boolean {
    try {
        const volume = getLocalVolume(uid);
        AudioActions.setLocalVolume(uid, 0);
        mutedUsers.set(uid, { name, volume });
        return true;
    } catch { return false; }
}

/**
 * Unmute un user : restaure son volume original (pas 100 par defaut).
 */
function unmuteUser(uid: string): boolean {
    try {
        const data = mutedUsers.get(uid);
        const restoreVol = data?.volume ?? 100;
        AudioActions.setLocalVolume(uid, restoreVol);
        mutedUsers.delete(uid);
        return true;
    } catch { return false; }
}

function findLeaderName(info: VoiceInfo, roleName: string): string | null {
    for (const uid of info.userIds) {
        if (memberHasRole(info.guildId, uid, roleName)) {
            return getDisplayName(info.guildId, uid);
        }
    }
    return null;
}

/**
 * Detecte les roles de groupe (ATK/DEF/ROM) d'un utilisateur.
 * Retourne un tableau pour detecter les multi-roles.
 */
function getGroupRoles(guildId: string, userId: string): string[] {
    const found: string[] = [];
    if (memberHasRole(guildId, userId, s().atkRole)) found.push("ATK");
    if (memberHasRole(guildId, userId, s().defRole)) found.push("DEF");
    if (memberHasRole(guildId, userId, s().romRole)) found.push("ROM");
    return found;
}

/**
 * Detecte les roles de leader d'un utilisateur.
 */
function getLeaderRoles(guildId: string, userId: string): string[] {
    const found: string[] = [];
    if (memberHasRole(guildId, userId, s().lAtkRole)) found.push("L.ATK");
    if (memberHasRole(guildId, userId, s().lDefRole)) found.push("L.DEF");
    if (memberHasRole(guildId, userId, s().lRomRole)) found.push("L.ROM");
    return found;
}

function isChief(guildId: string, userId: string): boolean {
    return memberHasRole(guildId, userId, s().chiefRole);
}

/**
 * Auto-transfert vers le salon GvG si le joueur est dans un autre vocal.
 * Retourne une promesse qui resolve quand le transfert est effectif.
 */
async function ensureInGvgChannel(): Promise<{ info: VoiceInfo } | { error: string }> {
    let info = getVoiceInfo();

    /* Auto-transfert desactive → comportement classique */
    if (!s().autoJoinGvg) {
        if (!info) return { error: "Tu dois etre connecte a un canal vocal." };
        if (info.channelId !== s().gvgChannelId) {
            const gvgChannel = ChannelStore.getChannel(s().gvgChannelId);
            const name = gvgChannel?.name || s().gvgChannelId;
            return { error: `Cette commande ne fonctionne que dans le vocal GvG : **${name}**\nRejoins-le avant de lancer cette commande.` };
        }
        return { info };
    }

    /* Pas en vocal du tout → tenter de rejoindre le salon GvG */
    if (!info) {
        try {
            await VoiceChannelActions.selectVoiceChannel(s().gvgChannelId);
            /* Attendre un peu que Discord traite la connexion */
            await new Promise(r => setTimeout(r, 1500));
            info = getVoiceInfo();
        } catch {}
        if (!info) return { error: "Impossible de rejoindre le salon GvG. Connecte-toi manuellement au vocal." };
    }

    /* En vocal mais pas dans le bon salon → transfert auto */
    if (info.channelId !== s().gvgChannelId) {
        const gvgChannel = ChannelStore.getChannel(s().gvgChannelId);
        const name = gvgChannel?.name || s().gvgChannelId;
        try {
            await VoiceChannelActions.selectVoiceChannel(s().gvgChannelId);
            await new Promise(r => setTimeout(r, 1500));
            info = getVoiceInfo();
        } catch {}
        if (!info || info.channelId !== s().gvgChannelId) {
            return { error: `Impossible de te transferer vers **${name}**. Rejoins-le manuellement.` };
        }
    }

    return { info };
}

// ============================================================
// COMMANDE /gvg — Commande principale unifiee
// ============================================================

async function cmdGvg(): Promise<string> {
    const me = UserStore.getCurrentUser()?.id;
    if (!me) return "Impossible de recuperer ton profil.";

    /* ---- Auto-transfert vers le salon GvG ---- */
    const result = await ensureInGvgChannel();
    if ("error" in result) return result.error;
    const info = result.info;

    const guildId = info.guildId;
    const isChiefUser = isChief(guildId, me);
    const leaderRoles = getLeaderRoles(guildId, me);
    const groupRoles = getGroupRoles(guildId, me);

    /* ---- Detection multi-roles de groupe (ATK+DEF, DEF+ROM, etc.) ---- */
    if (groupRoles.length > 1) {
        const admins = ADMIN_IDS.map(id => `<@${id}>`).join(", ");
        return [
            "**ERREUR : Roles multiples detectes**",
            "",
            `Tu possedes les roles **${groupRoles.join(" + ")}** en meme temps.`,
            `Tu ne dois avoir qu'UN SEUL role de groupe pour la GvG.`,
            "",
            `Contacte rapidement ${admins} pour qu'on t'assigne uniquement ton role pour la GvG d'aujourd'hui.`,
            "",
            `Relance \`/gvg\` une fois corrige.`
        ].join("\n");
    }

    /* ---- Determiner le profil du joueur ---- */
    let myGroup: "ATK" | "DEF" | "ROM" | null = null;
    if (groupRoles.length === 1) myGroup = groupRoles[0] as "ATK" | "DEF" | "ROM";

    /* Un leader sans role de groupe → deduire le groupe du role leader */
    if (!myGroup && leaderRoles.length > 0) {
        if (leaderRoles.includes("L.ATK")) myGroup = "ATK";
        else if (leaderRoles.includes("L.DEF")) myGroup = "DEF";
        else if (leaderRoles.includes("L.ROM")) myGroup = "ROM";
    }

    /* Chief.L : doit avoir un 2e role de groupe pour determiner "son" groupe */
    if (isChiefUser && !myGroup) {
        /* Chief.L seul sans aucun role de groupe → acceptable, mode Chief pur */
    }

    const isLeader = leaderRoles.length > 0;

    /* ---- Validation des combinaisons de roles ---- */
    if (!isChiefUser && !isLeader && !myGroup) {
        return [
            "**ERREUR : Aucun role GvG detecte**",
            "",
            "Tu ne possedes aucun des roles requis pour la GvG.",
            `Roles attendus : **${s().atkRole}**, **${s().defRole}**, **${s().romRole}**, **${s().lAtkRole}**, **${s().lDefRole}**, **${s().lRomRole}**, **${s().chiefRole}**`,
            "",
            `Contacte un leader pour qu'on t'assigne ton role. ${ADMIN_IDS.map(id => `<@${id}>`).join(", ")}`,
        ].join("\n");
    }

    /* ---- Reset des mutes precedents ---- */
    for (const [uid] of mutedUsers) { unmuteUser(uid); }

    /* ---- Determiner les roles a GARDER (non mutes) ---- */
    let keepRoles: string[] = [];

    if (isChiefUser) {
        /* Chief.L : garde tous les leaders + son groupe (s'il en a un) */
        keepRoles = [s().lAtkRole, s().lDefRole, s().lRomRole, s().chiefRole];
        if (myGroup === "ATK") keepRoles.push(s().atkRole);
        else if (myGroup === "DEF") keepRoles.push(s().defRole);
        else if (myGroup === "ROM") keepRoles.push(s().romRole);
    } else if (isLeader) {
        /* Leader (L.ATK/L.DEF/L.ROM) : garde son groupe + autres leaders du meme groupe + Chief.L */
        keepRoles = [s().chiefRole];
        if (myGroup === "ATK") keepRoles.push(s().atkRole, s().lAtkRole);
        else if (myGroup === "DEF") keepRoles.push(s().defRole, s().lDefRole);
        else if (myGroup === "ROM") keepRoles.push(s().romRole, s().lRomRole);
    } else {
        /* Joueur de base (ATK/DEF/ROM) : garde son groupe + son leader + Chief.L */
        keepRoles = [s().chiefRole];
        if (myGroup === "ATK") { keepRoles.push(s().atkRole, s().lAtkRole); }
        else if (myGroup === "DEF") { keepRoles.push(s().defRole, s().lDefRole); }
        else if (myGroup === "ROM") { keepRoles.push(s().romRole, s().lRomRole); }
    }

    /* ---- Appliquer les mutes ---- */
    const mutedNames: string[] = [];
    const keptNames: string[] = [];
    let errors = 0;

    for (const uid of info.userIds) {
        if (uid === me) continue;
        const name = getDisplayName(guildId, uid);

        /* Un user est garde s'il possede AU MOINS UN role dans keepRoles */
        const shouldKeep = keepRoles.some(r => memberHasRole(guildId, uid, r));
        if (shouldKeep) {
            keptNames.push(name);
        } else {
            if (muteUser(uid, name)) mutedNames.push(name);
            else errors++;
        }
    }

    /* ---- Message post-mute ---- */
    if (isChiefUser) {
        return buildChiefMessage(info, mutedNames, keptNames, errors);
    } else {
        return buildPlayerMessage(info, myGroup!, isLeader, leaderRoles, mutedNames, keptNames, errors);
    }
}

/**
 * Message pour les joueurs et leaders apres /gvg
 */
function buildPlayerMessage(
    info: VoiceInfo,
    group: "ATK" | "DEF" | "ROM",
    isLeader: boolean,
    leaderRoles: string[],
    mutedNames: string[],
    keptNames: string[],
    errors: number
): string {
    /* Trouver le leader du groupe */
    let leaderRole: string;
    if (group === "ATK") leaderRole = s().lAtkRole;
    else if (group === "DEF") leaderRole = s().lDefRole;
    else leaderRole = s().lRomRole;

    const leaderName = findLeaderName(info, leaderRole) || "[leader absent]";
    const roleLabel = isLeader ? `${leaderRoles[0]} (Leader ${group})` : group;

    const lines: string[] = [
        `**GvG -- ${roleLabel}**`,
        `**${mutedNames.length}** mute(s), **${keptNames.length}** garde(s)`,
        ``,
        `**Ton leader : ${leaderName}** (${leaderRole})`,
        ``,
        `Connecte-toi immediatement et tiens-toi pret :`,
        `> Prends ton bain a **26 min** (vitesse de lecture x3.0 pour gagner du temps)`,
        `> Nourriture + Parcho`,
        `> Sois reactif quand l'invitation a rejoindre la GvG apparaitra`,
        `> Rejoins le groupe de **${leaderName}** rapidement`,
        `> Place-toi du bon cote sur la ligne de depart et ecoute les calls`,
    ];

    if (mutedNames.length > 0) {
        lines.push(``, `**Mutes (${mutedNames.length}) :**`);
        for (const n of mutedNames) lines.push(`> ${n}`);
    }
    if (errors > 0) lines.push(``, `${errors} erreur(s)`);
    return lines.join("\n");
}

/**
 * Message pour le Chief.L apres /gvg
 */
function buildChiefMessage(
    info: VoiceInfo,
    mutedNames: string[],
    keptNames: string[],
    errors: number
): string {
    /* Messages d'encouragement facon Napoleon */
    const napoleonQuotes = [
        "Soldats ! Du haut de ces remparts, quarante siecles d'histoire nous contemplent. Aujourd'hui, c'est NOUS qui ecrivons la legende !",
        "On s'engage, et puis on voit ! Chargez, mes braves -- la victoire n'attend pas les hesitants !",
        "Impossible n'est pas un mot que l'on connait ici. En avant, et que chaque epee frappe juste !",
        "L'audace, l'audace, toujours l'audace ! Que nos ennemis tremblent en nous voyant debarquer !",
        "Je n'ai qu'un ordre : VAINCRE. Le reste, c'est du detail pour les historiens !",
        "Soldats, vous etes entres ici avec rien. Vous en ressortirez avec la gloire !"
    ];
    const napoleon = napoleonQuotes[Math.floor(Math.random() * napoleonQuotes.length)];

    const lines: string[] = [
        `**GvG -- MODE CHIEF**`,
        `**${mutedNames.length}** mute(s), **${keptNames.length}** leader(s)/garde(s)`,
        ``
    ];

    if (keptNames.length > 0) {
        lines.push(`**Leaders gardes :** ${keptNames.join(", ")}`);
        lines.push(``);
    }

    lines.push(
        `**ANNONCE AUX TROUPES :**`,
        ``,
        `> Connectez-vous immediatement !`,
        `> Prenez votre bain a **26 min** (vitesse de lecture de l'animation a **x3.0** pour gagner du temps)`,
        `> Soyez reactifs lorsque l'invitation a rejoindre la GvG apparaitra`,
        `> Nourriture + Parcho`,
        `> Rejoignez le groupe de votre leader rapidement`,
        `> Placez-vous du bon cote sur la ligne de depart et ecoutez les calls`,
        `> **Ceux qui ont leurs eventails, buffez votre Vita avant le depart !**`,
        ``,
        `**A 1 min du depart :**`,
        `*${napoleon}*`,
    );

    if (mutedNames.length > 0) {
        lines.push(``, `**Mutes (${mutedNames.length}) :**`);
        for (const n of mutedNames) lines.push(`> ${n}`);
    }
    if (errors > 0) lines.push(``, `${errors} erreur(s)`);
    return lines.join("\n");
}

// ============================================================
// COMMANDE /gvgcheck
// ============================================================

function cmdGvgCheck(): string {
    const info = getVoiceInfo();
    if (!info) return "Tu dois etre connecte a un canal vocal.";
    if (info.channelId !== s().gvgChannelId) {
        const gvgChannel = ChannelStore.getChannel(s().gvgChannelId);
        const name = gvgChannel?.name || s().gvgChannelId;
        return `Cette commande ne fonctionne que dans le vocal GvG : **${name}**`;
    }

    const me = UserStore.getCurrentUser()?.id;
    const TARGET = 30;

    const roleOrder = [
        s().chiefRole,
        s().lAtkRole, s().lDefRole, s().lRomRole,
        s().atkRole, s().defRole, s().romRole
    ];

    const groups: Record<string, string[]> = {};
    for (const r of roleOrder) groups[r] = [];
    const noGvgRole: string[] = [];

    /* Compteur d'utilisateurs uniques avec au moins un role GvG */
    const uniqueGvgUsers = new Set<string>();

    for (const uid of info.userIds) {
        const name = getDisplayName(info.guildId, uid);
        const suffix = uid === me ? " (toi)" : "";
        let hasGvgRole = false;

        for (const r of roleOrder) {
            if (memberHasRole(info.guildId, uid, r)) {
                groups[r].push(name + suffix);
                hasGvgRole = true;
                uniqueGvgUsers.add(uid);
            }
        }

        if (!hasGvgRole) noGvgRole.push(name + suffix);
    }

    const labels: Record<string, string> = {
        [s().chiefRole]: "Chief Leader",
        [s().lAtkRole]: "Leader ATK",
        [s().lDefRole]: "Leader DEF",
        [s().lRomRole]: "Leader ROM",
        [s().atkRole]: "Attaquants",
        [s().defRole]: "Defenseurs",
        [s().romRole]: "Roamers"
    };

    const lines: string[] = [
        `**=== APPEL GvG ===**`,
        `**${info.userIds.length}** joueur(s) en vocal`,
        ``
    ];

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

    /* Totaux */
    const atkTotal = groups[s().atkRole].length + groups[s().lAtkRole].length;
    const defTotal = groups[s().defRole].length + groups[s().lDefRole].length;
    const romTotal = groups[s().romRole].length + groups[s().lRomRole].length;
    const chiefTotal = groups[s().chiefRole].length;
    const totalUnique = uniqueGvgUsers.size;

    lines.push(`---`);
    lines.push(`**Total GvG : ${totalUnique} / ${TARGET}** joueur(s) avec role`);
    lines.push(`ATK: ${atkTotal} | DEF: ${defTotal} | ROM: ${romTotal} | Chief: ${chiefTotal}`);

    if (totalUnique < TARGET) {
        const missing = TARGET - totalUnique;
        lines.push(``);
        lines.push(`**Il manque ${missing} joueur(s) !** Contactez les absents au plus vite.`);
    } else if (totalUnique > TARGET) {
        lines.push(``);
        lines.push(`**Attention : ${totalUnique - TARGET} joueur(s) en trop.** Verifiez les roles.`);
    } else {
        lines.push(``);
        lines.push(`**Effectif complet ! Les ${TARGET} joueurs sont presents.**`);
    }

    if (noGvgRole.length > 0) {
        lines.push(``);
        lines.push(`**Sans role GvG : ${noGvgRole.length}** (a signaler aux leaders)`);
        for (const n of noGvgRole) lines.push(`  > ${n}`);
    }

    return lines.join("\n");
}

// ============================================================
// COMMANDE /unmute
// ============================================================

function cmdUnmute(): string {
    const info = getVoiceInfo();
    if (!info) return "Tu dois etre connecte a un canal vocal.";

    const me = UserStore.getCurrentUser()?.id;
    let count = 0;
    let errors = 0;

    /* Phase 1 : unmute tous les users presents dans le vocal (restaure volume original) */
    for (const uid of info.userIds) {
        if (uid === me) continue;
        if (unmuteUser(uid)) count++;
        else {
            try { AudioActions.setLocalVolume(uid, 100); count++; } catch { errors++; }
        }
    }

    /* Phase 2 : cleanup des users qui ont quitte le vocal */
    for (const [uid, data] of mutedUsers) {
        if (!info.userIds.includes(uid)) {
            try { AudioActions.setLocalVolume(uid, data.volume); } catch {}
        }
    }
    mutedUsers.clear();

    let msg = `**${count}** unmute(s) -- volumes restaures -- bon debriefing !`;
    if (errors > 0) msg += `\n${errors} erreur(s)`;
    return msg;
}

// ============================================================
// COMMANDE /muted
// ============================================================

function cmdMuted(): string {
    if (mutedUsers.size === 0) return "Personne n'est mute actuellement.";

    const lines = [`**${mutedUsers.size} joueur(s) mute(s) :**`, ""];
    for (const [uid, data] of mutedUsers) {
        lines.push(`> **${data.name}** — vol. original: ${data.volume}% (${uid})`);
    }
    lines.push(``, `*Les volumes originaux seront restaures au /unmute*`);
    return lines.join("\n");
}

// ============================================================
// COMMANDE /vdebug
// ============================================================

function cmdDebug(): string {
    const info = getVoiceInfo();
    if (!info) return "Pas en vocal.";
    const me = UserStore.getCurrentUser()?.id;

    const gvgChannel = ChannelStore.getChannel(s().gvgChannelId);
    const inGvg = info.channelId === s().gvgChannelId;

    const lines: string[] = [
        `**Debug GuildVoiceManager v3**`,
        ``,
        `**Canal actuel :** ${info.channelId} ${inGvg ? "(GvG OK)" : "(PAS le canal GvG)"}`,
        `**Canal GvG configure :** ${s().gvgChannelId} (${gvgChannel?.name || "introuvable"})`,
        `**Guild :** ${info.guildId}`,
        `**Membres en vocal :** ${info.userIds.length}`,
        ``
    ];

    /* ---- AudioActions ---- */
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

    /* ---- MediaEngineStore ---- */
    try {
        const hasGetVol = typeof MediaEngineStore?.getLocalVolume === "function";
        lines.push(`  MediaEngineStore.getLocalVolume: ${hasGetVol ? "OK" : "ABSENT (fallback a 100)"}`);
    } catch { lines.push(`  MediaEngineStore: ERREUR (fallback a 100)`); }

    /* ---- VoiceChannelActions ---- */
    try {
        const hasSVC = typeof VoiceChannelActions?.selectVoiceChannel === "function";
        lines.push(`  VoiceChannelActions.selectVoiceChannel: ${hasSVC ? "OK" : "ABSENT (auto-transfert desactive)"}`);
    } catch { lines.push(`  VoiceChannelActions: ERREUR`); }

    /* ---- Stores ---- */
    try {
        const hasVS = typeof VoiceStateStore?.getVoiceStatesForChannel === "function";
        lines.push(`  VoiceStateStore: ${hasVS ? "OK" : "ABSENT"}`);
    } catch { lines.push(`  VoiceStateStore: ERREUR`); }

    lines.push(`  GuildRoleStore: ${typeof GuildRoleStore?.getRole === "function" ? "OK" : "ABSENT"}`);
    lines.push(`  GuildMemberStore: ${typeof GuildMemberStore?.getMember === "function" ? "OK" : "ABSENT"}`);
    lines.push(``);

    /* ---- Roles configures ---- */
    lines.push(`**Roles configures :**`);
    const allRoles: [string, string][] = [
        ["ATK", s().atkRole], ["DEF", s().defRole], ["ROM", s().romRole],
        ["L.ATK", s().lAtkRole], ["L.DEF", s().lDefRole], ["L.ROM", s().lRomRole],
        ["Chief", s().chiefRole]
    ];
    for (const [label, role] of allRoles) lines.push(`  ${label}: "${role}"`);
    lines.push(``);

    /* ---- Etat des mutes ---- */
    lines.push(`**Mutes en cours :** ${mutedUsers.size}`);
    if (mutedUsers.size > 0) {
        for (const [uid, data] of mutedUsers) {
            lines.push(`  > ${data.name} — vol.orig: ${data.volume}%`);
        }
    }
    lines.push(``);

    /* ---- Liste detaillee des users en vocal ---- */
    lines.push(`**Users en vocal :**`);
    for (const uid of info.userIds) {
        const name = getDisplayName(info.guildId, uid);
        const isMe = uid === me ? " << toi" : "";
        const isMuted = mutedUsers.has(uid) ? " [MUTE]" : "";
        const gvgRoles: string[] = [];
        for (const [label, role] of allRoles) {
            if (memberHasRole(info.guildId, uid, role)) gvgRoles.push(label);
        }
        const tags = gvgRoles.length > 0 ? gvgRoles.join("/") : "aucun role GvG";
        lines.push(`- **${name}**${isMe}${isMuted} [${tags}]`);
    }

    return lines.join("\n");
}

// ============================================================
// DEFINITION DU PLUGIN
// ============================================================

export default definePlugin({
    name: "GuildVoiceManager",
    description: "Gestion vocale GvG : mute/unmute par role avec memorisation des volumes",
    authors: [{ name: "Anthony aka NIXshade", id: 0n }],
    settings,

    commands: [
        {
            name: "gvg",
            description: "Commande principale GvG : auto-transfert + mute par role + instructions",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: async (_args, ctx) => {
                sendBotMessage(ctx.channel.id, { content: "Preparation GvG en cours..." });
                const result = await cmdGvg();
                sendBotMessage(ctx.channel.id, { content: result });
            }
        },
        {
            name: "gvgcheck",
            description: "Appel GvG : liste des membres par role (objectif 30)",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                sendBotMessage(ctx.channel.id, { content: cmdGvgCheck() });
            }
        },
        {
            name: "unmute",
            description: "Unmute tout le monde (restaure les volumes originaux)",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                sendBotMessage(ctx.channel.id, { content: cmdUnmute() });
            }
        },
        {
            name: "muted",
            description: "Liste des joueurs mutes avec leur volume original",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                sendBotMessage(ctx.channel.id, { content: cmdMuted() });
            }
        },
        {
            name: "vdebug",
            description: "Diagnostic complet du plugin",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                sendBotMessage(ctx.channel.id, { content: cmdDebug() });
            }
        },
        {
            name: "gvghelp",
            description: "Aide des commandes GuildVoiceManager",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                const help = [
                    "## GuildVoiceManager v3 - Commandes",
                    "",
                    "**Commande principale :**",
                    "> `/gvg` — Rejoint le vocal GvG automatiquement, mute selon ton role et affiche les instructions",
                    "",
                    "**Preparation :**",
                    "> `/gvgcheck` — Appel des troupes : liste par role, objectif 30 joueurs *(salon GvG uniquement)*",
                    "",
                    "**Utilitaires :**",
                    "> `/unmute` — Demute tout le monde et restaure les volumes originaux *(utilisable partout)*",
                    "> `/muted` — Liste des joueurs mutes avec leur volume original",
                    "> `/vdebug` — Diagnostic : verifie les modules Discord et l'etat du plugin",
                    "> `/gvghelp` — Ce message",
                    "",
                    "**Flux typique :** `/gvgcheck` → `/gvg` → *(GvG)* → `/unmute`",
                    "",
                    "**Roles :** ATK, DEF, ROM, L.ATK, L.DEF, L.ROM, Chief.L",
                    "",
                    "*Le volume de chaque joueur est sauvegarde avant le mute et restaure au /unmute.*"
                ].join("\n");
                sendBotMessage(ctx.channel.id, { content: help });
            }
        }
    ]
});
