import { AuditLogEvent, type GuildMember, type PartialGuildMember } from "discord.js";
import { log, logConsole, provider } from "../core/log.ts";
import { LINK_OR_MENTION, readJson, withLock, writeJson } from "../core/memory.ts";

// Annonces d'arrivée et de départ, sans IA : l'IA rédige une fois une dizaine de messages par événement
// (outil announce_setup), puis le bot en tire un au hasard à chaque fois.
const FILE = "annonces.json";

export const EVENTS = ["arrivee", "depart", "kick", "ban"] as const;
export type AnnounceEvent = (typeof EVENTS)[number];

export interface Announce {
  channelId: string | null;
  messages: string[];
}

type Announces = Partial<Record<AnnounceEvent, Announce>>;

export async function getAnnounce(guildId: string, event: AnnounceEvent): Promise<Announce> {
  return (await readJson<Announces>(guildId, FILE, {}))[event] ?? { channelId: null, messages: [] };
}

export async function setAnnounce(guildId: string, event: AnnounceEvent, update: Partial<Announce>): Promise<Announce> {
  return withLock(`${guildId}/${FILE}`, async () => {
    const all = await readJson<Announces>(guildId, FILE, {});
    const next = { channelId: null, messages: [], ...all[event], ...update };
    await writeJson(guildId, FILE, { ...all, [event]: next });
    return next;
  });
}

// Chaque message doit nommer le membre ({membre}), sans lien ni mention.
export function checkMessage(message: string): string | null {
  if (!message.includes("{membre}")) return "Le message doit contenir {membre}.";
  if (LINK_OR_MENTION.test(message.replaceAll("{membre}", ""))) return "Pas de lien ni de mention dans le message.";
  return null;
}

export function checkAnnounce(messages: string[]): string | null {
  if (messages.length < 8) return "Écris au moins 8 messages différents.";
  const bad = messages.filter((m) => checkMessage(m));
  return bad.length ? `Chaque message doit contenir {membre}, sans lien ni mention : ${bad.join(" | ")}` : null;
}

// Départ volontaire, kick ou ban ? Discord ne le dit pas : on regarde le journal d'audit des dernières secondes.
export async function departureOf(member: GuildMember | PartialGuildMember): Promise<{ event: AnnounceEvent; by?: string; reason?: string }> {
  await new Promise((resolve) => setTimeout(resolve, 1500)); // le journal d'audit arrive un peu après l'événement
  const logs = await member.guild.fetchAuditLogs({ limit: 10 }).catch(() => null);
  const entry = logs?.entries.find(
    (e) =>
      e.targetId === member.id &&
      Date.now() - e.createdTimestamp < 15_000 &&
      (e.action === AuditLogEvent.MemberKick || e.action === AuditLogEvent.MemberBanAdd),
  );
  if (!entry) return { event: "depart" };
  return { event: entry.action === AuditLogEvent.MemberBanAdd ? "ban" : "kick", by: entry.executor?.toString(), reason: entry.reason ?? undefined };
}

export async function announce(member: GuildMember | PartialGuildMember, event: AnnounceEvent): Promise<void> {
  if (member.user.bot) return;
  const { channelId, messages } = await getAnnounce(member.guild.id, event);
  if (!channelId || !messages.length) return;
  const channel = member.guild.channels.cache.get(channelId);
  if (!channel?.isSendable()) return logConsole("Annonces", `salon ${channelId} introuvable ou fermé au bot`);
  // À l'arrivée, on mentionne le nouveau ; au départ, son pseudo en gras (il n'est plus là pour être mentionné).
  const who = event === "arrivee" ? `${member}` : `**${member.displayName ?? member.user.username}**`;
  const text = messages[Math.floor(Math.random() * messages.length)]!.replaceAll("{membre}", who).replaceAll("{serveur}", member.guild.name);
  const sent = await channel.send({ content: text, allowedMentions: { users: event === "arrivee" ? [member.id] : [] } });
  await log(member.guild, "Membres", `📣 Annonce (${event}) pour ${member} · ${sent.url}${provider("message préparé (sans IA)")}`);
}
