import type { AnthropicMessagesRequest, AnthropicContentBlock } from "../types/anthropic.js";
import type { CliInput } from "../types/cli.js";
import { mapModel } from "../cli/subprocess.js";

// Default container home → host home mapping
const CONTAINER_HOME = "/home/node";

export function anthropicToCliInput(req: AnthropicMessagesRequest, sessionId?: string): CliInput {
  const parts: string[] = [];
  const hostHome = process.env.HOME || "/home/" + (process.env.USER || "user");

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
    let text = extractContent(msg.content);
    // Rewrite container paths to host paths in media references
    if (text.includes(CONTAINER_HOME)) {
      text = text.replace(new RegExp(CONTAINER_HOME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), hostHome);
    }
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
    .map((b) => {
      if (b.type === "text" && b.text) return b.text;
      if (b.type === "image") return "[Image received — image analysis not available in CLI proxy mode]";
      if (b.type === "tool_use") return `[Tool call: ${b.name}]`;
      if (b.type === "tool_result") {
        const text = typeof b.content === "string" ? b.content
          : Array.isArray(b.content) ? b.content.filter(c => c.type === "text").map(c => c.text).join("\n")
          : "";
        return text || "[Tool result]";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
