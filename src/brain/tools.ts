import { tool, type Tool } from "../ai/tool.ts";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel,
  PermissionFlagsBits,
  time,
  OverwriteType,
  PermissionsBitField,
  type Guild,
  type GuildMember,
  type Message,
  type PermissionsString,
} from "discord.js";
import { z } from "zod";
import { outranks } from "../commands/classic.ts";
import { log, provider } from "../core/log.ts";
import { getPersonality, setPersonality } from "../core/personality.ts";
import { evolve } from "./evolution.ts";
import { addNote, readMemberNotes, readMemory } from "../core/memory.ts";
import { getChatConfig, setChatChannel, updateChatConfig } from "../chat/chat.ts";
import { deleteCustomCommand, getCustomCommands, saveCustomCommand } from "../commands/custom.ts";
import { addRule, checkPattern, checkSignals, describeAutomod, describeRule, matchesPatterns, removeRule, setExclusion } from "../moderation/rules.ts";
import { checkAnnounce, EVENTS, getAnnounce, setAnnounce, type Announce } from "../community/announces.ts";
import { addReflex, checkReflex, deleteReflex, getReflexes } from "../chat/reflexes.ts";

// Qui donne l'ordre, sur quel serveur, et comment lui demander confirmation.
export interface ToolContext {
  guild: Guild;
  member: GuildMember;
  confirm: (question: string) => Promise<boolean>;
}

const snowflake = z
  .string()
  .regex(/^\d+$/)
  .describe("Identifiant Discord : les chiffres dans <@…>, <@&…> ou <#…>");

// Toutes les permissions Discord sauf Administrateur, que le bot n'accorde jamais.
const GRANTABLE_PERMISSIONS = Object.keys(PermissionFlagsBits).filter(
  (p) => p !== "Administrator",
) as [PermissionsString, ...PermissionsString[]];

const CHANNEL_TYPES = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  category: ChannelType.GuildCategory,
} as const;

// Envoie une question avec des boutons Confirmer / Annuler et attend la réponse de userId (60 s max).
export async function askConfirmation(
  send: (payload: { content: string; components: ActionRowBuilder<ButtonBuilder>[] }) => Promise<Message>,
  userId: string,
  question: string,
): Promise<boolean> {
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("yes").setLabel("Confirmer").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId("no").setLabel("Annuler").setStyle(ButtonStyle.Secondary),
  );
  const prompt = await send({ content: `⚠️ ${question}`, components: [buttons] });
  try {
    const click = await prompt.awaitMessageComponent({
      componentType: ComponentType.Button,
      filter: (i) => i.user.id === userId,
      time: 60_000,
    });
    const confirmed = click.customId === "yes";
    await click.update({ content: `${confirmed ? "✅" : "❌"} ${question}`, components: [] });
    return confirmed;
  } catch {
    await prompt.edit({ content: `⌛ ${question} (sans réponse, annulé)`, components: [] }).catch(() => {});
    return false;
  }
}

// Les outils que l'IA peut appeler quand un officier mentionne le bot.
// Une erreur levée dans un outil est renvoyée à Claude, qui l'explique à l'admin.
// Permission Discord nécessaire pour chaque outil : l'IA ne reçoit que les outils que la personne qui parle
// aurait le droit d'utiliser elle-même. Les outils absents de cette liste (mémoire, automod, réflexes,
// commandes perso…) sont réservés aux admins.
const REQUIRED: Record<string, bigint> = {
  create_channel: PermissionFlagsBits.ManageChannels,
  edit_channel: PermissionFlagsBits.ManageChannels,
  delete_channel: PermissionFlagsBits.ManageChannels,
  create_role: PermissionFlagsBits.ManageRoles,
  edit_role: PermissionFlagsBits.ManageRoles,
  delete_role: PermissionFlagsBits.ManageRoles,
  give_role: PermissionFlagsBits.ManageRoles,
  remove_role: PermissionFlagsBits.ManageRoles,
  set_channel_permissions: PermissionFlagsBits.ManageRoles,
  timeout_member: PermissionFlagsBits.ModerateMembers,
  ban_member: PermissionFlagsBits.BanMembers,
  rename_member: PermissionFlagsBits.ManageNicknames,
  send_message: PermissionFlagsBits.ManageMessages,
  create_event: PermissionFlagsBits.ManageEvents,
};

// Ce qu'une personne peut faire faire au bot, en clair, pour qu'il lui réponde « tu n'en as pas le droit »
// plutôt que « je n'ai pas d'outil ».
const ABILITIES: [bigint, string][] = [
  [PermissionFlagsBits.ModerateMembers, "réduire au silence ou lever un silence"],
  [PermissionFlagsBits.BanMembers, "bannir"],
  [PermissionFlagsBits.ManageNicknames, "renommer"],
  [PermissionFlagsBits.ManageRoles, "gérer les rôles et les permissions des salons"],
  [PermissionFlagsBits.ManageChannels, "gérer les salons"],
  [PermissionFlagsBits.ManageMessages, "publier des messages"],
  [PermissionFlagsBits.ManageEvents, "créer des événements"],
];

export function describeAbilities(member: GuildMember): string {
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return "tout (administrateur)";
  return ABILITIES.filter(([permission]) => member.permissions.has(permission)).map(([, label]) => label).join(", ") || "rien";
}

