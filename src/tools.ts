import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  ComponentType,
  PermissionFlagsBits,
  type Guild,
  type Message,
  type PermissionsString,
  type User,
} from "discord.js";
import { z } from "zod";
import { log } from "./log.ts";
import { addNote } from "./memory.ts";

// Qui donne l'ordre, sur quel serveur, et comment lui demander confirmation.
export interface ToolContext {
  guild: Guild;
  user: User;
  confirm: (question: string) => Promise<boolean>;
}

const snowflake = z
  .string()
  .regex(/^\d+$/)
  .describe("Identifiant Discord : les chiffres dans <@…>, <@&…> ou <#…>");

// Toutes les permissions Discord sauf Administrateur, que Barbossa n'accorde jamais.
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

// Les outils que Claude peut appeler pour exécuter un ordre ou une demande en discussion.
// Une erreur levée dans un outil est renvoyée à Claude, qui l'explique à l'admin.
export function buildTools({ guild, user, confirm }: ToolContext) {
  const reason = `Ordre de ${user.tag} via Barbossa`;
  // Chaque action (ou annulation) est journalisée dans la console et le salon de logs.
  const done = async (text: string) => {
    await log(guild, "Action", `🛠️ ${text} (demandé par ${user})`);
    return text;
  };

  return [
    betaZodTool({
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

    betaZodTool({
      name: "delete_channel",
      description: "Supprime un salon ou une catégorie. L'admin doit confirmer.",
      inputSchema: z.object({ channel_id: snowflake }),
      run: async ({ channel_id }) => {
        const channel = await guild.channels.fetch(channel_id);
        if (!channel) throw new Error("Salon introuvable");
        if (!(await confirm(`Supprimer le salon **${channel.name}** ?`))) {
          return done("L'admin a annulé la suppression.");
        }
        await channel.delete(reason);
        return done(`Salon ${channel.name} supprimé.`);
      },
    }),

    betaZodTool({
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

    betaZodTool({
      name: "delete_role",
      description: "Supprime un rôle. L'admin doit confirmer.",
      inputSchema: z.object({ role_id: snowflake }),
      run: async ({ role_id }) => {
        const role = await guild.roles.fetch(role_id);
        if (!role) throw new Error("Rôle introuvable");
        if (!(await confirm(`Supprimer le rôle **${role.name}** ?`))) {
          return done("L'admin a annulé la suppression.");
        }
        await role.delete(reason);
        return done(`Rôle ${role.name} supprimé.`);
      },
    }),

    betaZodTool({
      name: "give_role",
      description: "Donne un rôle à un membre.",
      inputSchema: z.object({ user_id: snowflake, role_id: snowflake }),
      run: async ({ user_id, role_id }) => {
        const member = await guild.members.fetch(user_id);
        await member.roles.add(role_id, reason);
        return done(`Rôle <@&${role_id}> donné à ${member}.`);
      },
    }),

    betaZodTool({
      name: "timeout_member",
      description: "Réduit un membre au silence pour une durée donnée (timeout Discord).",
      inputSchema: z.object({
        user_id: snowflake,
        minutes: z.number().int().min(1).max(40320).describe("Durée en minutes (max 28 jours)"),
        why: z.string().describe("Raison, visible dans le journal d'audit"),
      }),
      run: async ({ user_id, minutes, why }) => {
        const member = await guild.members.fetch(user_id);
        await member.timeout(minutes * 60_000, `${why} (${reason})`);
        return done(`${member} réduit au silence pour ${minutes} min.`);
      },
    }),

    betaZodTool({
      name: "ban_member",
      description: "Bannit un membre du serveur. L'admin doit confirmer.",
      inputSchema: z.object({
        user_id: snowflake,
        why: z.string().describe("Raison, visible dans le journal d'audit"),
      }),
      run: async ({ user_id, why }) => {
        const target = await guild.client.users.fetch(user_id);
        if (!(await confirm(`Bannir **${target.tag}** ? Raison : ${why}`))) {
          return done("L'admin a annulé le bannissement.");
        }
        await guild.members.ban(user_id, { reason: `${why} (${reason})` });
        return done(`${target.tag} banni.`);
      },
    }),

    betaZodTool({
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
  ];
}
