import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  SlashCommandBuilder,
  time,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { log, logConsole } from "./log.ts";
import { forgetMember, readJson, withLock, writeJson } from "./memory.ts";
import { say } from "./personality.ts";

// Avant de répondre à quelqu'un (et donc d'envoyer ses messages à un fournisseur d'IA), le bot demande son accord :
// les conditions des fournisseurs réellement utilisés, et le stockage de ce qu'il retient de la personne.
const FILE = "consentements.json";
const VERSION = 2; // à augmenter si les conditions changent : tout le monde devra réaccepter
const PROMPT_COOLDOWN_MS = 10 * 60_000; // au plus une demande d'accord toutes les 10 min par personne

// Les conditions de tous les fournisseurs que le bot sait utiliser, qu'ils soient branchés ou non :
// changer de fournisseur dans .env ne demande pas de redemander l'accord à tout le monde.
const TERMS: { label: string; links: [string, string][] }[] = [
  {
    label: "Anthropic (Claude)",
    links: [
      ["Conditions commerciales", "https://www.anthropic.com/legal/commercial-terms"],
      ["Politique d'utilisation", "https://www.anthropic.com/legal/aup"],
      ["Confidentialité", "https://www.anthropic.com/legal/privacy"],
    ],
  },
  {
    label: "Google (Gemini)",
    links: [
      ["Conditions de l'API Gemini", "https://ai.google.dev/gemini-api/terms"],
      ["Conditions de Google", "https://policies.google.com/terms"],
      ["Confidentialité", "https://policies.google.com/privacy"],
    ],
  },
  {
    label: "OpenAI",
    links: [
      ["Contrat de services", "https://openai.com/policies/services-agreement/"],
      ["Politique d'utilisation", "https://openai.com/policies/usage-policies/"],
      ["Confidentialité", "https://openai.com/policies/privacy-policy/"],
    ],
  },
];

type Consents = Record<string, { version: number; at: string }>;

export async function hasConsented(guildId: string, userId: string): Promise<boolean> {
  return (await readJson<Consents>(guildId, FILE, {}))[userId]?.version === VERSION;
}

async function setConsent(guildId: string, userId: string, accepted: boolean): Promise<void> {
  await withLock(`${guildId}/${FILE}`, async () => {
    const consents = await readJson<Consents>(guildId, FILE, {});
    if (accepted) consents[userId] = { version: VERSION, at: new Date().toISOString() };
    else delete consents[userId];
    await writeJson(guildId, FILE, consents);
  });
}

// Retirer son accord efface tout ce que le bot garde sur la personne, sans retour possible : sa mémoire,
// ses propositions d'infos et ses réflexes en attente, et l'accord lui-même.
async function eraseMember(guildId: string, userId: string): Promise<void> {
  await forgetMember(guildId, userId);
  for (const file of ["a-valider.json", "reflexes-en-attente.json"]) {
    await withLock(`${guildId}/${file}`, async () => {
      const entries = await readJson<{ authorId: string }[]>(guildId, file, []);
      await writeJson(guildId, file, entries.filter((entry) => entry.authorId !== userId));
    });
  }
  await setConsent(guildId, userId, false);
}

// Les trois confirmations avant de retirer son accord.
const REVOKE_STEPS = [
  { text: "Je ne te répondrai plus, jusqu'à ce que tu acceptes à nouveau.", button: "Retirer mon accord (1/3)" },
  {
    text: "Tout ce que je garde sur toi sera **supprimé définitivement, sans récupération possible** : ce que j'ai retenu de toi, tes propositions d'infos et tes réflexes en attente.",
    button: "Oui, tout supprimer (2/3)",
  },
  {
    text: "Dernière confirmation. Les messages **déjà envoyés aux fournisseurs d'IA restent chez eux**, selon leurs conditions : pour les faire supprimer, il faut s'adresser à eux (liens dans `/cgu`). Les logs de modération du serveur restent aussi.",
    button: "Supprimer définitivement (3/3)",
  },
];

function revokeStep(userId: string, step: number) {
  const { text, button } = REVOKE_STEPS[step]!;
  const embed = new EmbedBuilder().setTitle(`⚠️ Retirer ton accord · étape ${step + 1}/3`).setColor(0xc0392b).setDescription(text);
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`consent:revoke${step + 1}:${userId}`).setLabel(button).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`consent:cancel:${userId}`).setLabel("Annuler").setStyle(ButtonStyle.Secondary),
  );
  return { content: "", embeds: [embed], components: [buttons] };
}

// Bouton qui lance les confirmations (dans /cgu et /memoire).
export const revokeButton = (userId: string) =>
  new ButtonBuilder().setCustomId(`consent:revoke0:${userId}`).setLabel("Retirer mon accord").setEmoji("🚫").setStyle(ButtonStyle.Secondary);

const lastPrompt = new Map<string, number>();

