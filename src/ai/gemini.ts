import { FinishReason, GoogleGenAI, type Content, type GenerateContentResponse, type Part } from "@google/genai";
import { logUsage } from "../core/log.ts";
import { jsonSchema, runTool, type Provider, type Turn } from "./tool.ts";

const BLOCKED: (FinishReason | undefined)[] = [FinishReason.SAFETY, FinishReason.PROHIBITED_CONTENT, FinishReason.BLOCKLIST];

const isRefusal = (response: GenerateContentResponse) =>
  Boolean(response.promptFeedback?.blockReason) || BLOCKED.includes(response.candidates?.[0]?.finishReason);

const usageOf = (response: GenerateContentResponse) => ({
  input_tokens: response.usageMetadata?.promptTokenCount ?? 0,
  output_tokens: (response.usageMetadata?.candidatesTokenCount ?? 0) + (response.usageMetadata?.thoughtsTokenCount ?? 0),
});

// Gemini ne lit pas les images par URL : on télécharge l'icône et on l'envoie en base64.
async function imagePart(url: string): Promise<Part[]> {
  const response = await fetch(url).catch(() => null);
  if (!response?.ok) return [];
  return [{ inlineData: { mimeType: "image/png", data: Buffer.from(await response.arrayBuffer()).toString("base64") } }];
}

async function toContents(turns: Turn[], imageUrl?: string | null): Promise<Content[]> {
  return Promise.all(
    turns.map(async (turn, i) => ({
      role: turn.role === "assistant" ? "model" : "user",
      parts: [...(i === 0 && turn.role === "user" && imageUrl ? await imagePart(imageUrl) : []), { text: turn.text }],
    })),
  );
}

export function geminiProvider(model: string, fastModel: string): Provider {
  // Une seule tentative : en cas de saturation ou de quota, le fournisseur suivant prend le relais tout de suite
  // (par défaut, le SDK réessaie jusqu'à 5 fois, avec des pauses qui peuvent dépasser la minute).
  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, httpOptions: { timeout: 30_000, retryOptions: { attempts: 1 } } });

  return {
    name: "gemini",
    model,
    fastModel,

    async chat({ scope, system, turns, imageUrl, tools, maxSteps }) {
      const contents = await toContents(turns, imageUrl);
      const functionDeclarations = tools.map((t) => ({
        name: t.name,
        description: t.description,
        parametersJsonSchema: jsonSchema(t.inputSchema),
      }));

      for (let step = 0; step < maxSteps; step++) {
        const response = await client.models.generateContent({
          model,
          contents,
          config: { systemInstruction: system, tools: [{ functionDeclarations }] },
        });
        logUsage(scope, model, usageOf(response));
        if (isRefusal(response)) return { text: "", refused: true, unfinished: false };

        const calls = response.functionCalls ?? [];
        if (!calls.length) return { text: (response.text ?? "").trim(), refused: false, unfinished: false };

        // On renvoie le tour du modèle tel quel : il contient les signatures de réflexion attendues par Gemini.
        const modelTurn = response.candidates?.[0]?.content;
        if (modelTurn) contents.push(modelTurn);
        const parts: Part[] = [];
        for (const call of calls) {
          const result = await runTool(tools, call.name ?? "", call.args ?? {});
          parts.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: result.isError ? { error: result.output } : { output: result.output },
            },
          });
        }
        contents.push({ role: "user", parts });
      }
      return { text: "", refused: false, unfinished: true };
    },

    async generate({ scope, system, text, imageUrl }) {
      const response = await client.models.generateContent({
        model,
        contents: await toContents([{ role: "user", text }], imageUrl),
        config: { systemInstruction: system },
      });
      logUsage(scope, model, usageOf(response));
      return isRefusal(response) ? null : (response.text ?? "").trim();
    },

    async classify({ scope, system, text, schema }) {
      const response = await client.models.generateContent({
        model: fastModel,
        contents: text,
        config: {
          systemInstruction: system,
          responseMimeType: "application/json",
          responseJsonSchema: jsonSchema(schema),
        },
      });
      logUsage(scope, fastModel, usageOf(response));
      if (isRefusal(response)) return "refused";
      try {
        const parsed = schema.safeParse(JSON.parse(response.text ?? ""));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },
  };
}