// Les permissions qui donnent accès au « cerveau » avec au moins un outil.
export const STAFF_PERMISSIONS = [...new Set(Object.values(REQUIRED)), PermissionFlagsBits.Administrator];

export function buildTools({ guild, member, confirm }: ToolContext): Tool[] {
  const user = member.user;
  const reason = `Ordre de ${user.tag} via le bot`;

  // Mêmes règles de hiérarchie que Discord : on n'agit pas, via le bot, sur plus haut que soi.
  const checkTarget = async (userId: string) => {
    const target = await guild.members.fetch(userId).catch(() => null);
    if (target && !outranks(member, target)) {
      throw new Error(`${target.displayName} est au même niveau que ${member.displayName} ou au-dessus : action refusée`);
    }
    return target;
  };
  const checkRole = (roleId: string) => {
    const role = guild.roles.cache.get(roleId);
    if (role && member.id !== guild.ownerId && role.comparePositionTo(member.roles.highest) >= 0) {
      throw new Error(`le rôle ${role.name} est au niveau de ${member.displayName} ou au-dessus : action refusée`);
    }
  };
  // Discord interdit d'accorder une permission qu'on n'a pas soi-même (dans le salon concerné, le cas échéant).
  const checkGrantable = (permissions: PermissionsString[] | undefined, held: Readonly<PermissionsBitField> = member.permissions) => {
    const missing = (permissions ?? []).filter((p) => !held.has(p));
    if (missing.length) throw new Error(`${member.displayName} n'a pas ces permissions et ne peut donc pas les accorder : ${missing.join(", ")}`);
  };
  // Dans un salon, le demandeur doit avoir lui-même les permissions requises, comme sur Discord.
  // Sans ce contrôle, le bot (admin) ferait à sa place ce que Discord lui interdit, par exemple dans un salon privé.
  const fetchChannel = async (channelId: string, required: bigint[]) => {
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    const held = channel?.permissionsFor(member);
    if (!channel || !held?.has([PermissionFlagsBits.ViewChannel, ...required])) {
      throw new Error(`salon introuvable, ou ${member.displayName} n'y a pas les droits nécessaires : action refusée`);
    }
    return { channel, held };
  };
  // Chaque action (ou annulation) est journalisée dans la console et le salon de logs.
  const done = async (text: string, by?: string) => {
    await log(guild, "Action", `🛠️ ${text} (demandé par ${user})${by ? provider(by) : ""}`);
    return text;
  };

  const tools: Tool[] = [
    tool({
      name: "create_channel",
      description: "Crée un salon textuel, un salon vocal ou une catégorie.",
      inputSchema: z.object({
        name: z.string().min(1).max(100),
        type: z.enum(["text", "voice", "category"]),
        parent_id: snowflake.optional().describe("Catégorie dans laquelle ranger le salon"),
        topic: z.string().max(1024).optional().describe("Sujet du salon (salons textuels uniquement)"),
        private_role_ids: z
          .array(snowflake)
          .optional()
          .describe("Si fourni, le salon est privé : seuls ces rôles (et les admins) le voient"),
      }),
      run: async ({ name, type, parent_id, topic, private_role_ids }) => {
        if (parent_id) await fetchChannel(parent_id, [PermissionFlagsBits.ManageChannels]);
        const channel = await guild.channels.create({
          name,
          type: CHANNEL_TYPES[type],
          parent: parent_id,
          topic,
          permissionOverwrites: private_role_ids && [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            { id: guild.client.user.id, allow: [PermissionFlagsBits.ViewChannel] },
            ...private_role_ids.map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel] })),
          ],
          reason,
        });
        return done(`Salon créé : ${channel} (id ${channel.id})`);
      },
    }),

    tool({
      name: "delete_channel",
      description: "Supprime un salon ou une catégorie. Une confirmation est demandée.",
      inputSchema: z.object({ channel_id: snowflake }),
      run: async ({ channel_id }) => {
        const { channel } = await fetchChannel(channel_id, [PermissionFlagsBits.ManageChannels]);
        if (!(await confirm(`Supprimer le salon **${channel.name}** ?`))) {
          return done("Suppression annulée.");
        }
        await channel.delete(reason);
        return done(`Salon ${channel.name} supprimé.`);
      },
    }),

    tool({
      name: "create_role",
      description: "Crée un rôle. N'accorde que les permissions nécessaires à la demande.",
      inputSchema: z.object({
        name: z.string().min(1).max(100),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).describe("Couleur hexadécimale, ex. #C9A227"),
        hoist: z.boolean().describe("Afficher ses membres à part dans la liste des membres"),
        mentionable: z.boolean(),
        permissions: z
          .array(z.enum(GRANTABLE_PERMISSIONS))
          .describe("Permissions en plus de celles de @everyone ; tableau vide si aucune"),
      }),
      run: async ({ name, color, hoist, mentionable, permissions }) => {
        checkGrantable(permissions);
        const role = await guild.roles.create({
          name,
          colors: { primaryColor: color as `#${string}` },
          hoist,
          mentionable,
          permissions,
          reason,
        });
        return done(`Rôle créé : ${role} (id ${role.id}), permissions : ${permissions.join(", ") || "aucune"}`);
      },
    }),

    tool({
      name: "delete_role",
      description: "Supprime un rôle. Une confirmation est demandée.",
      inputSchema: z.object({ role_id: snowflake }),
      run: async ({ role_id }) => {
        const role = await guild.roles.fetch(role_id);
        if (!role) throw new Error("Rôle introuvable");
        checkRole(role_id);
        if (!(await confirm(`Supprimer le rôle **${role.name}** ?`))) {
          return done("Suppression annulée.");
        }
        await role.delete(reason);
        return done(`Rôle ${role.name} supprimé.`);
      },
    }),

    tool({
      name: "edit_role",
      description: "Modifie un rôle existant : nom, couleur, affichage à part, mention, permissions. Ne renseigne que ce qui change.",
      inputSchema: z.object({
        role_id: snowflake,
        name: z.string().min(1).max(100).optional(),
        color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional().describe("Couleur hexadécimale, ex. #C9A227"),
        hoist: z.boolean().optional().describe("Afficher ses membres à part dans la liste des membres"),
        mentionable: z.boolean().optional(),
        permissions: z
          .array(z.enum(GRANTABLE_PERMISSIONS))
          .optional()
          .describe("Remplace toutes les permissions du rôle ; omettre pour ne pas y toucher"),
      }),
      run: async ({ role_id, name, color, hoist, mentionable, permissions }) => {
        const role = await guild.roles.fetch(role_id);
        if (!role) throw new Error("Rôle introuvable");
        checkRole(role_id);
        checkGrantable(permissions);
        const before = role.name;
        await role.edit({
          name,
          colors: color ? { primaryColor: color as `#${string}` } : undefined,
          hoist,
          mentionable,
          permissions,
          reason,
        });
        const changes = [
          name && `nom « ${before} » → « ${name} »`,
          color && `couleur ${color}`,
          hoist !== undefined && `affiché à part : ${hoist ? "oui" : "non"}`,
          mentionable !== undefined && `mentionnable : ${mentionable ? "oui" : "non"}`,
          permissions && `permissions : ${permissions.join(", ") || "aucune"}`,
        ].filter(Boolean);
        return done(`Rôle ${role} modifié (${changes.join(", ") || "rien à changer"})`);
      },
    }),

    tool({
      name: "edit_channel",
      description: "Modifie un salon ou une catégorie existants : nom, sujet, catégorie parente. Ne renseigne que ce qui change.",
      inputSchema: z.object({
        channel_id: snowflake,
        name: z.string().min(1).max(100).optional(),
        topic: z.string().max(1024).optional().describe("Sujet (salons textuels uniquement)"),
        parent_id: snowflake.optional().describe("Nouvelle catégorie"),
      }),
      run: async ({ channel_id, name, topic, parent_id }) => {
        const { channel } = await fetchChannel(channel_id, [PermissionFlagsBits.ManageChannels]);
        if (parent_id) await fetchChannel(parent_id, [PermissionFlagsBits.ManageChannels]);
        const before = channel.name;
        await channel.edit({ name, topic, parent: parent_id, reason });
        return done(`Salon ${channel} modifié${name ? ` (« ${before} » → « ${name} »)` : ""}`);
      },
    }),

    tool({
      name: "set_channel_permissions",
      description: `Modifie les permissions d'un salon ou d'une catégorie existants pour un rôle, pour @everyone ou pour un membre (ex. salon en lecture seule : refuser SendMessages à @everyone, l'autoriser à certains rôles).
Pour @everyone, target_id vaut ${guild.id}. Ne renseigne que les permissions qui changent ; les autres restent telles quelles.`,
      inputSchema: z.object({
        channel_id: snowflake,
        target_id: snowflake.describe("Id du rôle ou du membre concerné"),
        target_type: z.enum(["role", "member"]),
        allow: z.array(z.enum(GRANTABLE_PERMISSIONS)).describe("Permissions à autoriser (vert)"),
        deny: z.array(z.enum(GRANTABLE_PERMISSIONS)).describe("Permissions à refuser (rouge)"),
        reset: z.array(z.enum(GRANTABLE_PERMISSIONS)).describe("Permissions à remettre au neutre (hérité)"),
      }),
      run: async ({ channel_id, target_id, target_type, allow, deny, reset }) => {
        // « Gérer les permissions » d'un salon, c'est ManageRoles dans ce salon.
        const { channel, held } = await fetchChannel(channel_id, [PermissionFlagsBits.ManageRoles]);
        if (!("permissionOverwrites" in channel)) throw new Error("Ce salon n'a pas de permissions propres");
        if (target_type === "role") checkRole(target_id);
        else if (target_id !== member.id) await checkTarget(target_id);
        checkGrantable([...allow, ...deny, ...reset], held);
        const changes = Object.fromEntries([
          ...allow.map((p) => [p, true]),
          ...deny.map((p) => [p, false]),
          ...reset.map((p) => [p, null]),
        ]) as Partial<Record<PermissionsString, boolean | null>>;
        await channel.permissionOverwrites.edit(target_id, changes, {
          reason,
          type: target_type === "role" ? OverwriteType.Role : OverwriteType.Member,
        });
        const who = target_id === guild.id ? "@everyone" : target_type === "role" ? `<@&${target_id}>` : `<@${target_id}>`;
        const summary = [allow.length && `✅ ${allow.join(", ")}`, deny.length && `❌ ${deny.join(", ")}`, reset.length && `➖ ${reset.join(", ")}`]
          .filter(Boolean)
          .join(" · ");
        return done(`Permissions de ${channel} pour ${who} : ${summary || "rien à changer"}`);
      },
    }),

    tool({
      name: "remove_role",
      description: "Retire un rôle à un membre.",
      inputSchema: z.object({ user_id: snowflake, role_id: snowflake }),
      run: async ({ user_id, role_id }) => {
        checkRole(role_id);
        const target = await guild.members.fetch(user_id);
        await target.roles.remove(role_id, reason);
        return done(`Rôle <@&${role_id}> retiré à ${target}.`);
      },
    }),

    tool({
      name: "give_role",
      description: "Donne un rôle à un membre.",
      inputSchema: z.object({ user_id: snowflake, role_id: snowflake }),
      run: async ({ user_id, role_id }) => {
        checkRole(role_id);
        const target = await guild.members.fetch(user_id);
        await target.roles.add(role_id, reason);
        return done(`Rôle <@&${role_id}> donné à ${target}.`);
      },
    }),

    tool({
      name: "rename_member",
      description: "Change le pseudo d'un membre sur le serveur. Pseudo vide pour lui rendre son nom d'origine.",
      inputSchema: z.object({
        user_id: snowflake,
        nickname: z.string().max(32).describe("Nouveau pseudo (32 caractères max), vide pour le retirer"),
      }),
      run: async ({ user_id, nickname }) => {
        const target = user_id === member.id ? member : await checkTarget(user_id);
        if (!target) throw new Error("Membre introuvable");
        const before = target.displayName;
        await target.setNickname(nickname || null, reason);
        return done(`${target} renommé : « ${before} » → « ${nickname || target.user.username} ».`);
      },
    }),

    tool({
      name: "timeout_member",
      description: "Réduit un membre au silence pour une durée donnée (timeout Discord), ou lève son silence avec 0 minute.",
      inputSchema: z.object({
        user_id: snowflake,
        minutes: z.number().int().min(0).max(40320).describe("Durée en minutes (max 28 jours), 0 pour lever le silence"),
        why: z.string().describe("Raison, visible dans le journal d'audit"),
      }),
      run: async ({ user_id, minutes, why }) => {
        const target = await checkTarget(user_id);
        if (!target) throw new Error("Membre introuvable");
        await target.timeout(minutes > 0 ? minutes * 60_000 : null, `${why} (${reason})`);
        return done(minutes > 0 ? `${target} réduit au silence pour ${minutes} min.` : `${target} peut de nouveau parler.`);
      },
    }),

    tool({
      name: "ban_member",
      description: "Bannit un membre du serveur. Une confirmation est demandée.",
      inputSchema: z.object({
        user_id: snowflake,
        why: z.string().describe("Raison, visible dans le journal d'audit"),
      }),
      run: async ({ user_id, why }) => {
        await checkTarget(user_id);
        const target = await guild.client.users.fetch(user_id);
        if (!(await confirm(`Bannir **${target.tag}** ? Raison : ${why}`))) {
          return done("Bannissement annulé.");
        }
        await guild.members.ban(user_id, { reason: `${why} (${reason})` });
        return done(`${target.tag} banni.`);
      },
    }),

    tool({
      name: "remember",
      description:
        "Retient durablement une information utile sur le serveur ou ses officiers (préférence, convention, décision). Une phrase courte par note.",
      inputSchema: z.object({ note: z.string().min(1).max(300) }),
      run: async ({ note }) => {
        await addNote(guild.id, note);
        await done(`Note retenue : ${note}`);
        return "Noté dans la mémoire.";
      },
    }),

    tool({
      name: "send_message",
      description: "Publie un message de ta part dans un salon (annonce, lien, règlement…).",
      inputSchema: z.object({
        channel_id: snowflake,
        content: z.string().min(1).max(2000),
        ping_everyone: z.boolean().describe("Autoriser @everyone / @here dans le message (seulement si demandé explicitement)"),
      }),
      run: async ({ channel_id, content, ping_everyone }) => {
        const { channel, held } = await fetchChannel(channel_id, [PermissionFlagsBits.SendMessages]);
        if (!channel.isSendable()) throw new Error("Impossible d'écrire dans ce salon");
        const canMentionAll = held.has(PermissionFlagsBits.MentionEveryone);
        if (ping_everyone && !canMentionAll) {
          throw new Error(`${member.displayName} n'a pas la permission de mentionner @everyone dans ce salon`);
        }
        // Le bot est admin et pourrait pinger n'importe quel rôle : on se limite à ce que le demandeur pourrait pinger
        // lui-même (les rôles mentionnables, ou tous s'il a la permission de tout mentionner). Aucun membre n'est pingé.
        const roles = [...content.matchAll(/<@&(\d+)>/g)]
          .map((match) => match[1]!)
          .filter((id) => canMentionAll || guild.roles.cache.get(id)?.mentionable);
        const sent = await channel.send({ content, allowedMentions: { parse: ping_everyone ? ["everyone"] : [], roles } });
        return done(`Message publié dans ${channel} : ${sent.url}`);
      },
    }),

    tool({
      name: "create_event",
      description:
        "Crée un événement Discord planifié. Soit dans un salon vocal (voice_channel_id), soit externe avec un lieu ou un lien (location, et alors end obligatoire).",
      inputSchema: z.object({
        name: z.string().min(1).max(100),
        description: z.string().max(1000).optional(),
        start: z.string().describe("Début au format ISO 8601 avec fuseau, ex. 2026-10-14T21:00:00+02:00"),
        end: z.string().optional().describe("Fin au format ISO 8601 avec fuseau"),
        voice_channel_id: snowflake.optional().describe("Salon vocal où a lieu l'événement"),
        location: z.string().max(100).optional().describe("Lieu ou lien, pour un événement externe"),
      }),
      run: async ({ name, description, start, end, voice_channel_id, location }) => {
        const startDate = new Date(start);
        const endDate = end ? new Date(end) : undefined;
        if (Number.isNaN(startDate.getTime()) || (endDate && Number.isNaN(endDate.getTime()))) throw new Error("Date invalide");
        if (startDate.getTime() < Date.now()) throw new Error("La date de début est déjà passée");
        if (!voice_channel_id && !location) throw new Error("Il faut un salon vocal ou un lieu");
        if (voice_channel_id) await fetchChannel(voice_channel_id, [PermissionFlagsBits.Connect]);
        const external = !voice_channel_id;
        // Discord exige une heure de fin pour un événement externe : 2 h par défaut.
        const scheduledEndTime = endDate ?? (external ? new Date(startDate.getTime() + 2 * 3_600_000) : undefined);
        const event = await guild.scheduledEvents.create({
          name,
          description,
          scheduledStartTime: startDate,
          scheduledEndTime,
          privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
          entityType: external ? GuildScheduledEventEntityType.External : GuildScheduledEventEntityType.Voice,
          channel: voice_channel_id,
          entityMetadata: external ? { location } : undefined,
          reason,
        });
        return done(`Événement « ${event.name} » créé pour le ${time(startDate, "F")} : ${event.url}`);
      },
    }),

    tool({
      name: "create_command",
      description: `Crée (ou remplace, si le nom existe déjà) une commande slash perso dont la réponse est fixe : règlement, liens, infos, FAQ… Tu rédiges la réponse une fois, puis le bot la sert à chaque utilisation sans IA.
Variables utilisables dans la réponse : {membre} (qui tape la commande), {serveur}, {salon}.`,
      inputSchema: z.object({
        name: z.string().regex(/^[a-z0-9_-]{1,32}$/).describe("Nom de la commande, sans le /, en minuscules sans accents ni espaces, ex. regles"),
        description: z.string().min(1).max(100).describe("Description affichée par Discord sous la commande"),
        response: z.string().min(1).max(2000).describe("Le texte que le bot répondra"),
        ephemeral: z.boolean().describe("true : seul celui qui tape la commande voit la réponse"),
        admin_only: z.boolean().describe("true : commande réservée aux admins"),
      }),
      run: async ({ name, description, response, ephemeral, admin_only }) => {
        const status = await saveCustomCommand(guild, { name, description, response, ephemeral, adminOnly: admin_only });
        return done(`Commande perso /${name} ${status} : elle répondra sans IA.`);
      },
    }),

    tool({
      name: "delete_command",
      description: "Supprime une commande slash perso.",
      inputSchema: z.object({ name: z.string().min(1).describe("Nom sans le /") }),
      run: async ({ name }) => {
        const command = await deleteCustomCommand(guild, name.replace(/^\//, ""));
        if (!command) throw new Error(`Aucune commande perso /${name}`);
        return done(`Commande perso /${command.name} supprimée.`);
      },
    }),

    tool({
      name: "list_commands",
      description: "Liste les commandes slash perso du serveur et leur réponse.",
      inputSchema: z.object({}),
      run: async () => {
        const commands = await getCustomCommands(guild.id);
        return commands.length
          ? commands.map((c) => `/${c.name} (${c.description}) :\n${c.response}`).join("\n\n")
          : "Aucune commande perso.";
      },
    }),

    tool({
      name: "chat_channel",
      description:
        "Ouvre (ou ferme) un salon où les membres non-admins peuvent discuter avec toi en te mentionnant. Ailleurs, tu ignores les membres. Ils parlent à une version légère de toi : réflexes gratuits d'abord, puis IA plafonnée par jour.",
      inputSchema: z.object({ channel_id: snowflake, enabled: z.boolean() }),
      run: async ({ channel_id, enabled }) => {
        await setChatChannel(guild.id, channel_id, enabled);
        return done(`<#${channel_id}> ${enabled ? "ouvert" : "fermé"} à la discussion avec les membres.`);
      },
    }),

    tool({
      name: "save_reflexes",
      description: `Enregistre des réflexes : des réponses toutes faites que le bot sert aux membres SANS IA quand un motif reconnaît leur message. C'est ce qui permet de discuter avec les membres sans coût.
- Couvre les échanges courants : salutations, remerciements, au revoir, « qui es-tu ? », « ça va ? », compliments, moqueries envers le bot, demandes de blague, questions fréquentes sur le serveur…
- patterns : expressions régulières JavaScript (sans renvoi \\1 ni lookahead), testées sur le message brut et sur sa version en minuscules sans accents. Ancre les échanges courts (^…$) pour ne pas intercepter une vraie question qui commence par « salut ». Pas de motif qui reconnaîtrait un message sans rapport.
- replies : 4 à 6 réponses variées, dans le ton du serveur, 1 à 2 phrases chacune. Variables : {membre}, {serveur}.
- examples : au moins 2 messages qui doivent déclencher le réflexe ; le bot vérifie les motifs dessus.
- Un réflexe qui a le même label qu'un existant le remplace.
- fallbacks : 3 phrases que le bot dira quand son budget de discussion du jour est épuisé ; vide pour garder les actuelles.`,
      inputSchema: z.object({
        reflexes: z
          .array(
            z.object({
              label: z.string().min(1).max(80),
              patterns: z.array(z.string().min(1).max(300)).min(1).max(10),
              replies: z.array(z.string().min(1).max(500)).min(1).max(8),
              examples: z.array(z.string()).min(2).max(6),
            }),
          )
          .max(30),
        fallbacks: z.array(z.string().min(1).max(300)).max(6),
      }),
      run: async ({ reflexes, fallbacks }) => {
        const saved: string[] = [];
        const refused: string[] = [];
        for (const draft of reflexes) {
          const problems = checkReflex(draft);
          if (problems.length) {
            refused.push(`« ${draft.label} » : ${problems.join(" ; ")}`);
            continue;
          }
          const reflex = await addReflex(guild.id, { label: draft.label, patterns: draft.patterns, replies: draft.replies, learned: false });
          saved.push(`${reflex.id} ${reflex.label}`);
        }
        if (fallbacks.length) await updateChatConfig(guild.id, { fallbacks });
        await done(`${saved.length} réflexe(s) enregistré(s)${fallbacks.length ? ` et ${fallbacks.length} phrases de repli` : ""}.`);
        return (
          [saved.length && `Enregistrés : ${saved.join(", ")}`, refused.length && `Refusés, corrige-les et renvoie-les :\n${refused.join("\n")}`]
            .filter(Boolean)
            .join("\n") || "Rien à enregistrer."
        );
      },
    }),

    tool({
      name: "list_reflexes",
      description: "Liste les réflexes de discussion (id, intitulé) et les salons ouverts aux membres.",
      inputSchema: z.object({}),
      run: async () => {
        const [reflexes, config] = await Promise.all([getReflexes(guild.id), getChatConfig(guild.id)]);
        const channels = config.channels.map((id) => `<#${id}>`).join(", ") || "aucun";
        const list = reflexes.map((r) => `${r.id} ${r.label}${r.learned ? " (appris)" : ""}`).join("\n") || "aucun";
        return `Salons ouverts aux membres : ${channels}\nRéflexes :\n${list}`;
      },
    }),

    tool({
      name: "delete_reflex",
      description: "Supprime un réflexe par son id (ex. x3).",
      inputSchema: z.object({ id: z.string().min(1) }),
      run: async ({ id }) => {
        const reflex = await deleteReflex(guild.id, id);
        if (!reflex) throw new Error(`Aucun réflexe « ${id} »`);
        return done(`Réflexe ${reflex.id} « ${reflex.label} » supprimé.`);
      },
    }),

    tool({
      name: "member_info",
      description:
        "Ce que tu sais d'un membre : ses rôles, sa date d'arrivée sur le serveur, et ce qu'il t'a dit de lui-même en discutant. Par mention (user_id) ou par pseudo (name).",
      inputSchema: z.object({
        user_id: snowflake.optional(),
        name: z.string().min(1).max(100).optional().describe("Pseudo ou nom d'utilisateur, si pas de mention"),
      }),
      run: async ({ user_id, name }) => {
        let target = user_id ? await guild.members.fetch(user_id).catch(() => null) : null;
        if (!target && name) {
          const found = await guild.members.fetch({ query: name, limit: 5 });
          if (found.size > 1) {
            return `Plusieurs membres correspondent : ${found.map((m) => `${m.displayName} (<@${m.id}>)`).join(", ")}. Demande lequel.`;
          }
          target = found.first() ?? null;
        }
        if (!target) throw new Error("membre introuvable sur le serveur");
        const notes = await readMemberNotes(guild.id, target.id);
        const roles = target.roles.cache.filter((r) => r.id !== guild.id).map((r) => r.name).join(", ") || "aucun";
        return [
          `${target.displayName} (<@${target.id}>, nom d'utilisateur ${target.user.username})`,
          `Sur le serveur depuis le ${target.joinedAt?.toLocaleDateString("fr-FR") ?? "?"}`,
          `Rôles : ${roles}`,
          notes ? `Ce qu'il t'a dit de lui-même en discutant :\n${notes}` : "Il ne t'a encore rien dit de lui-même en discutant.",
        ].join("\n");
      },
    }),

    tool({
      name: "announce_setup",
      description: `Gère les annonces envoyées automatiquement (sans IA) quand un membre arrive (arrivee), part de lui-même (depart), est expulsé (kick) ou banni (ban). Chaque événement a son salon et ses messages.
- action "show" : affiche le salon et les messages actuels de l'événement. Utilise-le avant d'en parler.
- action "set" : choisit le salon (channel_id) et, si on te demande de les (ré)écrire, rédige 10 messages. Ils seront réutilisés tels quels, tirés au hasard : variés, 1 à 2 phrases, dans le ton et l'univers du serveur, adaptés à l'événement (chaleureux pour une arrivée, un adieu pour un départ, sec ou moqueur pour un kick, solennel ou cinglant pour un ban, sans jamais inventer la raison). {membre} (obligatoire) devient la mention du nouveau, ou le pseudo de celui qui part ; {serveur} le nom du serveur. Ni lien ni autre mention. messages vide : on garde les actuels.
- action "disable" : arrête les annonces de cet événement (les messages sont gardés).`,
      inputSchema: z.object({
        event: z.enum(EVENTS),
        action: z.enum(["show", "set", "disable"]),
        channel_id: z.string().describe("Salon pour set (chiffres de <#…>) ; vide sinon"),
        messages: z.array(z.string().min(1).max(400)).max(15).describe("Les messages pour set ; vide pour garder les actuels"),
      }),
      run: async ({ event, action, channel_id, messages }) => {
        const describe = (a: Announce) =>
          `Annonce « ${event} » ${a.channelId ? `active dans <#${a.channelId}>` : "désactivée"}, ${a.messages.length} message(s) :\n${a.messages.map((m) => `- ${m}`).join("\n")}`;
        if (action === "show") return describe(await getAnnounce(guild.id, event));
        if (action === "disable") return done(`Annonce « ${event} » désactivée.\n${describe(await setAnnounce(guild.id, event, { channelId: null }))}`);
        const { channel } = await fetchChannel(channel_id, [PermissionFlagsBits.SendMessages]);
        if (!channel.isSendable()) throw new Error("Ce salon ne permet pas d'envoyer des messages.");
        const problem = messages.length ? checkAnnounce(messages) : null;
        if (problem) throw new Error(problem);
        if (!messages.length && !(await getAnnounce(guild.id, event)).messages.length) throw new Error("Aucun message enregistré pour cet événement : rédige-en 10.");
        const saved = await setAnnounce(guild.id, event, { channelId: channel.id, ...(messages.length ? { messages } : {}) });
        return done(`Annonce « ${event} » activée.\n${describe(saved)}`);
      },
    }),

    tool({
      name: "automod_status",
      description: "Affiche les règles d'automod actives et les exclusions.",
      inputSchema: z.object({}),
      run: () => describeAutomod(guild.id),
    }),

    tool({
      name: "automod_add_rule",
      description: `Ajoute une règle d'automod. Les actions sont ensuite appliquées par le bot sans IA.
- watch : reformule ce qu'il faut surveiller en un critère précis, compréhensible sans contexte.
- Détection, le plus économique d'abord :
  - Si la règle se détecte de façon fiable par des motifs (liens d'invitation, mots ou expressions précis, majuscules, répétitions…), écris patterns et mets use_ai à false : la règle ne coûtera plus aucun appel à l'IA.
  - Si elle demande du jugement (intention, contexte, insultes déguisées), mets use_ai à true : une IA rapide jugera les messages. Tu peux ajouter des patterns pour les cas évidents, attrapés sans IA.
  - Avec use_ai, écris aussi signals : le pré-filtre. Ce sont des motifs LARGES (mots-clés, racines, variantes d'orthographe, abréviations, tournures) sans lesquels un message ne peut pas enfreindre la règle. Seuls les messages qui en contiennent un sont envoyés à l'IA : « mdr », « gg » ou « qui joue ce soir ? » ne coûtent rien. Mieux vaut trop large que trop étroit. Une infraction peut ne contenir aucun gros mot : couvre aussi les mots qui désignent la cible ou le sujet de la règle (personnes, groupes, communautés, objets, sites…). Fournis au moins 3 test_suspects (infractions, y compris déguisées ou en argot) : chacun doit contenir un signal. Laisse signals vide seulement si la règle est vraiment impossible à repérer par des mots (alors tous les messages sont analysés).
  - patterns : expressions régulières JavaScript (sans les / /, sans renvoi \\1 ni lookahead). Chacune est testée sur le message brut, sur sa version en minuscules sans accents, et sur cette version avec le leetspeak décodé (0→o, 1→i, 3→e, 4→a, 5→s, 7→t, @→a, $→s). Pas de motif qui détecterait un message banal.
  - Avec des patterns, fournis au moins 2 test_matches (messages qui doivent être détectés) et 2 test_non_matches (messages normaux qui ne doivent pas l'être). Le bot vérifie les motifs dessus avant d'enregistrer la règle ; corrige-les si un test échoue.
- N'active que les actions demandées ; alert vaut true sauf si l'officier dit le contraire.
- dm_templates : si un message privé est demandé, écris-en 4 variantes différentes. Elles seront réutilisées telles quelles à chaque infraction, tirées au hasard. Chacune : 1 à 3 phrases, ferme mais respectueux, dans le ton du serveur, sans citer le message fautif. Variables : {membre}, {salon}, {serveur}.`,
      inputSchema: z.object({
        watch: z.string().min(1).max(500),
        use_ai: z.boolean().describe("true si une IA doit juger les messages ; false si les motifs suffisent"),
        patterns: z.array(z.string().min(1).max(300)).max(20).describe("Expressions régulières ; vide si aucune"),
        test_matches: z.array(z.string()).max(10).describe("Messages qui doivent être détectés par les motifs"),
        test_non_matches: z.array(z.string()).max(10).describe("Messages normaux qui ne doivent pas l'être"),
        signals: z.array(z.string().min(1).max(300)).max(40).describe("Pré-filtre (avec use_ai) : motifs larges sans lesquels un message ne peut pas enfreindre la règle ; vide si impossible"),
        test_suspects: z.array(z.string()).max(10).describe("Infractions d'exemple, y compris déguisées : chacune doit contenir un signal"),
        delete: z.boolean().describe("Supprimer le message"),
        timeout_minutes: z.number().int().min(0).max(40320).describe("Durée du silence, 0 si aucun"),
        dm: z.boolean().describe("Envoyer un message privé au membre"),
        alert: z.boolean().describe("Signaler dans le salon de logs"),
        dm_templates: z.array(z.string().min(1).max(500)).max(6).describe("Variantes du message privé ; vide si dm vaut false"),
      }),
      run: async ({ watch, use_ai, patterns, test_matches, test_non_matches, signals, test_suspects, delete: del, timeout_minutes, dm, alert, dm_templates }) => {
        if (!use_ai && !patterns.length) throw new Error("Une règle sans IA a besoin d'au moins un motif.");
        const signalProblem = use_ai ? checkSignals(signals, test_suspects) : null;
        if (signalProblem) throw new Error(signalProblem);
        if (patterns.length) {
          const invalid = patterns.flatMap((p) => {
            const problem = checkPattern(p);
            return problem ? [`« ${p} » : ${problem}`] : [];
          });
          if (invalid.length) throw new Error(`Motifs refusés :\n${invalid.join("\n")}`);
          if (test_matches.length < 2 || test_non_matches.length < 2) {
            throw new Error("Fournis au moins 2 test_matches et 2 test_non_matches pour vérifier les motifs.");
          }
          const missed = test_matches.filter((t) => !matchesPatterns(patterns, t));
          const wrong = test_non_matches.filter((t) => matchesPatterns(patterns, t));
          if (missed.length || wrong.length) {
            throw new Error(
              `Tests échoués, corrige les motifs.${missed.length ? `\nNon détectés : ${missed.join(" | ")}` : ""}${wrong.length ? `\nDétectés à tort : ${wrong.join(" | ")}` : ""}`,
            );
          }
        }
        const rule = await addRule(guild.id, {
          watch,
          patterns,
          useAi: use_ai,
          signals: use_ai ? signals : [],
          delete: del,
          timeoutMinutes: timeout_minutes,
          dm: dm && dm_templates.length > 0,
          alert,
          dmTemplates: dm_templates,
        });
        return done(`Règle d'automod ajoutée :\n${describeRule(rule)}`);
      },
    }),

    tool({
      name: "automod_remove_rule",
      description: "Retire une règle d'automod par son id (ex. r1, grave, suspect).",
      inputSchema: z.object({ rule_id: z.string().min(1) }),
      run: async ({ rule_id }) => {
        const rule = await removeRule(guild.id, rule_id);
        if (!rule) throw new Error(`Aucune règle « ${rule_id} »`);
        return done(`Règle d'automod ${rule.id} retirée (${rule.watch}).`);
      },
    }),

    tool({
      name: "automod_exclude",
      description:
        "Exclut de l'automod (ou y réintègre) un membre, un rôle, un salon ou une catégorie entière, pour une seule règle (rule_id) ou pour toutes (rule_id vide). Si l'officier ne précise pas, demande-lui laquelle. Exclure un salon exclut aussi ses fils ; exclure une catégorie exclut tous ses salons.",
      inputSchema: z.object({
        kind: z.enum(["user", "role", "channel"]).describe("channel couvre aussi les catégories"),
        id: snowflake,
        exclude: z.boolean().describe("true pour exclure, false pour réintégrer"),
        rule_id: z.string().describe("Id de la règle concernée (ex. r1), ou vide pour toutes les règles"),
      }),
      run: async ({ kind, id, exclude, rule_id }) => {
        const key = ({ user: "users", role: "roles", channel: "channels" } as const)[kind];
        await setExclusion(guild.id, key, id, exclude, rule_id || undefined);
        const mention = { user: `<@${id}>`, role: `<@&${id}>`, channel: `<#${id}>` }[kind];
        const scope = rule_id ? `la règle ${rule_id}` : "toutes les règles d'automod";
        return done(`${mention} ${exclude ? "exclu de" : "réintégré dans"} ${scope}.`);
      },
    }),

    tool({
      name: "discover_server",
      description:
        "Fait le bilan du serveur maintenant (il a lieu tout seul chaque semaine) : étudie le serveur (structure, icône, ~50 messages récents), réécrit ta fiche, et fait évoluer ta personnalité par petites touches. À utiliser quand on te le demande ou après un changement de style du serveur. Le résultat et un bouton pour l'annuler arrivent dans les logs.",
      inputSchema: z.object({}),
      run: async () => {
        if (!(await evolve(guild, `demandé par ${member.displayName}`))) throw new Error("Le bilan n'a pas pu se faire (déjà en cours, ou aucune IA n'a répondu).");
        const { profile } = await readMemory(guild.id);
        const personality = await getPersonality(guild);
        return `Bilan fait.\nFiche :\n${profile}\n\nPersonnalité (${personality.name}) :\n${personality.portrait}`;
      },
    }),
    tool({
      name: "set_personality",
      description:
        "Change ta personnalité quand un admin le demande (« sois plus sarcastique », « appelle-toi X », « parle comme un chevalier »). Réécris le portrait complet en y intégrant la demande et en gardant le reste ; 150 à 300 mots, à la 2e personne (« Tu es… »). Tes textes fixes seront réécrits dans ce ton, et ton pseudo sur le serveur suivra le nom.",
      inputSchema: z.object({
        name: z.string().min(1).max(32).describe("Ton nom (le même si on ne demande pas de le changer)"),
        portrait: z.string().min(50).max(3500),
      }),
      run: async ({ name, portrait }) => {
        await setPersonality(guild, { name, portrait }, `${user}`);
        return `Personnalité enregistrée : ${name}. Les textes fixes ont été réécrits dans ce ton.`;
      },
    }),
  ];
  return tools.filter((t) => member.permissions.has(REQUIRED[t.name] ?? PermissionFlagsBits.Administrator));
}
