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
  type Guild,
} from "discord.js";
import { botName } from "./server.ts";
import { describeProviders, firstAnswer, isFree, providers, type Answer } from "../ai/index.ts";
import type { Provider } from "../ai/tool.ts";
import { log } from "./log.ts";
import { readJson, withLock, writeJson } from "./memory.ts";

// Un seul budget d'IA payante : un plafond en $ par jour, partagé par tout le monde (membres comme officiers).
// Personne ne peut en utiliser plus d'un quart, sauf le propriétaire du bot (OWNER_ID dans .env), seul à pouvoir
// changer le plafond depuis /status. Les réflexes et les fournisseurs gratuits ne comptent pas.
const OWNER_ID = process.env.OWNER_ID;
const TIMEZONE = process.env.TIMEZONE || "Europe/Paris";
const DEFAULT_DAILY_BUDGET = Number(process.env.CHAT_DAILY_BUDGET || 0.3);
const SHARE = 0.25; // part maximale du budget du jour pour une même personne
const BUDGET_STEP = 0.1;

interface Limits {
  dailyBudget: number;
}

interface Usage {
  date: string;
  spent: number;
  perUserSpent: Record<string, number>;
}

export interface BudgetStatus {
  spent: number;
  dailyBudget: number;
  mine: number;
  share: number;
  owner: boolean;
  // Pourquoi les fournisseurs payants sont exclus pour cette personne, ou null s'ils sont permis.
  blocked: "budget" | "share" | null;
}

const today = () => new Intl.DateTimeFormat("fr-CA", { timeZone: TIMEZONE }).format(new Date()); // AAAA-MM-JJ

export const isOwner = (userId: string): boolean => Boolean(OWNER_ID) && userId === OWNER_ID;

async function getLimits(guildId: string): Promise<Limits> {
  return readJson<Limits>(guildId, "budget.json", { dailyBudget: DEFAULT_DAILY_BUDGET });
}

async function getUsage(guildId: string): Promise<Usage> {
  const usage = await readJson<Partial<Usage>>(guildId, "discussion-budget.json", {});
  return usage.date === today()
    ? { date: usage.date, spent: usage.spent ?? 0, perUserSpent: usage.perUserSpent ?? {} }
    : { date: today(), spent: 0, perUserSpent: {} };
}

export async function budgetStatus(guildId: string, userId: string): Promise<BudgetStatus> {
  const [usage, limits] = await Promise.all([getUsage(guildId), getLimits(guildId)]);
  const mine = usage.perUserSpent[userId] ?? 0;
  const share = limits.dailyBudget * SHARE;
  const owner = isOwner(userId);
  const blocked = owner ? null : usage.spent >= limits.dailyBudget ? "budget" : mine >= share ? "share" : null;
  return { spent: usage.spent, dailyBudget: limits.dailyBudget, mine, share, owner, blocked };
}

export const hasFreeProvider = (): boolean => providers.some(isFree);

// L'état réel du budget pour l'IA, pour qu'elle n'invente pas un « budget épuisé » lu dans les messages récents.
export function describeBudget(status: BudgetStatus, name: string): string {
  const limit = status.owner ? "sans limite (propriétaire du bot)" : `sur sa part de ${status.share.toFixed(3)} $`;
  return `Budget d'IA payante aujourd'hui : ${status.spent.toFixed(3)} $ dépensés sur ${status.dailyBudget} $ ; ${name} en a utilisé ${status.mine.toFixed(3)} $ ${limit}. Les réflexes et les fournisseurs gratuits ne comptent pas. Si on t'en parle, sois exact, et ne prétends jamais que le budget est épuisé s'il ne l'est pas.`;
}

// Interroge les fournisseurs (gratuits d'abord, payants seulement si le budget le permet) et compte la dépense.
export async function withBudget<T>(
  guildId: string,
  userId: string,
  status: BudgetStatus,
  label: string,
  call: (provider: Provider, scope: string) => Promise<T | null>,
  canRetry?: () => boolean,
): Promise<Answer<T> | null> {
  const answer = await firstAnswer(label, call, { allowPaid: !status.blocked, canRetry });
  if (answer && !isFree(answer.provider) && answer.cost > 0) {
    // Sous verrou : deux réponses simultanées ne s'effacent pas leur dépense.
    await withLock(`${guildId}/discussion-budget.json`, async () => {
      const usage = await getUsage(guildId);
      usage.spent += answer.cost;
      usage.perUserSpent[userId] = (usage.perUserSpent[userId] ?? 0) + answer.cost;
      await writeJson(guildId, "discussion-budget.json", usage);
    });
  }
  return answer;
}

