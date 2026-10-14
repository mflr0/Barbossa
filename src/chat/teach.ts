import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  PermissionFlagsBits,
  type ButtonInteraction,
  type Message,
} from "discord.js";
import { log } from "../core/log.ts";
import { addNote, readJson, withLock, writeJson } from "../core/memory.ts";

// Ce qu'un membre apprend au bot sur le serveur : l'IA le reformule pendant la discussion (sans appel en plus),
// un officier le valide d'un clic dans le salon de logs, puis le bot le connaît dans toutes ses réponses.
interface Proposal {
  id: string;
  text: string;
  authorId: string;
  at: number;
}

const FILE = "a-valider.json";
const MAX_PENDING = 50;

export async function proposeKnowledge(message: Message<true>, text: string): Promise<void> {
  const proposal = await withLock(`${message.guildId}/${FILE}`, async () => {
    const pending = await readJson<Proposal[]>(message.guildId, FILE, []);
    if (pending.some((p) => p.text.toLowerCase() === text.toLowerCase())) return null;
    const created: Proposal = { id: Date.now().toString(36), text, authorId: message.author.id, at: Date.now() };
    await writeJson(message.guildId, FILE, [...pending, created].slice(-MAX_PENDING));
    return created;
  });
  if (!proposal) return;
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`teach:ok:${proposal.id}`).setLabel("Retenir").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`teach:no:${proposal.id}`).setLabel("Refuser").setEmoji("🗑️").setStyle(ButtonStyle.Secondary),
  );
  await log(message.guild, "Mémoire", `📚 ${message.author} veut apprendre au bot : « ${text} »\n${message.url}`, [buttons]);
}

// Boutons « Retenir » / « Refuser » sous une proposition dans le salon de logs.
export async function handleTeachComponent(interaction: ButtonInteraction<"cached">): Promise<void> {
  if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "Réservé aux admins.", flags: MessageFlags.Ephemeral });
    return;
  }
  const [, action, id] = interaction.customId.split(":");
  // Retirée de la file sous verrou : deux admins qui cliquent en même temps ne la traitent pas deux fois.
  const proposal = await withLock(`${interaction.guildId}/${FILE}`, async () => {
    const pending = await readJson<Proposal[]>(interaction.guildId, FILE, []);
    const found = pending.find((p) => p.id === id);
    if (found) await writeJson(interaction.guildId, FILE, pending.filter((p) => p.id !== id));
    return found ?? null;
  });
  if (!proposal) {
    await interaction.update({ content: `${interaction.message.content}\n(déjà traité)`, components: [] });
    return;
  }
  if (action === "ok") await addNote(interaction.guildId, proposal.text);
  const verdict = action === "ok" ? `✅ Retenu par ${interaction.user}` : `🗑️ Refusé par ${interaction.user}`;
  await interaction.update({ content: `${interaction.message.content}\n${verdict}`, components: [] });
}
