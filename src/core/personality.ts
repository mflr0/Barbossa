import type { Guild } from "discord.js";
import { z } from "zod";
import { describeAnswer, firstAnswer } from "../ai/index.ts";
import { log, logConsole, provider } from "./log.ts";
import { readJson, withLock, writeJson } from "./memory.ts";

// La personnalité du bot sur un serveur : déduite de l'étude du serveur, affinée chaque semaine par le bilan,
// modifiable depuis Discord (/personnalite). Elle donne le ton de toutes les réponses de l'IA, et celui des textes
// fixes, réécrits une fois dans ce ton puis rejoués sans IA.
const FILE = "personnalite.json";
const VOICE_FILE = "voix.json";

export interface Personality {
  name: string;
  portrait: string;
}

const NEUTRAL_PORTRAIT =
  "Un membre de l'équipe du serveur plutôt qu'un assistant : sympathique, direct, avec de l'humour et de la répartie, sans en faire trop. Il adopte le vocabulaire, les références et l'univers du serveur.";

export async function getPersonality(guild: Guild): Promise<Personality> {
  const saved = await readJson<Partial<Personality> | null>(guild.id, FILE, null);
  return { name: saved?.name || guild.client.user.username, portrait: saved?.portrait || NEUTRAL_PORTRAIT };
}

export const hasPersonality = async (guildId: string): Promise<boolean> => Boolean(await readJson<unknown>(guildId, FILE, null));

// À placer dans les consignes de l'IA.
export function describePersonality({ name, portrait }: Personality): string {
  return `<personnalite>\nTu t'appelles ${name}.\n${portrait}\n</personnalite>\nGarde cette personnalité en permanence, y compris quand tu confirmes une action ou réponds à une question technique.`;
}

// Enregistre la personnalité, prend le nom comme pseudo sur le serveur, et réécrit les textes fixes dans ce ton.
export async function setPersonality(guild: Guild, personality: Personality, by: string): Promise<void> {
  const clean = { name: personality.name.trim().slice(0, 32), portrait: personality.portrait.trim().slice(0, 3500) };
  await withLock(`${guild.id}/${FILE}`, () => writeJson(guild.id, FILE, { ...clean, at: new Date().toISOString() }));
  const me = guild.members.me;
  if (me && me.displayName !== clean.name) {
    await me.setNickname(clean.name === guild.client.user.username ? null : clean.name).catch((error: Error) => logConsole("Personnalité", `pseudo impossible : ${error.message}`));
  }
  await log(guild, "Personnalité", `🎭 Personnalité mise à jour par ${by} : **${clean.name}**\n> ${clean.portrait.slice(0, 600).replaceAll("\n", "\n> ")}`);
  await rewriteVoice(guild, clean);
}

// Copie brute de la personnalité et des textes, pour pouvoir annuler un bilan.
export interface PersonalitySnapshot {
  personality: unknown;
  voice: unknown;
}

export async function snapshotPersonality(guildId: string): Promise<PersonalitySnapshot> {
  return { personality: await readJson<unknown>(guildId, FILE, null), voice: await readJson<unknown>(guildId, VOICE_FILE, null) };
}

export async function restorePersonality(guild: Guild, { personality, voice }: PersonalitySnapshot): Promise<void> {
  await withLock(`${guild.id}/${FILE}`, () => writeJson(guild.id, FILE, personality));
  await withLock(`${guild.id}/${VOICE_FILE}`, () => writeJson(guild.id, VOICE_FILE, voice ?? {}));
  const { name } = await getPersonality(guild);
  if (guild.members.me?.displayName !== name) await guild.members.me?.setNickname(name === guild.client.user.username ? null : name).catch(() => {});
}

// --- Textes fixes : ce que le bot dit sans IA. Neutres par défaut, réécrits une fois dans le ton de la personnalité. ---

export const TEXTS = {
  consentTitle: "Un accord avant de discuter",
  consentIntro: "{membre}, pour te répondre, je fais appel à une intelligence artificielle.",
  consentAccepted: "C'est noté. Je te réponds.",
  consentAcceptedLater: "C'est noté, tu peux me parler.",
  consentDeclined: "Pas de souci, je ne te répondrai pas. Mentionne-moi si tu changes d'avis.",
  consentRevoked: "C'est fait : ton accord est retiré et tout ce que je gardais sur toi est effacé.",
  budgetShare: "Tu as utilisé ta part du budget d'IA du jour. Les réponses toutes prêtes marchent toujours ; pour le reste, reviens demain.",
  budgetEmpty: "Le budget d'IA du jour est épuisé : on reprend demain !",
  noAnswer: "Aucune IA n'a répondu. Réessaie dans un instant.",
  refused: "Je préfère ne pas répondre à ça.",
  unfinished: "Je me suis arrêté avant la fin : la demande demandait trop d'étapes. Découpe-la en plusieurs fois.",
  crash: "Quelque chose a planté de mon côté. Réessaie dans un instant.",
  presenceMembers: "Veille sur {membres} membres",
  presenceChat: "Mentionne-moi pour discuter",
  presenceAutomod: "{regles} règle(s) d'automod actives",
  presenceServer: "Au service de {serveur}",
};

