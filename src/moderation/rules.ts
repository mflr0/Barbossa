import { mkdir, readFile, writeFile } from "node:fs/promises";
import v8 from "node:v8";
import type { Message } from "discord.js";
import { logConsole } from "../core/log.ts";
import { withLock } from "../core/memory.ts";

// Une règle d'automod. Rédigée une fois par l'IA quand un admin la demande,
// puis appliquée sans IA : seul le choix « ce message enfreint-il une règle ? » passe par l'IA.
export interface Rule {
  id: string;
  watch: string;
  // Motifs (expressions régulières) écrits par l'IA à la création de la règle : testés sans appel API.
  patterns?: string[];
  // false : la règle ne passe jamais par l'IA (motifs seuls). Absent ou true : l'IA juge aussi les messages.
  useAi?: boolean;
  // Pré-filtre des règles jugées par l'IA : signaux larges (mots, tournures) écrits une fois par l'IA. Un message
  // qui n'en contient aucun n'est pas envoyé à l'IA pour cette règle. Absent ou vide : tous les messages sont analysés.
  signals?: string[];
  // Exclusions propres à cette règle (en plus des exclusions communes à toutes les règles).
  exclusions?: Exclusions;
  delete: boolean;
  timeoutMinutes: number;
  dm: boolean;
  alert: boolean;
  dmTemplates: string[];
}

// Ce que l'automod ignore, toutes règles confondues. channels accepte aussi des catégories.
export interface Exclusions {
  users: string[];
  roles: string[];
  channels: string[];
}

interface AutomodConfig {
  rules: Rule[];
  exclusions: Exclusions;
}

// Règles actives tant qu'aucune règle n'a été configurée sur le serveur.
const DEFAULT_RULES: Rule[] = [
  {
    id: "grave",
    watch:
      "Harcèlement ou insultes graves visant quelqu'un, propos haineux (racisme, homophobie, etc.), menaces réelles, arnaque ou phishing, contenu sexuel explicite, divulgation d'informations personnelles.",
    delete: true,
    timeoutMinutes: 10,
    dm: false,
    alert: true,
    dmTemplates: [],
  },
  {
    id: "suspect",
    watch: "Contenu à faire vérifier par un humain : insulte ciblée légère, provocation, lien douteux, contenu limite.",
    delete: false,
    timeoutMinutes: 0,
    dm: false,
    alert: true,
    dmTemplates: [],
  },
];

const cache = new Map<string, AutomodConfig>();
const file = (guildId: string) => new URL(`../../memoire/${guildId}/automod.json`, import.meta.url);

async function getConfig(guildId: string): Promise<AutomodConfig> {
  let config = cache.get(guildId);
  if (!config) {
    const raw = await readFile(file(guildId), "utf8").catch(() => null);
    const parsed = raw ? (JSON.parse(raw) as AutomodConfig | Rule[]) : null;
    const empty: Exclusions = { users: [], roles: [], channels: [] };
    // Ancien format du fichier : un simple tableau de règles.
    config = Array.isArray(parsed) ? { rules: parsed, exclusions: empty } : (parsed ?? { rules: DEFAULT_RULES, exclusions: empty });
    cache.set(guildId, config);
  }
  return config;
}

async function saveConfig(guildId: string, config: AutomodConfig): Promise<void> {
  await mkdir(new URL(`../../memoire/${guildId}/`, import.meta.url), { recursive: true });
  await writeFile(file(guildId), `${JSON.stringify(config, null, 2)}\n`);
  cache.set(guildId, config);
}

export async function getAutomod(guildId: string): Promise<AutomodConfig> {
  return getConfig(guildId);
}

export async function getRules(guildId: string): Promise<Rule[]> {
  return (await getConfig(guildId)).rules;
}

// Chaque modification lit puis réécrit le fichier sous verrou : deux changements simultanés ne s'écrasent pas.
const lock = <T>(guildId: string, fn: () => Promise<T>) => withLock(`${guildId}/automod.json`, fn);

