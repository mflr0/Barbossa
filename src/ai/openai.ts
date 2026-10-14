import OpenAI from "openai";
import { logUsage } from "../core/log.ts";
import { jsonSchema, parseJson, runTool, type Provider, type Turn } from "./tool.ts";

type Response = OpenAI.Responses.Response;

const usageOf = (response: Response) => ({
  input_tokens: response.usage?.input_tokens ?? 0,
  output_tokens: response.usage?.output_tokens ?? 0,
});

const isRefusal = (response: Response) =>
  response.output.some((item) => item.type === "message" && item.content.some((part) => part.type === "refusal"));

function toInput(turns: Turn[], imageUrl?: string | null): OpenAI.Responses.ResponseInputItem[] {
  return turns.map((turn, i) =>
    turn.role === "user" && i === 0 && imageUrl
      ? {
          role: "user",
          content: [
            { type: "input_image", image_url: imageUrl, detail: "low" },
            { type: "input_text", text: turn.text },
          ],
        }
      : { role: turn.role, content: turn.text },
  );
}

// API Responses d'OpenAI, boucle d'outils écrite à la main.
export function openaiProvider(model: string, fastModel: string): Provider {
  const client = new OpenAI();

  return {
    name: "openai",
    model,
    fastModel,

    async chat({ scope, system, turns, imageUrl, tools, maxSteps }) {
      const input = toInput(turns, imageUrl);
      const definitions = tools.map((t) => ({
        type: "function" as const,
        name: t.name,
        description: t.description,
        parameters: jsonSchema(t.inputSchema),
        strict: false,
      }));

      for (let step = 0; step < maxSteps; step++) {
        const response = await client.responses.create({
          model,
          instructions: system,
          input,
          tools: definitions,
          reasoning: { effort: "low" },
        });
        logUsage(scope, model, usageOf(response));
        if (isRefusal(response)) return { text: "", refused: true, unfinished: false };

        const calls = response.output.filter(
          (item): item is OpenAI.Responses.ResponseFunctionToolCall => item.type === "function_call",
        );
        if (!calls.length) return { text: response.output_text.trim(), refused: false, unfinished: false };

        input.push(...(response.output as OpenAI.Responses.ResponseInputItem[]));
        for (const call of calls) {
          const result = await runTool(tools, call.name, parseJson(call.arguments));
          input.push({ type: "function_call_output", call_id: call.call_id, output: result.output });
        }
      }
      return { text: "", refused: false, unfinished: true };
    },

    async generate({ scope, system, text, imageUrl }) {
      const response = await client.responses.create({
        model,
        instructions: system,
        input: toInput([{ role: "user", text }], imageUrl),
        reasoning: { effort: "low" },
      });
      logUsage(scope, model, usageOf(response));
      return isRefusal(response) ? null : response.output_text.trim();
    },

    async classify({ scope, system, text, schema }) {
      const response = await client.responses.create({
        model: fastModel,
        instructions: system,
        input: text,
        reasoning: { effort: "low" },
        text: { format: { type: "json_schema", name: "resultat", schema: jsonSchema(schema), strict: true } },
      });
      logUsage(scope, fastModel, usageOf(response));
      if (isRefusal(response)) return "refused";
      const parsed = schema.safeParse(parseJson(response.output_text));
      return parsed.success ? parsed.data : null;
    },
  };
}
