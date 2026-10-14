import { FREE_SCOPE, logConsole, spentFor } from "../core/log.ts";
import { anthropicProvider } from "./anthropic.ts";
import { geminiProvider } from "./gemini.ts";
import { openaiProvider } from "./openai.ts";
import type { Provider } from "./tool.ts";

// Les fournisseurs d'IA, réglés dans .env :
// - AI_PROVIDERS : la liste, ex. « gemini,anthropic » (ou « fournisseur:modèle », ex. « gemini:gemini-3.8-flash ») ;
// - AI_FREE : ceux utilisés en offre gratuite, ex. « gemini ».
// Les gratuits sont toujours essayés en premier, puis les payants ; si un fournisseur échoue (panne, quota gratuit
// atteint), le suivant prend le relais.
const PROVIDERS = {
  anthropic: { create: anthropicProvider, model: "claude-haiku-5-5", key: "ANTHROPIC_API_KEY" },
  openai: { create: openaiProvider, model: "gpt-6-luna", key: "OPENAI_API_KEY" },
  gemini: { create: geminiProvider, model: "gemini-3.5-flash-lite", key: "GEMINI_API_KEY" },
};

const FREE = new Set((process.env.AI_FREE ?? "").split(",").map((name) => name.trim().toLowerCase()).filter(Boolean));

export const isFree = (provider: Provider): boolean => FREE.has(provider.name);

const configured = (process.env.AI_PROVIDERS || "anthropic")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [rawName, model] = entry.split(":");
    const name = rawName!.toLowerCase();
    if (!(name in PROVIDERS)) throw new Error(`AI_PROVIDERS : fournisseur inconnu « ${name} ». Valeurs possibles : anthropic, openai, gemini.`);
    const config = PROVIDERS[name as keyof typeof PROVIDERS];
    if (!process.env[config.key]) throw new Error(`${config.key} manquant dans .env (fournisseur ${name} dans AI_PROVIDERS).`);
    const chosen = model || config.model;
    return config.create(chosen, chosen);
  });

// Les gratuits d'abord, en gardant l'ordre choisi à l'intérieur de chaque groupe.
export const providers: Provider[] = [...configured.filter(isFree), ...configured.filter((p) => !isFree(p))];

// Les usages gratuits sont suffixés : le journal des coûts les compte à 0 $.
export const scopeFor = (scope: string, provider: Provider): string => (isFree(provider) ? scope + FREE_SCOPE : scope);

export function describeProviders(): string {
  return providers.map((p) => `${p.name}:${p.model}${isFree(p) ? " (gratuit)" : ""}`).join(" → ");
}

// Une réponse, avec le fournisseur qui l'a donnée et ce qu'elle a coûté (pour le budget et le journal).
export interface Answer<T> {
  result: T;
  provider: Provider;
  cost: number;
}

// « gemini:gemini-3.5-flash-lite (gratuit) » ou « anthropic:claude-haiku-5-5 · 0,0004 $ », pour le journal.
export function describeAnswer(answer: Answer<unknown>): string {
  const model = `${answer.provider.name}:${answer.provider.model}`;
  return isFree(answer.provider) ? `${model} (gratuit)` : `${model} · ${answer.cost.toFixed(4).replace(".", ",")} $`;
}

// Un fournisseur qui vient d'échouer (saturé, quota atteint, panne) est mis de côté quelques minutes :
// les messages suivants passent directement au suivant, sans attendre un nouvel échec.
const PAUSE_MS = 5 * 60_000;
const pausedUntil = new Map<Provider, number>();

// Essaie les fournisseurs dans l'ordre (les gratuits d'abord) et renvoie la première réponse exploitable.
// allowPaid : faux pour se limiter aux gratuits (budget épuisé). allowFree : faux pour se limiter aux payants
// (les offres gratuites peuvent réutiliser les messages : pas sans l'accord de l'auteur). canRetry : faux pour ne pas relancer la demande
// sur le fournisseur suivant (par exemple quand une action a déjà été exécutée).
export async function firstAnswer<T>(
  label: string,
  call: (provider: Provider, scope: string) => Promise<T | null>,
  { allowPaid = true, allowFree = true, canRetry = () => true }: { allowPaid?: boolean; allowFree?: boolean; canRetry?: () => boolean } = {},
): Promise<Answer<T> | null> {
  const allowed = providers.filter((p) => (isFree(p) ? allowFree : allowPaid));
  const ready = allowed.filter((p) => (pausedUntil.get(p) ?? 0) < Date.now());
  // Si tous sont en pause, on les retente quand même plutôt que de ne rien répondre.
  for (const provider of ready.length ? ready : allowed) {
    const scope = scopeFor(label, provider);
    const before = spentFor(scope);
    try {
      const result = await call(provider, scope);
      pausedUntil.delete(provider);
      if (result !== null) return { result, provider, cost: spentFor(scope) - before };
    } catch (error) {
      if (!canRetry()) throw error;
      pausedUntil.set(provider, Date.now() + PAUSE_MS);
      logConsole("IA", `${label} : ${provider.name}:${provider.model} indisponible (${error instanceof Error ? error.message.slice(0, 120) : error}), mis de côté ${PAUSE_MS / 60_000} min`);
    }
  }
  return null;
}

export type { Tool, Turn } from "./tool.ts";
