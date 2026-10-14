import {
  ChannelType,
  PermissionFlagsBits,
  type Guild,
  type GuildMember,
  type Message,
  type NonThreadGuildBasedChannel,
  type Role,
} from "discord.js";
import { readMemberNotes } from "./memory.ts";

// Le seul serveur où le bot accepte de travailler (SERVER_ID dans .env) : ajouté ailleurs, il repart aussitôt,
// pour que personne ne puisse dépenser ton budget d'IA en l'invitant sur son propre serveur.
export const SERVER_ID = process.env.SERVER_ID;
// Le nom du bot sur le serveur (son pseudo, qui suit sa personnalité).
export const botName = (guild: Guild): string => guild.members.me?.displayName ?? guild.client.user.username;

export const isAllowedGuild = (guildId: string | null | undefined): boolean => Boolean(guildId) && guildId === SERVER_ID;

// Photo du serveur envoyée à l'IA : salons, rôles et leurs id, pour qu'elle sache où elle met les pieds
// et quelle est l'ambiance. viewer : on ne montre que les salons que ce membre (ou ce rôle) peut voir.
export function describeServer(guild: Guild, viewer?: GuildMember | Role): string {
  const lines = [`Serveur : ${guild.name}`];
  if (guild.description) lines.push(`Description : ${guild.description}`);
  lines.push("", "Salons :");
  const channels = guild.channels.cache
    .filter((c): c is NonThreadGuildBasedChannel => !c.isThread())
    .filter((c) => !viewer || Boolean(c.permissionsFor(viewer)?.has(PermissionFlagsBits.ViewChannel)))
    .sorted((a, b) => a.position - b.position);
  const label = (c: NonThreadGuildBasedChannel) => `${c.name} (id ${c.id}, ${ChannelType[c.type]})`;
  for (const channel of channels.values()) {
    if (channel.parentId) continue;
    lines.push(`- ${label(channel)}`);
    for (const child of channels.filter((c) => c.parentId === channel.id).values()) {
      lines.push(`  - ${label(child)}`);
    }
  }

  lines.push("", "Rôles (du plus haut au plus bas) :");
  for (const role of guild.roles.cache.sorted((a, b) => b.position - a.position).values()) {
    if (role.id === guild.id || role.managed) continue;
    lines.push(`- ${role.name} (id ${role.id}, ${role.hexColor})`);
  }
  const highest = guild.members.me?.roles.highest;
  if (highest) lines.push("", `Ton rôle le plus haut est « ${highest.name} » : tu ne peux gérer que les rôles et membres en dessous.`);
  return lines.join("\n");
}

const normalize = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function describeMember(member: GuildMember, label: string): Promise<string> {
  const roles = member.roles.cache
    .filter((r) => r.id !== member.guild.id)
    .sorted((a, b) => b.position - a.position)
    .map((r) => r.name)
    .slice(0, 5)
    .join(", ");
  const since = member.joinedAt?.toLocaleDateString("fr-FR", { month: "long", year: "numeric" }) ?? "date inconnue";
  const notes = (await readMemberNotes(member.guild.id, member.id)).replaceAll("\n", " ").slice(0, 600);
  return `- ${label}${member.displayName} (<@${member.id}>) : rôles ${roles || "aucun"} ; sur le serveur depuis ${since} ; ${notes ? `ce qu'il a dit de lui-même : ${notes}` : "ne t'a rien dit de lui-même"}`;
}

// Mini-fiches de la personne qui parle et des membres dont parle le message (mentionnés, ou cités par leur pseudo),
// pour que le bot ait de quoi répondre sans rien inventer. Tout vient du cache Discord et de la mémoire : aucune IA.
export async function describePeople(message: Message<true>, text: string): Promise<string> {
  const normalized = normalize(text);
  const cited = new Map<string, GuildMember>();
  for (const member of message.mentions.members?.values() ?? []) cited.set(member.id, member);
  for (const member of message.guild.members.cache.values()) {
    const named = [member.displayName, member.user.username].some((name) => {
      const n = normalize(name);
      return n.length >= 4 && new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(n)}($|[^\\p{L}\\p{N}])`, "u").test(normalized);
    });
    if (named) cited.set(member.id, member);
  }
  const others = [...cited.values()].filter((m) => !m.user.bot && m.id !== message.author.id).slice(0, 3);
  const lines = message.member ? [await describeMember(message.member, "la personne qui te parle, ")] : [];
  for (const member of others) lines.push(await describeMember(member, ""));
  return lines.join("\n");
}