export async function addRule(guildId: string, draft: Omit<Rule, "id">): Promise<Rule> {
  return lock(guildId, async () => {
    const config = await getConfig(guildId);
    const next = Math.max(0, ...config.rules.map((r) => Number(r.id.replace(/^r/, "")) || 0)) + 1;
    const rule: Rule = { id: `r${next}`, ...draft };
    await saveConfig(guildId, { ...config, rules: [...config.rules, rule] });
    return rule;
  });
}

export async function removeRule(guildId: string, id: string): Promise<Rule | null> {
  return lock(guildId, async () => {
    const config = await getConfig(guildId);
    const rule = config.rules.find((r) => r.id === id) ?? null;
    if (rule) await saveConfig(guildId, { ...config, rules: config.rules.filter((r) => r.id !== id) });
    return rule;
  });
}

const NO_EXCLUSIONS: Exclusions = { users: [], roles: [], channels: [] };

// ruleId : exclure d'une seule règle ; absent : de toutes les règles.
export async function setExclusion(guildId: string, kind: keyof Exclusions, id: string, exclude: boolean, ruleId?: string): Promise<void> {
  return lock(guildId, async () => {
    const config = await getConfig(guildId);
    const update = (exclusions: Exclusions): Exclusions => {
      const list = exclusions[kind].filter((x) => x !== id);
      if (exclude) list.push(id);
      return { ...exclusions, [kind]: list };
    };
    if (!ruleId) return saveConfig(guildId, { ...config, exclusions: update(config.exclusions) });
    if (!config.rules.some((r) => r.id === ruleId)) throw new Error(`Règle ${ruleId} introuvable.`);
    const rules = config.rules.map((r) => (r.id === ruleId ? { ...r, exclusions: update(r.exclusions ?? NO_EXCLUSIONS) } : r));
    await saveConfig(guildId, { ...config, rules });
  });
}

// Vrai si l'auteur, un de ses rôles, le salon, sa catégorie ou (pour un fil) son salon parent est exclu.
// Exclu de toutes les règles.
export async function isExcluded(message: Message<true>): Promise<boolean> {
  return matchesExclusions((await getConfig(message.guildId)).exclusions, message);
}

export function matchesExclusions(exclusions: Exclusions, message: Message<true>): boolean {
  const channel = message.channel;
  const channelIds = [channel.id, channel.parentId, channel.isThread() ? channel.parent?.parentId : null];
  return (
    exclusions.users.includes(message.author.id) ||
    channelIds.some((id) => id && exclusions.channels.includes(id)) ||
    Boolean(message.member?.roles.cache.some((role) => exclusions.roles.includes(role.id)))
  );
}

// --- Motifs compilés : la partie de l'automod qui tourne sans IA ---

// Les motifs sont écrits par l'IA et testés sur les messages des membres : un motif mal fichu comme (a|a)*b
// mettrait des heures à traiter un message piégé de 40 caractères et figerait tout le bot (ReDoS).
// Le moteur linéaire de V8 (flag « l ») garantit un temps proportionnel à la longueur du message ;
// il refuse les rares constructions qu'il ne sait pas traiter en temps linéaire (renvois \1, lookahead).
v8.setFlagsFromString("--enable-experimental-regexp-engine");

const compiled = new Map<string, RegExp | null>();

function compile(pattern: string): RegExp | null {
  if (!compiled.has(pattern)) {
    let regex: RegExp | null = null;
    try {
      regex = new RegExp(pattern, "l");
    } catch {
      logConsole("Motifs", `motif ignoré (invalide ou non linéaire) : ${pattern}`);
    }
    compiled.set(pattern, regex);
  }
  return compiled.get(pattern)!;
}

// Minuscules et sans accents, pour qu'un motif « negre » attrape aussi « NÈGRE ».
function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

// Longueur du plus long passage reconnu par un des motifs, ou -1 si aucun ne reconnaît le texte.
// Chaque motif est testé sur le message brut et sur sa version normalisée.
// Le leetspeak décodé (« n3gr0 » → « negro », « @ » → « a ») : un contournement classique des filtres.
const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", $: "s" };
const unleet = (text: string) => text.replace(/[013457@$]/g, (c) => LEET[c]!);

