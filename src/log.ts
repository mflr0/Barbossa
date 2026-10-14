import type { Guild } from "discord.js";

export const LOG_CHANNEL_ID = process.env.MOD_LOG_CHANNEL_ID;

// Prix en $ par million de tokens (entrée, sortie), pour estimer le coût de chaque appel dans la console.
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
  "claude-opus-5-5": [4, 20],
};

export function logConsole(scope: string, text: string): void {
  console.log(`[${new Date().toLocaleString("fr-FR")}] [${scope}] ${text.replaceAll("\n", " | ")}`);
}

// Journal sans IA : console + salon de logs Discord (si MOD_LOG_CHANNEL_ID est configuré).
export async function log(guild: Guild, scope: string, text: string): Promise<void> {
  logConsole(scope, text);
  const channel = LOG_CHANNEL_ID ? guild.channels.cache.get(LOG_CHANNEL_ID) : undefined;
  if (!channel?.isSendable()) return;
  await channel
    .send({ content: text.slice(0, 2000), allowedMentions: { parse: [] } })
    .catch((error: Error) => logConsole("Logs", `envoi dans le salon de logs impossible : ${error.message}`));
}

export function logUsage(scope: string, model: string, usage: { input_tokens: number; output_tokens: number }): void {
  const [input, output] = PRICES[model] ?? [0, 0];
  const cost = (usage.input_tokens * input + usage.output_tokens * output) / 1_000_000;
  logConsole("API", `${scope} · ${model} · ${usage.input_tokens} in / ${usage.output_tokens} out · ~${cost.toFixed(5)} $`);
}
