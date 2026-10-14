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
} from "discord.js";
import { botName } from "../core/server.ts";
import { log } from "../core/log.ts";
import { readJson, withLock, writeJson } from "../core/memory.ts";
import { checkPattern, matchLength } from "../moderation/rules.ts";

// Réflexe : un type de message reconnu par des motifs, et des réponses toutes faites.
// Préparé par l'IA (ou appris pendant une discussion), puis servi aux membres sans IA.
export interface Reflex {
  id: string;
  label: string;
  patterns: string[];
  replies: string[];
  learned: boolean;
}

const FILE = "reflexes.json";
const MAX_REFLEXES = 200;
const PAGE_SIZE = 20;
// Phrase hors sujet : un motif de réflexe qui la reconnaît est trop large.
const UNRELATED = "Le chat de la voisine mange des croquettes au saumon.";
const cache = new Map<string, Reflex[]>();

export async function getReflexes(guildId: string): Promise<Reflex[]> {
  let reflexes = cache.get(guildId);
  if (!reflexes) {
    reflexes = await readJson<Reflex[]>(guildId, FILE, []);
    cache.set(guildId, reflexes);
  }
  return reflexes;
}

async function save(guildId: string, reflexes: Reflex[]): Promise<void> {
  await writeJson(guildId, FILE, reflexes);
  cache.set(guildId, reflexes);
}

// Vérifie un réflexe proposé par l'IA. Renvoie la liste des problèmes, vide s'il est valide.
export function checkReflex({ patterns, replies, examples }: { patterns: string[]; replies: string[]; examples: string[] }): string[] {
  const problems: string[] = [];
  if (!patterns.length) problems.push("aucun motif");
  if (!replies.length) problems.push("aucune réponse");
  for (const pattern of patterns) {
    const problem = checkPattern(pattern, UNRELATED);
    if (problem) problems.push(`« ${pattern} » : ${problem}`);
  }
  if (!problems.length) {
    const missed = examples.filter((example) => matchLength(patterns, example) < 0);
    if (missed.length) problems.push(`exemples non reconnus : ${missed.join(" | ")}`);
  }
  return problems;
}

// Ajoute un réflexe, ou remplace celui qui porte le même intitulé (en gardant son id).
// Chaque modification lit puis réécrit le fichier sous verrou : deux changements simultanés ne s'écrasent pas.
const lockReflexes = <T>(guildId: string, fn: () => Promise<T>) => withLock(`${guildId}/${FILE}`, fn);

export async function addReflex(guildId: string, draft: Omit<Reflex, "id">): Promise<Reflex> {
  return lockReflexes(guildId, async () => {
    const reflexes = await getReflexes(guildId);
    const existing = reflexes.find((r) => r.label.toLowerCase() === draft.label.toLowerCase());
    if (!existing && reflexes.length >= MAX_REFLEXES) throw new Error(`limite de ${MAX_REFLEXES} réflexes atteinte`);
    const id = existing?.id ?? `x${Math.max(0, ...reflexes.map((r) => Number(r.id.slice(1)) || 0)) + 1}`;
    const reflex: Reflex = { id, ...draft };
    await save(guildId, existing ? reflexes.map((r) => (r.id === id ? reflex : r)) : [...reflexes, reflex]);
    return reflex;
  });
}

// Ajoute des motifs à un réflexe existant : une nouvelle façon de dire la même chose, servie avec les mêmes réponses.
export async function extendReflex(guildId: string, id: string, patterns: string[]): Promise<Reflex | null> {
  return lockReflexes(guildId, async () => {
    const reflexes = await getReflexes(guildId);
    const reflex = reflexes.find((r) => r.id === id);
    if (!reflex) return null;
    const extended: Reflex = { ...reflex, patterns: [...new Set([...reflex.patterns, ...patterns])].slice(0, MAX_PATTERNS) };
    await save(guildId, reflexes.map((r) => (r.id === id ? extended : r)));
    return extended;
  });
}

// --- Réflexes en attente : appris une première fois, activés seulement quand un autre membre y revient ---

interface Candidate {
  label: string;
  patterns: string[];
  replies: string[];
  authorId: string;
  at: number;
}

const CANDIDATES_FILE = "reflexes-en-attente.json";
const CANDIDATE_TTL_MS = 14 * 24 * 3_600_000;
const MAX_CANDIDATES = 100;
const MAX_PATTERNS = 20;

export async function getCandidates(guildId: string): Promise<Candidate[]> {
  const candidates = await readJson<Candidate[]>(guildId, CANDIDATES_FILE, []);
  return candidates.filter((c) => Date.now() - c.at < CANDIDATE_TTL_MS);
}

const lockCandidates = <T>(guildId: string, fn: () => Promise<T>) => withLock(`${guildId}/${CANDIDATES_FILE}`, fn);

export async function addCandidate(guildId: string, candidate: Candidate): Promise<void> {
  await lockCandidates(guildId, async () => {
    const candidates = await getCandidates(guildId);
    await writeJson(guildId, CANDIDATES_FILE, [...candidates, candidate].slice(-MAX_CANDIDATES));
  });
}

