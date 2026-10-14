import { AuditLogEvent, Events, time, type Client, type GuildBan } from "discord.js";
import { deletedByAutomod, moderate } from "./automod.ts";
import { log, LOG_CHANNEL_ID, logConsole } from "../core/log.ts";
import { isAllowedGuild } from "../core/server.ts";
import { announce, departureOf } from "../community/announces.ts";

const quote = (text: string) => `> ${text.slice(0, 800).replaceAll("\n", "\n> ")}`;
const fail = (error: Error) => logConsole("Logs", error.message);

// Journal classique d'un bot de modération, sans IA.
export function registerAuditLogs(client: Client): void {
  client.on(Events.GuildMemberAdd, (member) => {
    log(member.guild, "Membres", `📥 ${member.user} (${member.user.tag}) a rejoint le serveur. Compte créé ${time(member.user.createdAt, "R")}.`).catch(fail);
    if (isAllowedGuild(member.guild.id)) announce(member, "arrivee").catch(fail);
  });

  // Départ volontaire ou kick (le ban a son propre log plus bas), et l'annonce qui correspond.
  client.on(Events.GuildMemberRemove, (member) => {
    if (!isAllowedGuild(member.guild.id)) return;
    void (async () => {
      const { event, by, reason } = await departureOf(member);
      if (event === "kick") await log(member.guild, "Modération", `👢 Expulsé${by ? ` par ${by}` : ""} : ${member.user} (${member.user.tag})${reason ? ` : ${reason}` : ""}`);
      if (event === "depart") await log(member.guild, "Membres", `📤 ${member.user} (${member.user.tag}) a quitté le serveur.`);
      await announce(member, event);
    })().catch(fail);
  });

  // Le journal d'audit de Discord dit qui a banni et pourquoi, que ce soit via le bot ou l'interface Discord.
  const banLog = async (ban: GuildBan, type: AuditLogEvent.MemberBanAdd | AuditLogEvent.MemberBanRemove) => {
    const logs = await ban.guild.fetchAuditLogs({ type, limit: 5 }).catch(() => null);
    const entry = logs?.entries.find((e) => e.targetId === ban.user.id);
    const by = entry?.executor ? ` par ${entry.executor}` : "";
    const why = entry?.reason ? ` : ${entry.reason}` : "";
    const what = type === AuditLogEvent.MemberBanAdd ? "🔨 Banni" : "🕊️ Débanni";
    await log(ban.guild, "Modération", `${what}${by} : ${ban.user} (${ban.user.tag})${why}`);
  };
  client.on(Events.GuildBanAdd, (ban) => void banLog(ban, AuditLogEvent.MemberBanAdd).catch(fail));
  client.on(Events.GuildBanRemove, (ban) => void banLog(ban, AuditLogEvent.MemberBanRemove).catch(fail));

  client.on(Events.MessageDelete, (message) => {
    if (!message.inGuild() || message.author?.bot || message.channelId === LOG_CHANNEL_ID) return;
    if (deletedByAutomod.delete(message.id)) return;
    const content = message.content ? `\n${quote(message.content)}` : " (contenu inconnu : message envoyé avant le démarrage du bot)";
    log(message.guild, "Messages", `🗑️ Message de ${message.author ?? "auteur inconnu"} supprimé dans ${message.channel}${content}`).catch(fail);
  });

  client.on(Events.MessageUpdate, (before, after) => {
    if (!isAllowedGuild(after.guildId)) return;
    if (!after.inGuild() || after.author.bot || before.content === after.content) return;
    const previous = before.content ? quote(before.content) : "> (inconnu)";
    log(after.guild, "Messages", `✏️ ${after.author} a modifié son message dans ${after.channel}\nAvant :\n${previous}\nAprès :\n${quote(after.content)}\n${after.url}`).catch(fail);
    // Un message modifié repasse par l'automod : impossible de contourner la modération en éditant.
    moderate(after).catch((error: Error) => logConsole("Automod", error.message));
  });
}
