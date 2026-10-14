import {
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
} from "discord.js";
import { log } from "./log.ts";

// Commandes de modération classiques, sans IA. Les bans et débans sont journalisés par audit.ts.
export const classicCommands = [
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Bannir un membre")
    .addUserOption((o) => o.setName("membre").setDescription("Membre à bannir").setRequired(true))
    .addStringOption((o) => o.setName("raison").setDescription("Raison").setMaxLength(400))
    .addIntegerOption((o) =>
      o.setName("effacer_jours").setDescription("Effacer ses messages des N derniers jours (0 à 7)").setMinValue(0).setMaxValue(7),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Débannir un utilisateur")
    .addStringOption((o) => o.setName("id").setDescription("Identifiant de l'utilisateur").setRequired(true))
    .addStringOption((o) => o.setName("raison").setDescription("Raison").setMaxLength(400))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Expulser un membre")
    .addUserOption((o) => o.setName("membre").setDescription("Membre à expulser").setRequired(true))
    .addStringOption((o) => o.setName("raison").setDescription("Raison").setMaxLength(400))
    .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName("timeout")
    .setDescription("Réduire un membre au silence (0 minute pour lever le silence)")
    .addUserOption((o) => o.setName("membre").setDescription("Membre visé").setRequired(true))
    .addIntegerOption((o) =>
      o.setName("minutes").setDescription("Durée en minutes (0 = lever, max 40320)").setRequired(true).setMinValue(0).setMaxValue(40320),
    )
    .addStringOption((o) => o.setName("raison").setDescription("Raison").setMaxLength(400))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .setContexts(InteractionContextType.Guild),
  new SlashCommandBuilder()
    .setName("clear")
    .setDescription("Supprimer les derniers messages du salon")
    .addIntegerOption((o) =>
      o.setName("nombre").setDescription("Nombre de messages (1 à 100)").setRequired(true).setMinValue(1).setMaxValue(100),
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setContexts(InteractionContextType.Guild),
];

// Le bot est plus haut que la plupart des membres : on vérifie que l'auteur de la commande
// est lui-même au-dessus de sa cible, sinon un modérateur pourrait sanctionner un supérieur via le bot.
function outranks(executor: GuildMember, target: GuildMember): boolean {
  if (executor.id === executor.guild.ownerId) return true;
  if (target.id === target.guild.ownerId) return false;
  return executor.roles.highest.comparePositionTo(target.roles.highest) > 0;
}

export async function handleClassicCommand(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  const reply = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });
  const reason = interaction.options.getString("raison") ?? "aucune raison donnée";
  const auditReason = `${reason} (par ${interaction.user.tag})`;
  const target = interaction.options.getMember("membre");
  if (target && !outranks(interaction.member, target)) {
    await reply("⛔ Tu ne peux pas sanctionner quelqu'un placé au même niveau que toi ou au-dessus.");
    return;
  }

  switch (interaction.commandName) {
    case "ban": {
      const user = interaction.options.getUser("membre", true);
      const days = interaction.options.getInteger("effacer_jours") ?? 0;
      await interaction.guild.members.ban(user, { reason: auditReason, deleteMessageSeconds: days * 86_400 });
      await reply(`🔨 ${user.tag} banni.`);
      return;
    }
    case "unban": {
      const id = interaction.options.getString("id", true).trim();
      const user = await interaction.guild.members.unban(id, auditReason);
      await reply(`🕊️ ${user?.tag ?? id} débanni.`);
      return;
    }
    case "kick": {
      if (!target) return void (await reply("Ce membre n'est pas sur le serveur."));
      await target.kick(auditReason);
      await log(interaction.guild, "Modération", `👢 ${interaction.user} a expulsé ${target.user} (${target.user.tag}) : ${reason}`);
      await reply(`👢 ${target.user.tag} expulsé.`);
      return;
    }
    case "timeout": {
      if (!target) return void (await reply("Ce membre n'est pas sur le serveur."));
      const minutes = interaction.options.getInteger("minutes", true);
      await target.timeout(minutes > 0 ? minutes * 60_000 : null, auditReason);
      const text = minutes > 0 ? `réduit ${target.user} au silence pour ${minutes} min` : `levé le silence de ${target.user}`;
      await log(interaction.guild, "Modération", `🔇 ${interaction.user} a ${text} : ${reason}`);
      await reply(`🔇 C'est fait : ${text}.`);
      return;
    }
    case "clear": {
      const channel = interaction.channel;
      if (!channel || !("bulkDelete" in channel)) return void (await reply("Impossible ici."));
      // Discord refuse de supprimer en masse les messages de plus de 14 jours : ils sont ignorés.
      const deleted = await channel.bulkDelete(interaction.options.getInteger("nombre", true), true);
      await log(interaction.guild, "Modération", `🧹 ${interaction.user} a supprimé ${deleted.size} messages dans ${channel}`);
      await reply(`🧹 ${deleted.size} messages supprimés.`);
      return;
    }
  }
}
