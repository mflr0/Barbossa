import { z } from "zod";

// Types communs à tous les fournisseurs d'IA (Anthropic, OpenAI, Gemini).

export type Turn = { role: "user" | "assistant"; text: string };

// Un outil que l'IA peut appeler. Même définition quel que soit le fournisseur.
export interface Tool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  inputSchema: S;
  run(input: z.infer<S>): Promise<string>;
}

export function tool<S extends z.ZodObject>(definition: Tool<S>): Tool<S> {
  return definition;
}

export interface ChatRequest {
  scope: string;
  system: string;
  turns: Turn[];
  imageUrl?: string | null;
  tools: Tool[];
  maxSteps: number;
}

export interface ChatResult {
  text: string;
  refused: boolean;
  unfinished: boolean;
}

export interface Provider {
  name: string;
  model: string;
  fastModel: string;
  // Conversation avec outils (modèle principal).
  chat(request: ChatRequest): Promise<ChatResult>;
  // Texte libre sans outils (modèle principal). null si le modèle refuse.
  generate(request: { scope: string; system: string; text: string; imageUrl?: string | null }): Promise<string | null>;
  // Sortie JSON validée par le schéma (modèle rapide). "refused" si le modèle refuse, null si la sortie est invalide.
  classify<S extends z.ZodObject>(request: {
    scope: string;
    system: string;
    text: string;
    schema: S;
  }): Promise<z.infer<S> | "refused" | null>;
}

// Schéma JSON d'un schéma Zod, sans la clé $schema que certains fournisseurs refusent.
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export function parseJson(text: string | undefined): unknown {
  try {
    return JSON.parse(text ?? "");
  } catch {
    return undefined;
  }
}

// Valide l'entrée d'un appel d'outil puis l'exécute. Une erreur est renvoyée à l'IA, qui l'explique à l'admin.
export async function runTool(tools: Tool[], name: string, input: unknown): Promise<{ output: string; isError: boolean }> {
  const found = tools.find((t) => t.name === name);
  if (!found) return { output: `Outil inconnu : ${name}`, isError: true };
  try {
    return { output: await found.run(found.inputSchema.parse(input)), isError: false };
  } catch (error) {
    return { output: `Erreur : ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
}
