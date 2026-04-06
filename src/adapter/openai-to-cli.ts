import type { OpenAIChatRequest, OpenAIMessage, OpenAIContentBlock } from "../types/openai.js";
import type { CliInput } from "../types/cli.js";
import { mapModel } from "../cli/subprocess.js";

export function openaiToCliInput(req: OpenAIChatRequest, sessionId?: string): CliInput {
  const parts: string[] = [];
  let systemPrompt: string | undefined;

  for (const msg of req.messages) {
    const text = extractText(msg.content);
    switch (msg.role) {
      case "system":
        systemPrompt = text;
        break;
      case "user":
        parts.push(text);
        break;
      case "assistant":
        parts.push(`<previous_response>\n${text}\n</previous_response>`);
        break;
    }
  }

  return {
    prompt: parts.join("\n\n"),
    model: mapModel(req.model),
    sessionId,
    systemPrompt,
  };
}

function extractText(content: string | OpenAIContentBlock[] | null): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}
