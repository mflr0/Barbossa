import Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { logUsage } from "../core/log.ts";
import type { Provider } from "./tool.ts";

const textOf = (content: { type: string; text?: string }[]) =>
  content
    .flatMap((block) => (block.type === "text" && block.text ? [block.text] : []))
    .join("\n")
    .trim();

export function anthropicProvider(model: string, fastModel: string): Provider {
  const client = new Anthropic();
  const userContent = (text: string, imageUrl?: string | null) =>
    imageUrl
      ? [
          { type: "image" as const, source: { type: "url" as const, url: imageUrl } },
          { type: "text" as const, text },
        ]
      : text;

  return {
    name: "anthropic",
    model,
    fastModel,

    async chat({ scope, system, turns, imageUrl, tools, maxSteps }) {
      const runner = client.beta.messages.toolRunner({
        model,
        max_tokens: 16000,
        max_iterations: maxSteps,
        output_config: { effort: "medium" },
        system,
        tools: tools.map((t) => betaZodTool({ name: t.name, description: t.description, inputSchema: t.inputSchema, run: t.run })),
        messages: turns.map((turn, i) => ({
          role: turn.role,
          content: i === 0 && turn.role === "user" ? userContent(turn.text, imageUrl) : turn.text,
        })),
      });
      for await (const message of runner) logUsage(scope, model, message.usage);
      const final = await runner.done();
      return {
        text: textOf(final.content),
        refused: final.stop_reason === "refusal",
        unfinished: final.stop_reason === "tool_use",
      };
    },

    async generate({ scope, system, text, imageUrl }) {
      const response = await client.messages.create({
        model,
        max_tokens: 4000,
        output_config: { effort: "medium" },
        system,
        messages: [{ role: "user", content: userContent(text, imageUrl) }],
      });
      logUsage(scope, model, response.usage);
      return response.stop_reason === "refusal" ? null : textOf(response.content);
    },

    async classify({ scope, system, text, schema }) {
      const response = await client.messages.parse({
        model: fastModel,
        max_tokens: 4096,
        output_config: { effort: "low", format: zodOutputFormat(schema) },
        system,
        messages: [{ role: "user", content: text }],
      });
      logUsage(scope, fastModel, response.usage);
      if (response.stop_reason === "refusal") return "refused";
      return response.parsed_output ?? null;
    },
  };
}
