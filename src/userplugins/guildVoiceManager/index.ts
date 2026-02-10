/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Anthony aka NIXshade and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings } from "@api/Settings";
import { ApplicationCommandInputType, sendBotMessage } from "@api/Commands";
import definePlugin, { OptionType } from "@utils/types";
import { findByPropsLazy, findStoreLazy } from "@webpack";
import { ChannelStore, GuildMemberStore, GuildRoleStore, SelectedChannelStore, UserStore } from "@webpack/common";

const VoiceStateStore = findStoreLazy("VoiceStateStore");
const AudioActions = findByPropsLazy("toggleLocalMute", "setLocalVolume");

// Track muted users with their display names
const mutedUsers = new Map<string, string>();

const settings = definePluginSettings({
    atkRole: {
        type: OptionType.STRING,
        description: "Nom du rôle ATK (exactement comme dans Discord)",
        default: "ATK"
    },
    defRole: {
        type: OptionType.STRING,
        description: "Nom du rôle DEF",
        default: "DEF"
    },
    romRole: {
        type: OptionType.STRING,
        description: "Nom du rôle ROM",
        default: "ROM"
    }
});

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

function getVoiceInfo(): { guildId: string; channelId: string; userIds: string[] } | null {
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
 * Mute users who have ANY of the specified roles.
 * Returns formatted message with details.
 */
function muteByRoles(myRole: string, rolesToMute: string[]): string {
    const info = getVoiceInfo();
    if (!info) return "❌ Tu dois être connecté à un canal vocal.";

    const me = UserStore.getCurrentUser()?.id;
    const mutedNames: string[] = [];
    const keptNames: string[] = [];
    let errors = 0;

    // Clear previous mutes first
    for (const [uid] of mutedUsers) {
        try { AudioActions.setLocalVolume(uid, 100); } catch {}
    }
    mutedUsers.clear();

    for (const uid of info.userIds) {
        if (uid === me) continue;

        const name = getDisplayName(info.guildId, uid);
        const shouldMute = rolesToMute.some(r => memberHasRole(info.guildId, uid, r));

        if (shouldMute) {
            try {
                AudioActions.setLocalVolume(uid, 0);
                mutedUsers.set(uid, name);
                mutedNames.push(name);
            } catch { errors++; }
        } else {
            keptNames.push(name);
        }
    }

    const total = info.userIds.length - 1;
    let msg = `🔇 **${mutedNames.length}** muté${mutedNames.length !== 1 ? "s" : ""}, **${keptNames.length}** ${myRole} gardé${keptNames.length !== 1 ? "s" : ""} — ${total} autres dans le vocal`;

    if (mutedNames.length > 0)
        msg += `\n\n**Joueurs mutés :**\n${mutedNames.map(n => `> 🔇 ${n}`).join("\n")}`;

    if (keptNames.length > 0)
        msg += `\n\n**Joueurs gardés (${myRole}) :**\n${keptNames.map(n => `> 🔊 ${n}`).join("\n")}`;

    if (errors > 0) msg += `\n\n⚠️ ${errors} erreur(s) de mute`;
    return msg;
}

function unmuteAll(): string {
    const info = getVoiceInfo();
    if (!info) return "❌ Tu dois être connecté à un canal vocal.";

    const me = UserStore.getCurrentUser()?.id;
    let count = 0;
    let errors = 0;

    for (const uid of info.userIds) {
        if (uid === me) continue;
        try { AudioActions.setLocalVolume(uid, 100); count++; }
        catch { errors++; }
    }

    // Cleanup tracked users who left
    for (const [uid] of mutedUsers) {
        if (!info.userIds.includes(uid)) {
            try { AudioActions.setLocalVolume(uid, 100); } catch {}
        }
    }
    mutedUsers.clear();

    let msg = `🔊 **${count}** unmuté${count !== 1 ? "s" : ""} — bon debriefing ! 🎙️`;
    if (errors > 0) msg += `\n⚠️ ${errors} erreur(s)`;
    return msg;
}

function listMuted(): string {
    if (mutedUsers.size === 0) return "✅ Personne n'est muté actuellement.";

    const lines = [`🔇 **${mutedUsers.size} joueur${mutedUsers.size !== 1 ? "s" : ""} muté${mutedUsers.size !== 1 ? "s" : ""} :**`, ""];
    for (const [uid, name] of mutedUsers) {
        lines.push(`> 🔇 **${name}** (\`${uid}\`)`);
    }
    return lines.join("\n");
}

function debugInfo(): string {
    const info = getVoiceInfo();
    if (!info) return "❌ Pas en vocal.";

    const me = UserStore.getCurrentUser()?.id;
    const lines: string[] = [
        `📊 **Debug GuildVoiceManager v11**`,
        `Guild: ${info.guildId} | Channel: ${info.channelId}`,
        `Membres en vocal: ${info.userIds.length}`,
        ``
    ];

    try {
        lines.push(`toggleLocalMute: ${typeof AudioActions?.toggleLocalMute === "function" ? "✅" : "❌"}`);
        lines.push(`setLocalVolume: ${typeof AudioActions?.setLocalVolume === "function" ? "✅" : "❌"}`);
    } catch { lines.push(`AudioActions: ❌ proxy error`); }

    lines.push(`Tracked muted: ${mutedUsers.size}`, ``);

    for (const uid of info.userIds) {
        const member = GuildMemberStore.getMember(info.guildId, uid);
        const roleNames: string[] = [];
        if (member?.roles?.length) {
            for (const rid of member.roles) {
                try {
                    const r = GuildRoleStore.getRole(info.guildId, rid);
                    if (r?.name) roleNames.push(r.name);
                } catch {}
            }
        }

        const name = getDisplayName(info.guildId, uid);
        const isMe = uid === me ? " 👈" : "";
        const isMuted = mutedUsers.has(uid) ? " 🔇" : "";
        const isAtk = memberHasRole(info.guildId, uid, settings.store.atkRole);
        const isDef = memberHasRole(info.guildId, uid, settings.store.defRole);
        const isRom = memberHasRole(info.guildId, uid, settings.store.romRole);
        const tags = [isAtk ? "ATK" : "", isDef ? "DEF" : "", isRom ? "ROM" : ""].filter(Boolean).join("/") || "—";

        lines.push(`• **${name}**${isMe}${isMuted} [${tags}] — ${roleNames.join(", ") || "aucun rôle"}`);
    }

    return lines.join("\n");
}

export default definePlugin({
    name: "GuildVoiceManager",
    description: "Mute/unmute local par rôle pour events de guilde (ATK/DEF/ROM)",
    authors: [{ name: "Anthony aka NIXshade", id: 0n }],
    settings,

    commands: [
        {
            name: "atk",
            description: "🔇 Mute DEF + ROM, garde ATK",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                sendBotMessage(ctx.channel.id, {
                    content: muteByRoles("ATK", [settings.store.defRole, settings.store.romRole])
                });
            }
        },
        {
            name: "def",
            description: "🔇 Mute ATK + ROM, garde DEF",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                sendBotMessage(ctx.channel.id, {
                    content: muteByRoles("DEF", [settings.store.atkRole, settings.store.romRole])
                });
            }
        },
        {
            name: "rom",
            description: "🔇 Mute ATK + DEF, garde ROM",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                sendBotMessage(ctx.channel.id, {
                    content: muteByRoles("ROM", [settings.store.atkRole, settings.store.defRole])
                });
            }
        },
        {
            name: "unmute",
            description: "🔊 Unmute tout le monde",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                sendBotMessage(ctx.channel.id, { content: unmuteAll() });
            }
        },
        {
            name: "muted",
            description: "📋 Liste des joueurs actuellement mutés",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                sendBotMessage(ctx.channel.id, { content: listMuted() });
            }
        },
        {
            name: "vdebug",
            description: "📊 Debug — affiche rôles et état des stores",
            inputType: ApplicationCommandInputType.BUILT_IN,
            execute: (_args, ctx) => {
                sendBotMessage(ctx.channel.id, { content: debugInfo() });
            }
        }
    ]
});