// Un autre membre envoie un message qu'un réflexe en attente reconnaît : le sujet revient vraiment,
// on l'active. Un membre seul ne peut donc pas imposer un réflexe.
export async function promoteCandidate(guildId: string, text: string, authorId: string): Promise<Reflex | null> {
  const candidate = await lockCandidates(guildId, async () => {
    const candidates = await getCandidates(guildId);
    const found = candidates.find((c) => c.authorId !== authorId && matchLength(c.patterns, text) >= 0);
    if (found) await writeJson(guildId, CANDIDATES_FILE, candidates.filter((c) => c !== found));
    return found ?? null;
  });
  if (!candidate) return null;
  return addReflex(guildId, { label: candidate.label, patterns: candidate.patterns, replies: candidate.replies, learned: true });
}

export async function deleteReflex(guildId: string, id: string): Promise<Reflex | null> {
  return lockReflexes(guildId, async () => {
    const reflexes = await getReflexes(guildId);
    const reflex = reflexes.find((r) => r.id === id) ?? null;
    if (reflex) await save(guildId, reflexes.filter((r) => r.id !== id));
    return reflex;
  });
}

// Le réflexe dont un motif reconnaît le plus long passage du message : le plus spécifique gagne,
// pour qu'un « salut, comment avoir un rôle ? » tombe sur le réflexe des rôles et pas sur celui des saluts.
export async function findReflex(guildId: string, text: string): Promise<Reflex | null> {
  let best: Reflex | null = null;
  let bestLength = -1;
  for (const reflex of await getReflexes(guildId)) {
    const length = matchLength(reflex.patterns, text);
    if (length > bestLength) {
      best = reflex;
      bestLength = length;
    }
  }
  return best;
}

export function fillReply(reflex: Reflex, vars: { membre: string; serveur: string }): string {
  const reply = reflex.replies[Math.floor(Math.random() * reflex.replies.length)] ?? "";
  return reply.replaceAll("{membre}", vars.membre).replaceAll("{serveur}", vars.serveur);
}

// --- Panneau /reflexes : voir et supprimer les réflexes, sans IA ---

export const reflexesCommand = new SlashCommandBuilder()
  .setName("reflexes")
  .setDescription("Voir et gérer les réflexes de discussion (réponses sans IA)")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setContexts(InteractionContextType.Guild);

async function panel(guild: Guild, requestedPage: number) {
  const reflexes = await getReflexes(guild.id);
  const pages = Math.max(1, Math.ceil(reflexes.length / PAGE_SIZE));
  const page = Math.min(Math.max(requestedPage, 0), pages - 1);
  const slice = reflexes.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const pending = (await getCandidates(guild.id)).length;
  const embed = new EmbedBuilder()
    .setTitle(`💬 Réflexes (${reflexes.length})`)
    .setColor(0xc9a227)
    .setFooter({ text: `Page ${page + 1}/${pages} · réponses servies sans IA · 🧠 = appris en discussion · ${pending} en attente d'une 2e demande` });
  if (!reflexes.length) embed.setDescription(`Aucun réflexe. Demande « @${botName(guild)} prépare tes réflexes pour discuter avec les membres ».`);
  for (const r of slice) {
    embed.addFields({
      name: `${r.id} · ${r.label}${r.learned ? " 🧠" : ""}`.slice(0, 256),
      value: `> ${(r.replies[0] ?? "").slice(0, 150)}\n${r.replies.length} variante(s), ${r.patterns.length} motif(s)`,
    });
  }

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];
  if (slice.length) {
    components.push(
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`reflex:ask:${page}`)
          .setPlaceholder("Supprimer un réflexe…")
          .addOptions(slice.map((r) => ({ label: `${r.id} · ${r.label}`.slice(0, 100), value: r.id }))),
      ),
    );
  }
  if (pages > 1) {
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`reflex:page:${page - 1}`).setLabel("◀").setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(`reflex:page:${page + 1}`).setLabel("▶").setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1),
      ),
    );
  }
  return { content: "", embeds: [embed], components };
}

export async function showReflexesPanel(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  await interaction.reply({ ...(await panel(interaction.guild, 0)), flags: MessageFlags.Ephemeral });
}

// Clics sur le panneau /reflexes, et sur le bouton « Oublier ce réflexe » des logs.
export async function handleReflexesComponent(
  interaction: ButtonInteraction<"cached"> | StringSelectMenuInteraction<"cached">,
): Promise<void> {
  if (!interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({ content: "Réservé aux admins.", flags: MessageFlags.Ephemeral });
    return;
  }
  const [, action, arg, page] = interaction.customId.split(":");

  if (action === "page") {
    await interaction.update(await panel(interaction.guild, Number(arg)));
    return;
  }
  if (action === "ask" && interaction.isStringSelectMenu()) {
    const id = interaction.values[0]!;
    const confirm = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(`reflex:delete:${id}:${arg}`).setLabel(`Supprimer ${id}`).setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`reflex:page:${arg}`).setLabel("Annuler").setStyle(ButtonStyle.Secondary),
    );
    await interaction.update({ content: `⚠️ Supprimer le réflexe **${id}** ?`, components: [confirm] });
    return;
  }

  const reflex = arg ? await deleteReflex(interaction.guildId, arg) : null;
  if (reflex) await log(interaction.guild, "Réflexes", `🗑️ ${interaction.user} a supprimé le réflexe ${reflex.id} « ${reflex.label} »`);
  if (action === "forget") {
    // Bouton sous un log « réflexe appris » : on met à jour le message de log.
    await interaction.update({ content: `${interaction.message.content}\n🗑️ Oublié par ${interaction.user}`, components: [] });
    return;
  }
  await interaction.update(await panel(interaction.guild, Number(page)));
}
