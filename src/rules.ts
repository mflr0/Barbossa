import { mkdir, readFile, writeFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { MessageFlags, type ChatInputCommandInteraction } from "discord.js";
import { z } from "zod";
import { MODEL } from "./admin.ts";
import { log, logUsage } from "./log.ts";
import { readMemory } from "./memory.ts";

// Une règle d'automod. Rédigée une fois par l'IA à partir de la demande d'un admin,
// puis appliquée sans IA : seul le choix « ce message enfreint-il une règle ? » passe par Claude.
export interface Rule {
  id: string;
  watch: string;
  delete: boolean;
  timeoutMinutes: number;
  dm: boolean;
  alert: boolean;
  dmTemplates: string[];
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

const anthropic = new Anthropic();
const cache = new Map<string, Rule[]>();
const file = (guildId: string) => new URL(`../memoire/${guildId}/automod.json`, import.meta.url);

export async function getRules(guildId: string): Promise<Rule[]> {
  let rules = cache.get(guildId);
  if (!rules) {
    const raw = await readFile(file(guildId), "utf8").catch(() => null);
    rules = raw ? (JSON.parse(raw) as Rule[]) : DEFAULT_RULES;
    cache.set(guildId, rules);
  }
  return rules;
}

async function saveRules(guildId: string, rules: Rule[]): Promise<void> {
  await mkdir(new URL(`../memoire/${guildId}/`, import.meta.url), { recursive: true });
  await writeFile(file(guildId), `${JSON.stringify(rules, null, 2)}\n`);
  cache.set(guildId, rules);
}

export function describeRule(rule: Rule): string {
  const actions = [
    rule.delete && "supprimer le message",
    rule.timeoutMinutes > 0 && `silence ${rule.timeoutMinutes} min`,
    rule.dm && "MP au membre",
    rule.alert && "alerte dans les logs",
  ].filter(Boolean);
  const dm = rule.dm ? rule.dmTemplates.map((t, i) => `\n   MP ${i + 1} : « ${t} »`).join("") : "";
  return `**${rule.id}** : ${rule.watch}\n   → ${actions.join(", ") || "aucune action"}${dm}`;
}

const Draft = z.object({
  watch: z.string().describe("Critère précis et autonome de ce qu'il faut détecter, lisible par un classifieur"),
  delete: z.boolean(),
  timeout_minutes: z.number().int().describe("Durée du silence en minutes, 0 si aucun (max 40320)"),
  dm: z.boolean().describe("Envoyer un message privé au membre"),
  alert: z.boolean().describe("Signaler dans le salon de logs"),
  dm_templates: z.array(z.string()).describe("4 variantes du message privé si dm, sinon tableau vide"),
});

const DRAFT_SYSTEM = `Un administrateur de serveur Discord configure une règle d'automod en langage naturel. Traduis sa demande en règle structurée.

- watch : reformule ce qu'il faut surveiller en un critère précis, compréhensible sans contexte.
- Actions : n'active que celles demandées. alert vaut true sauf si l'admin dit le contraire.
- dm_templates : si un message privé est demandé, écris-en 4 variantes différentes, une fois pour toutes ; le bot en tirera une au hasard à chaque infraction. Chacune : 1 à 3 phrases, ferme mais respectueux, dans le ton du serveur, sans citer le message fautif. Variables disponibles : {membre}, {salon}, {serveur}.`;

// /barbossa automod surveiller : l'IA rédige la règle et son MP type une seule fois.
async function addRule(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const watch = interaction.options.getString("quoi", true);
  const actions = interaction.options.getString("actions", true);
  const { profile } = await readMemory(interaction.guildId);

  const response = await anthropic.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    output_config: { effort: "low", format: zodOutputFormat(Draft) },
    system: DRAFT_SYSTEM + (profile ? `\n\n<fiche_du_serveur>\n${profile}\n</fiche_du_serveur>` : ""),
    messages: [{ role: "user", content: `Surveiller : ${watch}\nActions : ${actions}` }],
  });
  logUsage("Création de règle", MODEL, response.usage);
  const draft = response.parsed_output;
  if (response.stop_reason === "refusal" || !draft) {
    await interaction.editReply("🏴‍☠️ Impossible de rédiger cette règle. Reformule-la.");
    return;
  }

  const rules = await getRules(interaction.guildId);
  const next = Math.max(0, ...rules.map((r) => Number(r.id.replace(/^r/, "")) || 0)) + 1;
  const rule: Rule = {
    id: `r${next}`,
    watch: draft.watch,
    delete: draft.delete,
    timeoutMinutes: Math.min(Math.max(draft.timeout_minutes, 0), 40320),
    dm: draft.dm && draft.dm_templates.length > 0,
    alert: draft.alert,
    dmTemplates: draft.dm_templates.filter((t) => t.trim()),
  };
  await saveRules(interaction.guildId, [...rules, rule]);
  await log(interaction.guild, "Automod", `🛡️ ${interaction.user} a ajouté une règle d'automod :\n${describeRule(rule)}`);
  await interaction.editReply(`🛡️ Règle ajoutée :\n${describeRule(rule)}\n\nPour la retirer : \`/barbossa automod retirer regle:${rule.id}\``);
}

async function listRules(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  const rules = await getRules(interaction.guildId);
  const content = rules.length ? rules.map(describeRule).join("\n") : "Aucune règle : l'automod est en pause.";
  await interaction.reply({ content: `🛡️ Règles d'automod :\n${content}`.slice(0, 2000), flags: MessageFlags.Ephemeral });
}

async function removeRule(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  const id = interaction.options.getString("regle", true).trim();
  const rules = await getRules(interaction.guildId);
  const rule = rules.find((r) => r.id === id);
  if (!rule) {
    await interaction.reply({ content: `Aucune règle « ${id} ». Vois la liste avec \`/barbossa automod liste\`.`, flags: MessageFlags.Ephemeral });
    return;
  }
  await saveRules(interaction.guildId, rules.filter((r) => r.id !== id));
  await log(interaction.guild, "Automod", `🗑️ ${interaction.user} a retiré la règle d'automod **${id}** (${rule.watch})`);
  await interaction.reply({ content: `Règle **${id}** retirée.`, flags: MessageFlags.Ephemeral });
}

export async function handleAutomodCommand(interaction: ChatInputCommandInteraction<"cached">): Promise<void> {
  const sub = interaction.options.getSubcommand();
  if (sub === "surveiller") await addRule(interaction);
  else if (sub === "liste") await listRules(interaction);
  else if (sub === "retirer") await removeRule(interaction);
}
