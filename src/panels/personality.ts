import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { evolve } from "../brain/evolution.ts";
import { log } from "../core/log.ts";
import {
  checkText,
  getPersonality,
  getVoice,
  rewriteVoice,
  setPersonality,
  setText,
  TEXT_KEYS,
  TEXT_USES,
  TEXTS,
  type TextKey,
} from "../core/personality.ts";

// /personnalite : voir et régler la personnalité du bot et ses textes fixes depuis Discord (admins).
export const personalityCommand = new SlashCommandBuilder()
  .setName("personnalite")
  .setDescription("Voir et régler la personnalité du bot et ses textes fixes")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setContexts(InteractionContextType.Guild);

async function panel(guild: Guild) {
  const personality = await getPersonality(guild);
  const voice = await getVoice(guild.id);
  const main = new EmbedBuilder()
    .setTitle(`🎭 ${personality.name}`)
    .setColor(0xe91e63)
    .setDescription(personality.portrait.slice(0, 4000))
    .setFooter({ text: "Le bilan de chaque semaine l'affine par petites touches · chaque bilan peut être annulé depuis les logs" });
  const texts = new EmbedBuilder()
    .setTitle("🗣️ Textes fixes (dits sans IA)")
    .setColor(0xe91e63)
    .setDescription(
      TEXT_KEYS.map((key) => `**${TEXT_USES[key]}**${voice[key] === TEXTS[key] ? " · neutre" : ""}\n${voice[key]}`)
        .join("\n")
        .slice(0, 4000),
    );
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("perso:edit").setLabel("Modifier la personnalité").setEmoji("✏️").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("perso:voice").setLabel("Réécrire les textes dans ce ton").setEmoji("🗣️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("perso:bilan").setLabel("Faire le bilan maintenant").setEmoji("🌱").setStyle(ButtonStyle.Secondary),
  );
  const select = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("perso:text")
      .setPlaceholder("✏️ Modifier un texte fixe…")
      .addOptions(TEXT_KEYS.map((key) => ({ label: TEXT_USES[key].slice(0, 100), description: voice[key].slice(0, 100), value: key }))),
  );
  return { content: "", embeds: [main, texts], components: [buttons, select] };
}

const input = (id: string, label: string, style: TextInputStyle, value: string, max: number, required = true) =>
  new ActionRowBuilder<TextInputBuilder>().addComponents(
    new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setValue(value).setMaxLength(max).setRequired(required),
  );

export async function showPersonalityPanel(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  await interaction.reply({ ...(await panel(interaction.guild)), flags: MessageFlags.Ephemeral });
}

export async function handlePersonalityPanel(
  interaction: ButtonInteraction<"cached"> | StringSelectMenuInteraction<"cached"> | ModalSubmitInteraction<"cached">,
): Promise<void> {
  if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "Réservé aux admins.", flags: MessageFlags.Ephemeral });
    return;
  }
  const guild = interaction.guild;
  const [, action, key] = interaction.customId.split(":");

  if (action === "edit" && interaction.isButton()) {
    const { name, portrait } = await getPersonality(guild);
    const modal = new ModalBuilder()
      .setCustomId("perso:save")
      .setTitle("Personnalité")
      .addComponents(input("name", "Nom (devient son pseudo)", TextInputStyle.Short, name, 32), input("portrait", "Portrait", TextInputStyle.Paragraph, portrait, 3500));
    return void (await interaction.showModal(modal));
  }
  if (action === "text" && interaction.isStringSelectMenu()) {
    const textKey = interaction.values[0] as TextKey;
    const modal = new ModalBuilder()
      .setCustomId(`perso:savetext:${textKey}`)
      .setTitle(TEXT_USES[textKey].slice(0, 45))
      .addComponents(input("text", "Texte (vide = revenir au texte neutre)", TextInputStyle.Paragraph, (await getVoice(guild.id))[textKey], 300, false));
    return void (await interaction.showModal(modal));
  }

  // Le reste peut prendre du temps (IA) : on accuse réception, puis on met le panneau à jour.
  if (action === "save" && interaction.isModalSubmit()) {
    await interaction.deferUpdate();
    const name = interaction.fields.getTextInputValue("name").trim();
    const portrait = interaction.fields.getTextInputValue("portrait").trim();
    await setPersonality(guild, { name, portrait }, `${interaction.user}`);
  } else if (action === "savetext" && interaction.isModalSubmit() && TEXT_KEYS.includes(key as TextKey)) {
    const textKey = key as TextKey;
    const text = interaction.fields.getTextInputValue("text").trim();
    const problem = text ? checkText(textKey, text) : null;
    if (problem) return void (await interaction.reply({ content: `⚠️ ${problem}\n> ${text}`, flags: MessageFlags.Ephemeral }));
    await interaction.deferUpdate();
    await setText(guild.id, textKey, text || null);
    await log(guild, "Personnalité", `🗣️ ${interaction.user} a ${text ? "modifié" : "remis au neutre"} le texte « ${TEXT_USES[textKey]} »${text ? ` : ${text}` : ""}`);
  } else if (action === "voice" && interaction.isButton()) {
    await interaction.deferUpdate();
    await rewriteVoice(guild, await getPersonality(guild));
  } else if (action === "bilan" && interaction.isButton()) {
    await interaction.deferUpdate();
    await evolve(guild, `demandé par ${interaction.member.displayName}`);
  } else return;
  await interaction.editReply(await panel(guild));
}
