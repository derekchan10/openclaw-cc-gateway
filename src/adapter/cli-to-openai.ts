import { v4 as uuidv4 } from "uuid";
import type { OpenAIChatResponse, OpenAIChatChunk } from "../types/openai.js";

export function buildChatResponse(
  content: string,
  model: string,
  usage?: { input_tokens: number; output_tokens: number },
): OpenAIChatResponse {
  return {
    id: `chatcmpl-${uuidv4()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: usage?.input_tokens ?? 0,
      completion_tokens: usage?.output_tokens ?? 0,
      total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    },
  };
}

export function buildChatChunk(
  id: string,
  model: string,
  delta: { role?: "assistant"; content?: string },
  finishReason: "stop" | null = null,
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number },
): OpenAIChatChunk {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}
