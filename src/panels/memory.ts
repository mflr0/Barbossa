import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type StringSelectMenuInteraction,
  type User,
} from "discord.js";
import { botName } from "../core/server.ts";
import { revokeButton } from "../core/consent.ts";
import { log } from "../core/log.ts";
import { countKnownMembers, forgetMember, listNotes, readJson, readMemberNotes, readMemory, removeNote } from "../core/memory.ts";

// /memoire : ce que le bot a en mémoire, sans IA.
// Un admin voit la mémoire du serveur (ou celle d'un membre) ; un membre ne voit que ce que le bot sait de lui.
export const memoryCommand = new SlashCommandBuilder()
  .setName("memoire")
  .setDescription("Voir ce que le bot a en mémoire")
  .addUserOption((o) => o.setName("membre").setDescription("Ce qu'il sait d'un membre (admins ; sinon, de toi)"))
  .setContexts(InteractionContextType.Guild);

async function serverPanel(guild: Guild) {
  const notes = await listNotes(guild.id);
  const { profile } = await readMemory(guild.id);
  const pending = (await readJson<unknown[]>(guild.id, "a-valider.json", [])).length;
  const known = await countKnownMembers(guild.id);

  const list = notes.map((note, i) => `**${i + 1}.** ${note.replace(/^- /, "")}`).join("\n");
  const embed = new EmbedBuilder()
    .setTitle(`🧠 Mémoire de ${botName(guild)}`)
    .setColor(0xc9a227)
    .setDescription(list.slice(0, 3500) || "Aucune info retenue sur le serveur pour l'instant.")
    .addFields(
      { name: "Fiche du serveur", value: profile ? `${profile.slice(0, 900)}${profile.length > 900 ? "…" : ""}` : `Aucune : demande « @${botName(guild)} fais le bilan du serveur ».` },
      { name: "En attente", value: `${pending} info(s) proposée(s) par des membres, à valider dans le salon de logs`, inline: true },
      { name: "Membres", value: `${known} membre(s) lui ont parlé d'eux · \`/memoire membre:@X\``, inline: true },
    );

  const components: ActionRowBuilder<StringSelectMenuBuilder>[] = [];
  if (notes.length) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId("mem:forget")
          .setPlaceholder("Oublier une info…")
          .addOptions(notes.slice(0, 25).map((note, i) => ({ label: `${i + 1}. ${note.replace(/^- /, "")}`.slice(0, 100), value: String(i) }))),
      ),
    );
  }
  return { content: "", embeds: [embed], components };
}

async function memberPanel(guild: Guild, user: User) {
  const notes = await readMemberNotes(guild.id, user.id);
  const embed = new EmbedBuilder()
    .setTitle(`🧠 Ce que ${botName(guild)} sait de ${user.displayName}`)
    .setColor(0xc9a227)
    .setDescription(notes.slice(0, 3500) || "Rien pour l'instant : il ne retient que ce que tu dis de toi, en lui parlant ou sur le serveur.");
  const components = notes
    ? [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(`mem:wipe:${user.id}`).setLabel("Tout oublier").setEmoji("🧹").setStyle(ButtonStyle.Danger),
        ),
      ]
    : [];
  // Retirer son accord (trois confirmations) : le bot ne répond plus à la personne et efface tout ce qu'il garde d'elle.
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(revokeButton(user.id)));
  return { content: "", embeds: [embed], components };
}

export async function showMemoryPanel(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  const isAdmin = interaction.memberPermissions.has(PermissionFlagsBits.Administrator);
  const target = interaction.options.getUser("membre");
  if (target && !isAdmin && target.id !== interaction.user.id) {
    await interaction.reply({ content: "Tu ne peux consulter que ce que le bot sait de toi.", flags: MessageFlags.Ephemeral });
    return;
  }
  const view = isAdmin && !target ? await serverPanel(interaction.guild) : await memberPanel(interaction.guild, target ?? interaction.user);
  await interaction.reply({ ...view, flags: MessageFlags.Ephemeral });
}

// Clics sur le panneau : oublier une info du serveur (admins), ou tout ce qu'il sait d'un membre (admins, ou le membre lui-même).
export async function handleMemoryComponent(interaction: ButtonInteraction<"cached"> | StringSelectMenuInteraction<"cached">): Promise<void> {
  const isAdmin = interaction.memberPermissions.has(PermissionFlagsBits.Administrator);
  const [, action, userId] = interaction.customId.split(":");

  if (action === "forget" && interaction.isStringSelectMenu()) {
    if (!isAdmin) return void (await interaction.reply({ content: "Réservé aux admins.", flags: MessageFlags.Ephemeral }));
    const removed = await removeNote(interaction.guildId, Number(interaction.values[0]));
    if (removed) await log(interaction.guild, "Mémoire", `🧹 ${interaction.user} a fait oublier au bot : ${removed.replace(/^- /, "")}`);
    await interaction.update(await serverPanel(interaction.guild));
    return;
  }

  if (action === "wipe" && userId) {
    if (!isAdmin && userId !== interaction.user.id) {
      return void (await interaction.reply({ content: "Tu ne peux effacer que ce que le bot sait de toi.", flags: MessageFlags.Ephemeral }));
    }
    await forgetMember(interaction.guildId, userId);
    const user = await interaction.client.users.fetch(userId);
    await interaction.update(await memberPanel(interaction.guild, user));
  }
}