export function matchLength(patterns: string[], text: string): number {
  const normalized = normalize(text);
  const decoded = unleet(normalized);
  let best = -1;
  for (const pattern of patterns) {
    const regex = compile(pattern);
    if (!regex) continue;
    for (const candidate of decoded === normalized ? [text, normalized] : [text, normalized, decoded]) {
      const match = regex.exec(candidate);
      if (match) best = Math.max(best, match[0].length);
    }
  }
  return best;
}

export function matchesPatterns(patterns: string[], text: string): boolean {
  return matchLength(patterns, text) >= 0;
}

// Vérifie un motif écrit par l'IA avant de l'enregistrer. Renvoie la raison du refus, ou null s'il est valide.
// banal : un message qu'un motif valide ne doit pas reconnaître.
export function checkPattern(pattern: string, banal = "Salut tout le monde, comment ça va ce soir ?"): string | null {
  if (pattern.length > 300) return "trop long (300 caractères max)";
  if (!compile(pattern)) return "expression régulière invalide, ou qui utilise un renvoi (\\1) ou un lookahead (?=…), interdits";
  if (matchesPatterns([pattern], "") || matchesPatterns([pattern], banal)) {
    return "trop large : il reconnaît un message sans rapport";
  }
  return null;
}

export function modeOf(rule: Rule): string {
  const patterns = rule.patterns?.length ?? 0;
  if (rule.useAi === false) return `🔣 ${patterns} motif(s), sans IA`;
  const ai = rule.signals?.length ? `🧠 IA (pré-filtre : ${rule.signals.length} signaux)` : "🧠 IA (tous les messages)";
  return patterns ? `🔣 ${patterns} motif(s) + ${ai}` : ai;
}

// Vérifie un pré-filtre : des motifs valides, et aucune des infractions d'exemple ne doit passer à travers.
export function checkSignals(signals: string[], suspects: string[]): string | null {
  const invalid = signals.flatMap((p) => {
    const problem = checkPattern(p);
    return problem ? [`« ${p} » : ${problem}`] : [];
  });
  if (invalid.length) return `Signaux refusés :\n${invalid.join("\n")}`;
  if (signals.length && suspects.length < 3) return "Fournis au moins 3 test_suspects (des infractions, y compris déguisées) pour vérifier les signaux.";
  const missed = suspects.filter((t) => !matchesPatterns(signals, t));
  if (missed.length) return `Signaux trop étroits : ces infractions ne seraient jamais analysées : ${missed.join(" | ")}`;
  return null;
}

export async function setSignals(guildId: string, id: string, signals: string[]): Promise<void> {
  await lock(guildId, async () => {
    const config = await getConfig(guildId);
    await saveConfig(guildId, { ...config, rules: config.rules.map((r) => (r.id === id ? { ...r, signals } : r)) });
  });
}

export function describeRule(rule: Rule): string {
  const actions = [
    rule.delete && "supprimer le message",
    rule.timeoutMinutes > 0 && `silence ${rule.timeoutMinutes} min`,
    rule.dm && "MP au membre",
    rule.alert && "alerte dans les logs",
  ].filter(Boolean);
  const dm = rule.dm ? rule.dmTemplates.map((t, i) => `\n   MP ${i + 1} : « ${t} »`).join("") : "";
  const excluded = rule.exclusions ? listExclusions(rule.exclusions) : "";
  return `**${rule.id}** (${modeOf(rule)}) : ${rule.watch}\n   → ${actions.join(", ") || "aucune action"}${excluded ? `\n   Exclusions propres à ${rule.id} : ${excluded}` : ""}${dm}`;
}

function listExclusions({ users, roles, channels }: Exclusions): string {
  return [
    users.length && `membres ${users.map((id) => `<@${id}>`).join(" ")}`,
    roles.length && `rôles ${roles.map((id) => `<@&${id}>`).join(" ")}`,
    channels.length && `salons et catégories ${channels.map((id) => `<#${id}>`).join(" ")}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export async function describeAutomod(guildId: string): Promise<string> {
  const { rules, exclusions } = await getConfig(guildId);
  return [
    `Règles d'automod :\n${rules.length ? rules.map(describeRule).join("\n") : "aucune (automod en pause)"}`,
    `Exclusions communes à TOUTES les règles : ${listExclusions(exclusions) || "aucune"}`,
  ].join("\n\n");
}