// Un message déclenché par une mention ne peut pas être privé : le bot répond par une ligne courte avec un bouton,
// et les conditions s'affichent en privé (embed) à la personne qui clique. La ligne disparaît une fois le choix fait.
export async function askConsent(message: Message<true>): Promise<void> {
  if (Date.now() - (lastPrompt.get(message.author.id) ?? 0) < PROMPT_COOLDOWN_MS) return;
  lastPrompt.set(message.author.id, Date.now());
  const button = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`consent:show:${message.author.id}:${message.id}`).setLabel("Lire et accepter").setEmoji("📜").setStyle(ButtonStyle.Primary),
  );
  const embed = new EmbedBuilder()
    .setTitle(await say(message.guildId, "consentTitle"))
    .setColor(0xc9a227)
    .setDescription(await say(message.guildId, "consentIntro", { membre: `${message.author}` }))
    .addFields(
      { name: "Pourquoi ?", value: "Tes messages partent chez un fournisseur d'IA (Google, Anthropic…), qui a ses propres conditions. Je ne t'y envoie pas sans ton accord." },
      { name: "Et ma mémoire ?", value: "Je retiens ce que tu dis de toi pour m'adapter à toi. Rien de sensible, et tu peux tout voir ou effacer avec `/memoire`." },
      { name: "Comment ?", value: "Clique sur le bouton : les conditions s'affichent pour toi seul, puis tu acceptes ou pas." },
    );
  await message.reply({ embeds: [embed], components: [button], allowedMentions: { parse: [], repliedUser: false } });
}

function termsEmbed(): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle("📜 Conditions d'utilisation")
    .setColor(0xc9a227)
    .setDescription(
      "En cliquant « J'accepte », tu acceptes les conditions d'utilisation des fournisseurs d'IA ci-dessous (et leurs contrats), ainsi que les données générées à partir de tes messages : par eux, et par le bot dans sa mémoire.",
    )
    .addFields(TERMS.map((t) => ({ name: t.label, value: t.links.map(([name, link]) => `[${name}](${link})`).join("\n"), inline: true })))
    .setFooter({ text: "Revoir ces conditions : /cgu · Consulter, effacer ou retirer ton accord : /memoire" });
}

const acceptButtons = (userId: string, messageId = "", promptId = "") =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`consent:yes:${userId}:${messageId}:${promptId}`).setLabel("J'accepte").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`consent:no:${userId}:${messageId}:${promptId}`).setLabel("Non merci").setStyle(ButtonStyle.Secondary),
  );

// /cgu : revoir les conditions à tout moment, et les accepter si ce n'est pas déjà fait.
export const cguCommand = new SlashCommandBuilder()
  .setName("cgu")
  .setDescription("Les conditions d'utilisation du bot et des fournisseurs d'IA")
  .setContexts(InteractionContextType.Guild);

export async function showTerms(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  const accepted = (await readJson<Consents>(interaction.guildId, FILE, {}))[interaction.user.id];
  const embed = termsEmbed();
  if (accepted?.version === VERSION) embed.addFields({ name: "Ton accord", value: `✅ Donné ${time(new Date(accepted.at), "R")}` });
  const components =
    accepted?.version === VERSION ? [new ActionRowBuilder<ButtonBuilder>().addComponents(revokeButton(interaction.user.id))] : [acceptButtons(interaction.user.id)];
  await interaction.reply({ embeds: [embed], components, flags: MessageFlags.Ephemeral });
}

// Boutons : « Lire et accepter » (public), puis « J'accepte » / « Non merci » (privés). Seule la personne concernée peut cliquer.
export async function handleConsentComponent(
  interaction: ButtonInteraction<"cached">,
  answer: (message: Message<true>) => Promise<void>,
): Promise<void> {
  const [, choice, userId, messageId, promptId] = interaction.customId.split(":");
  if (interaction.user.id !== userId) {
    await interaction.reply({ content: `Ce choix appartient à <@${userId}>.`, flags: MessageFlags.Ephemeral });
    return;
  }
  // revoke0 ouvre les confirmations, revoke1 et revoke2 passent à la suivante, revoke3 efface.
  const step = choice?.startsWith("revoke") ? Number(choice.slice(6)) : -1;
  if (step >= 0 && step < 3) {
    const view = revokeStep(userId, step);
    await (step === 0 ? interaction.reply({ ...view, flags: MessageFlags.Ephemeral }) : interaction.update(view));
    return;
  }
  if (step === 3) {
    await eraseMember(interaction.guildId, userId);
    await log(interaction.guild, "Mémoire", `🚫 ${interaction.user} a retiré son accord : tout ce que le bot gardait sur lui a été effacé.`);
    await interaction.update({ content: await say(interaction.guildId, "consentRevoked"), embeds: [], components: [] });
    return;
  }
  if (choice === "cancel") {
    await interaction.update({ content: "Rien n'a changé, ton accord tient toujours.", embeds: [], components: [] });
    return;
  }
  if (choice === "show") {
    await interaction.reply({ embeds: [termsEmbed()], components: [acceptButtons(userId, messageId, interaction.message.id)], flags: MessageFlags.Ephemeral });
    return;
  }
  // La ligne publique a fait son office.
  if (promptId) await interaction.channel?.messages.delete(promptId).catch(() => {});
  if (choice !== "yes") {
    await interaction.update({ content: await say(interaction.guildId, "consentDeclined"), embeds: [], components: [] });
    return;
  }
  await setConsent(interaction.guildId, interaction.user.id, true);
  logConsole("Accord", `${interaction.user.tag} a accepté les conditions (version ${VERSION})`);
  await interaction.update({ content: await say(interaction.guildId, messageId ? "consentAccepted" : "consentAcceptedLater"), embeds: [], components: [] });
  const original = messageId && interaction.channel ? await interaction.channel.messages.fetch(messageId).catch(() => null) : null;
  if (original?.inGuild()) await answer(original);
}