export type TextKey = keyof typeof TEXTS;
export const TEXT_KEYS = Object.keys(TEXTS) as TextKey[];

// Où chaque texte apparaît, pour que l'IA (et l'admin dans /personnalite) sache ce qu'il réécrit.
export const TEXT_USES: Record<TextKey, string> = {
  consentTitle: "titre de la demande d'accord aux CGU",
  consentIntro: "début de la demande d'accord",
  consentAccepted: "accord donné, avant de répondre",
  consentAcceptedLater: "accord donné depuis /cgu",
  consentDeclined: "accord refusé",
  consentRevoked: "accord retiré, données effacées",
  budgetShare: "la personne a épuisé sa part du budget du jour",
  budgetEmpty: "le budget du jour est épuisé pour tout le monde",
  noAnswer: "aucune IA n'a répondu",
  refused: "l'IA refuse de répondre",
  unfinished: "demande trop longue, arrêtée en cours",
  crash: "erreur inattendue",
  presenceMembers: "statut du bot (court)",
  presenceChat: "statut du bot (court)",
  presenceAutomod: "statut du bot (court)",
  presenceServer: "statut du bot (court)",
};

type Voice = Partial<Record<TextKey, string>>;

const placeholders = (text: string) => [...text.matchAll(/\{\w+\}/g)].map((m) => m[0]).sort().join(",");

// Un texte réécrit doit garder exactement les mêmes {variables}, et rester court.
export function checkText(key: TextKey, text: string): string | null {
  if (!text.trim()) return "Texte vide.";
  if (text.length > (key.startsWith("presence") ? 120 : 300)) return "Texte trop long.";
  if (placeholders(text) !== placeholders(TEXTS[key])) return `Garde exactement ces variables : ${placeholders(TEXTS[key]) || "aucune"}.`;
  return null;
}

export async function getVoice(guildId: string): Promise<Record<TextKey, string>> {
  const { texts = {} } = await readJson<{ texts?: Voice }>(guildId, VOICE_FILE, {});
  return Object.fromEntries(TEXT_KEYS.map((key) => [key, texts[key] || TEXTS[key]])) as Record<TextKey, string>;
}

// Le texte prêt à envoyer, avec ses variables remplies.
export async function say(guildId: string, key: TextKey, vars: Record<string, string | number> = {}): Promise<string> {
  const text = (await getVoice(guildId))[key];
  return Object.entries(vars).reduce((t, [name, value]) => t.replaceAll(`{${name}}`, String(value)), text);
}

// null : revenir au texte neutre.
export async function setText(guildId: string, key: TextKey, text: string | null): Promise<void> {
  await withLock(`${guildId}/${VOICE_FILE}`, async () => {
    const { texts = {} } = await readJson<{ texts?: Voice }>(guildId, VOICE_FILE, {});
    if (text === null) delete texts[key];
    else texts[key] = text;
    await writeJson(guildId, VOICE_FILE, { texts, at: new Date().toISOString() });
  });
}

const Rewritten = z.object(Object.fromEntries(TEXT_KEYS.map((key) => [key, z.string()])) as Record<TextKey, z.ZodString>);

// L'IA réécrit tous les textes fixes d'un coup, dans le ton de la personnalité. Un texte invalide garde sa version neutre.
export async function rewriteVoice(guild: Guild, personality: Personality): Promise<void> {
  const list = TEXT_KEYS.map((key) => `- ${key} (${TEXT_USES[key]}) : ${TEXTS[key]}`).join("\n");
  const request = {
    system: `Tu réécris les textes fixes d'un bot Discord dans la voix de son personnage. Pour chaque texte : même sens, mêmes informations, exactement les mêmes {variables}, longueur comparable (les statuts restent très courts), au plus un emoji. N'ajoute aucun fait.\n\n${describePersonality(personality)}`,
    text: `Textes à réécrire :\n${list}`,
    schema: Rewritten,
  };
  const answer = await firstAnswer("Personnalité", (p, scope) => p.classify({ scope, ...request }));
  if (!answer || answer.result === "refused") return logConsole("Personnalité", "réécriture des textes impossible : textes neutres gardés");
  const result = answer.result as Record<TextKey, string>;
  const texts = Object.fromEntries(TEXT_KEYS.flatMap((key) => (checkText(key, result[key] ?? "") ? [] : [[key, result[key]!.trim()]])));
  await withLock(`${guild.id}/${VOICE_FILE}`, () => writeJson(guild.id, VOICE_FILE, { texts, at: new Date().toISOString() }));
  await log(guild, "Personnalité", `🗣️ ${Object.keys(texts).length}/${TEXT_KEYS.length} textes fixes réécrits dans le ton de **${personality.name}** · \`/personnalite\` pour les voir${provider(describeAnswer(answer))}`);
}
