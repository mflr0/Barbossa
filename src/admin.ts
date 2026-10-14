import { existsSync, readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import {
  ChannelType,
  MessageFlags,
  type ChatInputCommandInteraction,
  type Guild,
  type NonThreadGuildBasedChannel,
} from "discord.js";
import { logUsage } from "./log.ts";
import { readMemory } from "./memory.ts";
import { askConfirmation, buildTools, type ToolContext } from "./tools.ts";

const anthropic = new Anthropic();
export const MODEL = process.env.ADMIN_MODEL || "claude-haiku-5-5";

// Facultatif : des consignes écrites à la main qui priment sur l'ambiance déduite du serveur.
const LORE_FILE = new URL("../lore.md", import.meta.url);
const LORE = existsSync(LORE_FILE) ? readFileSync(LORE_FILE, "utf8").trim() : "";

const PERSONA = `Tu es Barbossa, le bot d'administration de ce serveur Discord. Tu obéis aux administrateurs (les officiers).

Ambiance : aucun thème ne t'est imposé. Déduis-la du serveur tel qu'il est aujourd'hui (son nom, sa description, son icône, les noms, emojis et couleurs de ses salons et rôles, et ta fiche de mémoire si tu en as une), et adopte-la pour tout ce que tu inventes (noms, couleurs, sujets) et pour le ton de tes réponses. Si le serveur change de style, suis-le.

Règles :
- Les mentions Discord arrivent sous la forme <@id> (membre), <@&id> (rôle), <#id> (salon). Utilise ces id dans les outils.
- N'accorde à un rôle que les permissions utiles à la demande. Aucune permission de modération ou de gestion (bannir, expulser, gérer les rôles, les salons ou les messages…) sauf si on te le demande explicitement.
- Si une demande d'action est ambiguë (quel membre ? quel salon ?), n'agis pas : demande des précisions.
- Si un outil échoue, explique pourquoi en une phrase.
- Quand tu apprends quelque chose de durable et utile sur le serveur ou ses officiers (préférence, convention, décision), retiens-le avec l'outil remember. Jamais d'informations personnelles sensibles.
- Réponds en français.`;

const MODES = {
  ordre:
    "Un officier te donne un ordre : exécute-le avec tes outils, puis termine par un résumé court (2 à 4 phrases) de ce que tu as fait, dans le ton du serveur.",
  discussion:
    "Tu discutes avec un ou plusieurs officiers dans un fil Discord. Réponds de façon naturelle et concise, dans le ton du serveur. N'utilise tes outils d'action que si on te demande explicitement d'agir.",
};

export type Turn = { role: "user" | "assistant"; text: string };

// Photo du serveur envoyée à Claude : salons, rôles et leurs id, pour qu'il sache où il met les pieds
// et quelle est son ambiance.
export function describeServer(guild: Guild): string {
  const lines = [`Serveur : ${guild.name}`];
  if (guild.description) lines.push(`Description : ${guild.description}`);
  lines.push("", "Salons :");
  const channels = guild.channels.cache
    .filter((c): c is NonThreadGuildBasedChannel => !c.isThread())
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

async function systemPrompt(guild: Guild, mode: keyof typeof MODES): Promise<string> {
  const { profile, notes } = await readMemory(guild.id);
  return [
    PERSONA,
    LORE && `<consignes_du_capitaine>\n${LORE}\n</consignes_du_capitaine>\nCes consignes priment sur ce que tu déduis du serveur.`,
    profile &&
      `<fiche_du_serveur>\n${profile}\n</fiche_du_serveur>\nCette fiche vient de ta dernière découverte du serveur. Si la photo du serveur ci-dessous la contredit, c'est la photo qui a raison.`,
    notes && `<memoire>\n${notes}\n</memoire>`,
    `<photo_du_serveur>\n${describeServer(guild)}\n</photo_du_serveur>`,
    MODES[mode],
  ]
    .filter(Boolean)
    .join("\n\n");
}

// Fait tourner Claude avec ses outils sur un échange (un ordre, ou l'historique d'une discussion)
// et renvoie le texte à afficher.
export async function runBarbossa(mode: keyof typeof MODES, turns: Turn[], ctx: ToolContext): Promise<string> {
  // L'icône du serveur aide Claude à saisir sa direction artistique (≈ 100 tokens à cette taille).
  const icon = ctx.guild.iconURL({ extension: "png", size: 256 });
  const messages: Anthropic.Beta.BetaMessageParam[] = turns.map((turn, i) => ({
    role: turn.role,
    content:
      i === 0 && icon
        ? [
            { type: "image", source: { type: "url", url: icon } },
            { type: "text", text: turn.text },
          ]
        : turn.text,
  }));

  const runner = anthropic.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 16000,
    max_iterations: 10,
    output_config: { effort: "medium" },
    system: await systemPrompt(ctx.guild, mode),
    tools: buildTools(ctx),
    messages,
  });
  // Un tour par appel API : on journalise le coût de chacun dans la console.
  for await (const message of runner) logUsage(`Barbossa (${mode})`, MODEL, message.usage);
  const final = await runner.done();

  if (final.stop_reason === "refusal") return "🏴‍☠️ Barbossa refuse de répondre à ça.";
  if (final.stop_reason === "tool_use") {
    return "🌊 Barbossa s'est arrêté avant la fin : la demande demandait trop d'étapes. Découpe-la en plusieurs fois.";
  }
  const text = final.content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim();
  return text.slice(0, 2000) || "⚓ C'est fait.";
}

export async function handleOrder(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  const order = interaction.options.getString("texte", true);
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const text = await runBarbossa("ordre", [{ role: "user", text: `Ordre de ${interaction.user} :\n${order}` }], {
    guild: interaction.guild,
    user: interaction.user,
    confirm: (question) =>
      askConfirmation((payload) => interaction.followUp({ ...payload, flags: MessageFlags.Ephemeral }), interaction.user.id, question),
  });
  await interaction.editReply(text);
}
