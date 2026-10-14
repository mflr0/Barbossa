import {
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import { runBarbossa, type Turn } from "./admin.ts";
import { log } from "./log.ts";
import { askConfirmation } from "./tools.ts";

// Nombre de messages du fil relus à chaque réponse : c'est la mémoire de la conversation.
const HISTORY_LIMIT = 40;

// /barbossa discuter : ouvre un fil privé où Barbossa répond à chaque message des officiers.
export async function startDiscussion(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  const channel = interaction.channel;
  if (channel?.type !== ChannelType.GuildText) {
    await interaction.reply({ content: "Lance la discussion depuis un salon textuel.", flags: MessageFlags.Ephemeral });
    return;
  }
  const thread = await channel.threads.create({
    name: `Barbossa × ${interaction.member.displayName}`,
    type: ChannelType.PrivateThread,
    invitable: false,
  });
  await thread.members.add(interaction.user.id);
  await thread.send(`${interaction.user}, je t'écoute. Écris tes messages dans ce fil.`);
  await interaction.reply({ content: `Fil ouvert : ${thread}`, flags: MessageFlags.Ephemeral });
  await log(interaction.guild, "Discussion", `💬 ${interaction.user} a ouvert une discussion avec Barbossa : ${thread}`);
}

// Répond à un message posté dans un fil de discussion ouvert par Barbossa.
// L'historique est relu depuis le fil : la conversation survit à un redémarrage du bot.
export async function handleThreadMessage(message: Message): Promise<void> {
  const thread = message.channel;
  if (!message.inGuild() || !thread.isThread() || thread.ownerId !== message.client.user.id) return;
  if (message.author.bot || !message.member?.permissions.has(PermissionFlagsBits.Administrator)) return;

  await thread.sendTyping();
  const fetched = await thread.messages.fetch({ limit: HISTORY_LIMIT });
  const turns: Turn[] = [...fetched.values()]
    .reverse()
    .filter((m) => m.content && !m.system)
    .map((m) =>
      m.author.id === message.client.user.id
        ? { role: "assistant", text: m.content }
        : { role: "user", text: `${m.member?.displayName ?? m.author.username} (${m.author}) : ${m.content}` },
    );
  // L'API exige que la conversation commence par un message de l'utilisateur.
  while (turns[0]?.role === "assistant") turns.shift();

  const text = await runBarbossa("discussion", turns, {
    guild: message.guild,
    user: message.author,
    confirm: (question) => askConfirmation((payload) => thread.send(payload), message.author.id, question),
  });
  await thread.send({ content: text, allowedMentions: { parse: [] } });
}