// --- /status : l'état du bot et du budget, sans IA ---

// Jauge texte : 🟢 ▰▰▰▱▱▱▱▱▱▱▱▱ 25 %
function gauge(value: number, max: number, size = 12): string {
  const ratio = max > 0 ? Math.min(value / max, 1) : 1;
  const filled = Math.round(ratio * size);
  const color = ratio >= 1 ? "🔴" : ratio >= 0.75 ? "🟠" : "🟢";
  return `${color} ${"▰".repeat(filled)}${"▱".repeat(size - filled)} ${Math.round(ratio * 100)} %`;
}

const dollars = (amount: number) => `${amount.toFixed(amount < 0.1 ? 3 : 2).replace(".", ",")} $`;

export const statusCommand = new SlashCommandBuilder()
  .setName("status")
  .setDescription("État du bot : budget du jour, fournisseurs d'IA")
  .setContexts(InteractionContextType.Guild);

async function panel(guild: Guild, viewerId: string) {
  const [usage, me] = await Promise.all([getUsage(guild.id), budgetStatus(guild.id, viewerId)]);
  const top = Object.entries(usage.perUserSpent)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, spent], i) => `${["🥇", "🥈", "🥉", "4.", "5."][i]} <@${id}> · ${dollars(spent)}${spent >= me.share && !isOwner(id) ? " 🔇" : ""}`)
    .join("\n");

  const embed = new EmbedBuilder()
    .setTitle(`📊 État de ${botName(guild)}`)
    .setColor(me.spent >= me.dailyBudget ? 0xc0392b : 0xc9a227)
    .addFields(
      { name: "Budget du jour", value: `${gauge(me.spent, me.dailyBudget)}\n${dollars(me.spent)} sur ${dollars(me.dailyBudget)} · reste ${dollars(Math.max(me.dailyBudget - me.spent, 0))}` },
      { name: "Toi", value: me.owner ? "Illimité (propriétaire du bot)" : `${gauge(me.mine, me.share)}\n${dollars(me.mine)} sur ta part de ${dollars(me.share)} (un quart du budget)` },
      { name: "Les plus bavards", value: top || "Personne n'a encore utilisé d'IA payante aujourd'hui." },
      { name: "Bot", value: `En ligne depuis ${time(new Date(Date.now() - process.uptime() * 1000), "R")}\nIA : ${describeProviders()}`.slice(0, 1024) },
    );

  // Les boutons ne s'affichent qu'au propriétaire du bot (la réponse est privée), et sont revérifiés au clic.
  const components = me.owner
    ? [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId("budget:-").setLabel(`−${dollars(BUDGET_STEP)} par jour`).setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId("budget:+").setLabel(`+${dollars(BUDGET_STEP)} par jour`).setStyle(ButtonStyle.Primary),
        ),
      ]
    : [];
  return { content: "", embeds: [embed], components };
}

export async function showStatusPanel(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  await interaction.reply({ ...(await panel(interaction.guild, interaction.user.id)), flags: MessageFlags.Ephemeral });
}

export async function handleBudgetComponent(interaction: ButtonInteraction<"cached">): Promise<void> {
  if (!isOwner(interaction.user.id)) {
    await interaction.reply({ content: "Seul le propriétaire du bot peut changer le budget.", flags: MessageFlags.Ephemeral });
    return;
  }
  const direction = interaction.customId.endsWith("+") ? 1 : -1;
  const limits = await withLock(`${interaction.guildId}/budget.json`, async () => {
    const current = await getLimits(interaction.guildId);
    const next: Limits = { dailyBudget: Math.max(0, Math.round((current.dailyBudget + direction * BUDGET_STEP) * 100) / 100) };
    await writeJson(interaction.guildId, "budget.json", next);
    return next;
  });
  await log(interaction.guild, "Budget", `💰 ${interaction.user} a réglé le budget d'IA payante à ${dollars(limits.dailyBudget)} par jour`);
  await interaction.update(await panel(interaction.guild, interaction.user.id));
}
