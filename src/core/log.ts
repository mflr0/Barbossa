import { EmbedBuilder, type BaseMessageOptions, type Guild } from "discord.js";

export const LOG_CHANNEL_ID = process.env.MOD_LOG_CHANNEL_ID;

// Prix en $ par million de tokens (entrée, sortie), pour estimer le coût de chaque appel dans la console.
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
  "gpt-6-luna": [0.1, 0.5],
  "gemini-3.5-flash-lite": [0.3, 2.5],

export function logConsole(scope: string, text: string): void {
  console.log(`[${new Date().toLocaleString("fr-FR")}] [${scope}] ${text.replaceAll("\n", " | ")}`);
}

// Chaque type de log a sa couleur et son titre dans le salon, pour s'y retrouver d'un coup d'œil.
const STYLES: Record<string, [string, number]> = {
  Cerveau: ["🧠 Cerveau", 0xc9a227],
  Personnalité: ["🎭 Personnalité", 0xe91e63],
  Bilan: ["🌱 Bilan", 0x27ae60],
  Discussion: ["💬 Discussion", 0x5865f2],
  Action: ["🛠️ Action", 0xe67e22],
  Automod: ["🚨 Automod", 0xe74c3c],
  Modération: ["⚖️ Modération", 0xc0392b],
  Mémoire: ["📚 Mémoire", 0x9b59b6],
  Réflexes: ["⚡ Réflexes", 0x1abc9c],
  Budget: ["💰 Budget", 0xf1c40f],
  Commande: ["⌨️ Commande", 0x95a5a6],
  Commandes: ["⌨️ Commandes", 0x95a5a6],
  Membres: ["👥 Membres", 0x2ecc71],
  Messages: ["✏️ Messages", 0x7f8c8d],
  Erreur: ["❌ Erreur", 0x992d22],
};

// Journal sans IA : console + salon de logs Discord (si MOD_LOG_CHANNEL_ID est configuré).
// components : boutons optionnels sous le message de log (ex. « Oublier ce réflexe »).
export async function log(guild: Guild, scope: string, text: string, components?: BaseMessageOptions["components"]): Promise<void> {
  logConsole(scope, text);
  const channel = LOG_CHANNEL_ID ? guild.channels.cache.get(LOG_CHANNEL_ID) : undefined;
  if (!channel?.isSendable()) return;
  await channel
    .send({ embeds: [embedFor(scope, text)], allowedMentions: { parse: [] }, components })
    .catch((error: Error) => logConsole("Logs", `envoi dans le salon de logs impossible : ${error.message}`));
}

// Dernière ligne d'un log : qui a répondu (modèle d'IA, réflexe…), en petit sous le message.
export const provider = (by: string): string => `\n> -# provider: ${by}`;

function embedFor(scope: string, text: string): EmbedBuilder {
  const [title, color] = STYLES[scope] ?? [scope, 0x99aab5];
  return new EmbedBuilder().setAuthor({ name: title }).setColor(color).setDescription(text.slice(0, 4000)).setTimestamp();
}

// Suffixe des usages sur un fournisseur gratuit (offre gratuite) : comptés à 0 $.
export const FREE_SCOPE = " (gratuit)";

export function logUsage(scope: string, model: string, usage: { input_tokens: number; output_tokens: number }): void {
  const [input, output] = scope.endsWith(FREE_SCOPE) ? [0, 0] : (PRICES[model] ?? [0, 0]);
  const cost = (usage.input_tokens * input + usage.output_tokens * output) / 1_000_000;
  spent.set(scope, spentFor(scope) + cost);
  logConsole("API", `${scope} · ${model} · ${usage.input_tokens} in / ${usage.output_tokens} out · ~${cost.toFixed(5)} $`);
}
