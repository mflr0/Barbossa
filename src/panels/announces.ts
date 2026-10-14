import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
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
  type ChannelSelectMenuInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { botName } from "../core/server.ts";
import { log } from "../core/log.ts";
import { checkMessage, EVENTS, getAnnounce, setAnnounce, type AnnounceEvent } from "../community/announces.ts";

// /annonces : régler les annonces d'arrivée et de départ depuis Discord, sans IA.
export const announceCommand = new SlashCommandBuilder()
  .setName("annonces")
  .setDescription("Régler les annonces d'arrivée, de départ, de kick et de ban")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setContexts(InteractionContextType.Guild);

const LABELS: Record<AnnounceEvent, string> = { arrivee: "👋 Arrivée", depart: "📤 Départ", kick: "👢 Kick", ban: "🔨 Ban" };
const MAX_MESSAGES = 15;

async function panel(guild: Guild, event: AnnounceEvent) {
  const { channelId, messages } = await getAnnounce(guild.id, event);
  const list = messages.map((m, i) => `**${i + 1}.** ${m}`).join("\n");
  const embed = new EmbedBuilder()
    .setTitle(`📣 Annonces · ${LABELS[event]}`)
    .setColor(channelId ? 0x2ecc71 : 0x95a5a6)
    .setDescription(list.slice(0, 3800) || `Aucun message. Ajoute-en ici, ou demande « @${botName(guild)} écris 10 messages de ${event} ».`)
    .addFields({ name: "Salon", value: channelId ? `<#${channelId}> · active` : "aucun · désactivée", inline: true })
    .setFooter({ text: "Un message est tiré au hasard à chaque fois · {membre} = le membre · {serveur} = le nom du serveur" });

  const rows: ActionRowBuilder<StringSelectMenuBuilder | ChannelSelectMenuBuilder | ButtonBuilder>[] = [
    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId("annonce:event")
        .addOptions(EVENTS.map((e) => ({ label: LABELS[e], value: e, default: e === event }))),
    ),
    new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(`annonce:channel:${event}`)
        .setPlaceholder(channelId ? "Changer de salon…" : "Choisir le salon (active les annonces)…")
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
    ),
  ];
  const options = messages.slice(0, 25).map((m, i) => ({ label: `${i + 1}. ${m}`.slice(0, 100), value: String(i) }));
  if (options.length) {
    rows.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(`annonce:edit:${event}`).setPlaceholder("✏️ Modifier un message…").addOptions(options),
      ),
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(`annonce:delete:${event}`).setPlaceholder("🗑️ Supprimer un message…").addOptions(options),
      ),
    );
  }
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`annonce:add:${event}`)
      .setLabel("Ajouter un message")
      .setEmoji("➕")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(messages.length >= MAX_MESSAGES),
  );
  if (channelId) buttons.addComponents(new ButtonBuilder().setCustomId(`annonce:off:${event}`).setLabel("Désactiver").setStyle(ButtonStyle.Secondary));
  rows.push(buttons);
  return { content: "", embeds: [embed], components: rows };
}

function editor(event: AnnounceEvent, index: number | null, value = "") {
  const input = new TextInputBuilder()
    .setCustomId("text")
    .setLabel("Message ({membre} obligatoire)")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(400)
    .setRequired(true);
  if (value) input.setValue(value);
  return new ModalBuilder()
    .setCustomId(`annonce:save:${event}:${index ?? "new"}`)
    .setTitle(`${LABELS[event]} · ${index === null ? "nouveau message" : `message ${index + 1}`}`)
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
}

export async function showAnnouncePanel(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  await interaction.reply({ ...(await panel(interaction.guild, "arrivee")), flags: MessageFlags.Ephemeral });
}

type PanelInteraction =
  | ButtonInteraction<"cached">
  | StringSelectMenuInteraction<"cached">
  | ChannelSelectMenuInteraction<"cached">
  | ModalSubmitInteraction<"cached">;

// Clics sur le panneau : changer d'événement, de salon, ajouter, modifier, supprimer un message, désactiver.
export async function handleAnnouncePanel(interaction: PanelInteraction): Promise<void> {
  if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "Réservé aux admins.", flags: MessageFlags.Ephemeral });
    return;
  }
  const [, action, rawEvent, rawIndex] = interaction.customId.split(":");
  const guild = interaction.guild;
  const event = (interaction.isStringSelectMenu() && action === "event" ? interaction.values[0] : rawEvent) as AnnounceEvent;
  if (!EVENTS.includes(event)) return;
  const refresh = async () => {
    const view = await panel(guild, event);
    if (interaction.isModalSubmit()) await interaction.editReply(view);
    else await interaction.update(view);
  };

  if (action === "event") return refresh();
  if (action === "channel" && interaction.isChannelSelectMenu()) {
    const channelId = interaction.values[0]!;
    await setAnnounce(guild.id, event, { channelId });
    await log(guild, "Membres", `📣 ${interaction.user} a mis les annonces « ${event} » dans <#${channelId}>`);
    return refresh();
  }
  if (action === "off") {
    await setAnnounce(guild.id, event, { channelId: null });
    await log(guild, "Membres", `📣 ${interaction.user} a désactivé les annonces « ${event} »`);
    return refresh();
  }
  if (action === "add" && interaction.isButton()) return void (await interaction.showModal(editor(event, null)));
  if (action === "edit" && interaction.isStringSelectMenu()) {
    const index = Number(interaction.values[0]);
    return void (await interaction.showModal(editor(event, index, (await getAnnounce(guild.id, event)).messages[index])));
  }
  if (action === "delete" && interaction.isStringSelectMenu()) {
    const { messages } = await getAnnounce(guild.id, event);
    const index = Number(interaction.values[0]);
    await setAnnounce(guild.id, event, { messages: messages.filter((_, i) => i !== index) });
    await log(guild, "Membres", `📣 ${interaction.user} a supprimé une annonce « ${event} » : ${messages[index]}`);
    return refresh();
  }
  if (action === "save" && interaction.isModalSubmit()) {
    const text = interaction.fields.getTextInputValue("text").trim();
    const problem = checkMessage(text);
    if (problem) return void (await interaction.reply({ content: `⚠️ ${problem}\n> ${text}`, flags: MessageFlags.Ephemeral }));
    await interaction.deferUpdate();
    const { messages } = await getAnnounce(guild.id, event);
    const index = rawIndex === "new" ? null : Number(rawIndex);
    const next = index === null ? [...messages, text].slice(0, MAX_MESSAGES) : messages.map((m, i) => (i === index ? text : m));
    await setAnnounce(guild.id, event, { messages: next });
    await log(guild, "Membres", `📣 ${interaction.user} a ${index === null ? "ajouté" : "modifié"} une annonce « ${event} » : ${text}`);
    return refresh();
  }
}
