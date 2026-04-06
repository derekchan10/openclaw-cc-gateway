import { v4 as uuidv4 } from "uuid";
import type { Response } from "express";

const MSG_ID_PREFIX = "msg_";

export function createMessageId(): string {
  return MSG_ID_PREFIX + uuidv4().replace(/-/g, "").slice(0, 24);
}

// Write a named SSE event in Anthropic format: `event: <type>\ndata: <json>\n\n`
function writeEvent(res: Response, eventType: string, data: unknown): void {
  res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function sendMessageStart(res: Response, msgId: string, model: string): void {
  writeEvent(res, "message_start", {
    type: "message_start",
    message: {
      id: msgId,
      type: "message",
      role: "assistant",
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
}

export function sendContentBlockStart(res: Response, index: number): void {
  writeEvent(res, "content_block_start", {
    type: "content_block_start",
    index,
    content_block: { type: "text", text: "" },
  });
}

export function sendContentBlockDelta(res: Response, index: number, text: string): void {
  writeEvent(res, "content_block_delta", {
    type: "content_block_delta",
    index,
    delta: { type: "text_delta", text },
  });
}

export function sendContentBlockStop(res: Response, index: number): void {
  writeEvent(res, "content_block_stop", {
    type: "content_block_stop",
    index,
  });
}

export function sendMessageDelta(
  res: Response,
  stopReason: string,
  outputTokens: number,
): void {
  writeEvent(res, "message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
}

export function sendMessageStop(res: Response): void {
  writeEvent(res, "message_stop", { type: "message_stop" });
}

export function sendPing(res: Response): void {
  writeEvent(res, "ping", { type: "ping" });
}

export function sendError(res: Response, message: string): void {
  writeEvent(res, "error", {
    type: "error",
    error: { type: "api_error", message },
  });
}
