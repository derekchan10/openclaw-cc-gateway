import type { AnthropicMessagesRequest, AnthropicContentBlock } from "../types/anthropic.js";
import type { CliInput } from "../types/cli.js";
import { mapModel } from "../cli/subprocess.js";

export function anthropicToCliInput(req: AnthropicMessagesRequest, sessionId?: string): CliInput {
  const parts: string[] = [];

  // Extract system prompt
  let systemPrompt: string | undefined;
  if (req.system) {
    if (typeof req.system === "string") {
      systemPrompt = req.system;
    } else if (Array.isArray(req.system)) {
      systemPrompt = req.system.map((b) => b.text).join("\n");
    }
  }

  // Convert messages to prompt text
  for (const msg of req.messages) {
    const text = extractContent(msg.content);
    switch (msg.role) {
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

function extractContent(content: string | AnthropicContentBlock[]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content);

  return content
    .filter((b) => b.type === "text" && b.text)
    .map((b) => b.text!)
    .join("\n");
}
