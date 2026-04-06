import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import type { AnthropicMessagesRequest, AnthropicMessagesResponse } from "../types/anthropic.js";
import { anthropicToCliInput } from "../adapter/anthropic-to-cli.js";
import { ClaudeSubprocess } from "../cli/subprocess.js";
import { ConcurrencyQueue, TooManyRequestsError } from "../cli/queue.js";
import { SessionManager } from "../session/manager.js";
import type { Config } from "../config.js";

let _skillContent: string | null = null;
function loadSkill(config: Config): string {
  if (_skillContent !== null) return _skillContent;
  const file = config.cli.skill_file || resolve(process.cwd(), "openclaw-skill.md");
  try {
    _skillContent = readFileSync(file, "utf8");
    console.log(`[gateway] Loaded skill from ${file} (${_skillContent.length} chars)`);
  } catch {
    _skillContent = "";
    console.warn(`[gateway] No skill file found at ${file}`);
  }
  return _skillContent;
}

export function createAnthropicHandler(config: Config, queue: ConcurrencyQueue, sessions: SessionManager) {
  return async (req: Request, res: Response): Promise<void> => {
    const body = req.body as AnthropicMessagesRequest;

    if (!body?.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({
        type: "error",
        error: { type: "invalid_request_error", message: "messages is required" },
      });
      return;
    }

    if (!body.max_tokens) {
      res.status(400).json({
        type: "error",
        error: { type: "invalid_request_error", message: "max_tokens is required" },
      });
      return;
    }

    const tenant = req.tenant!;
    const conversationId = body.metadata?.user_id || uuidv4();
    const sessionId = sessions.getOrCreate(tenant.name, conversationId, body.model);
    const cliInput = anthropicToCliInput(body, sessionId);
    const isStream = body.stream !== false;

    // Inject OpenClaw skill + tenant context
    const skill = loadSkill(config);
    if (skill) {
      const tenantContext = `\n\n<!-- openclaw-tenant: ${tenant.name} -->`;
      cliInput.systemPrompt = (cliInput.systemPrompt || "") + "\n\n" + skill + tenantContext;
    }

    const singleTurn = false;

    try {
      await queue.acquire(tenant.name, () =>
        isStream
          ? handleStream(res, cliInput, body.model, config, tenant.name)
          : handleNonStream(res, cliInput, body.model, config, tenant.name),
      );
    } catch (err) {
      if (err instanceof TooManyRequestsError) {
        res.status(429).json({
          type: "error",
          error: { type: "rate_limit_error", message: "Too many concurrent requests" },
        });
      } else {
        console.error(`[${tenant.name}] Unexpected error:`, err);
        if (!res.headersSent) {
          res.status(500).json({
            type: "error",
            error: { type: "api_error", message: String(err) },
          });
        }
      }
    }
  };
}

/**
 * Streaming: buffer events per turn, only flush the LAST turn's events.
 *
 * CLI produces multiple turns when it uses tools internally:
 *   Turn 1: message_start → tool_use → message_stop (stop_reason=tool_use)
 *   Turn 2: message_start → text → message_stop (stop_reason=end_turn)
 *
 * pi-ai SDK expects exactly ONE message_start → ... → message_stop sequence.
 * We buffer each turn and only send the final one.
 */
function handleStream(
  res: Response,
  cliInput: { prompt: string; model: string; sessionId?: string; systemPrompt?: string },
  requestModel: string,
  config: Config,
  tenantName: string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      if (safetyTimer) clearTimeout(safetyTimer);
      resolve();
    };

    // Safety timeout: if nothing resolves within CLI timeout + 30s, force cleanup
    const safetyTimer = setTimeout(() => {
      if (!resolved) {
        console.error(`[${tenantName}] Safety timeout reached, forcing cleanup`);
        sub.kill();
        if (currentTurn.length > 0) flushTurn(res, currentTurn);
        if (!res.writableEnded) res.end();
        done();
      }
    }, config.cli.timeout + 30_000);

    const tenant = config.tenants.find((t) => t.name === tenantName);
    const sub = new ClaudeSubprocess({
      bin: config.cli.bin,
      timeout: config.cli.timeout,
      cwd: tenant?.working_dir,
      env: tenant?.env,
      tenantName,
      skillsDir: config.skills.dir,
    });

    res.on("close", () => { sub.kill(); done(); });

    // Buffer events per turn. Each turn starts at message_start, ends at message_stop.
    let currentTurn: Array<{ eventType: string; data: Record<string, unknown> }> = [];
    let lastStopReason = "";

    // Track ALL turns, keep last completed turn as fallback
    let lastCompletedTurn: Array<{ eventType: string; data: Record<string, unknown> }> = [];
    let flushed = false;

    sub.on("sse", (eventType: string, data: Record<string, unknown>) => {
      if (eventType === "message_start") {
        currentTurn = [];
      }

      if (eventType === "message_start") {
        const msg = data.message as Record<string, unknown> | undefined;
        if (msg) msg.model = requestModel;
      }

      if (eventType === "message_delta") {
        const delta = data.delta as Record<string, unknown> | undefined;
        if (delta?.stop_reason) lastStopReason = delta.stop_reason as string;
      }

      currentTurn.push({ eventType, data });

      if (eventType === "message_stop") {
        if (lastStopReason === "tool_use") {
          // Tool turn — save as fallback, then clear for next turn
          lastCompletedTurn = [...currentTurn];
          currentTurn = [];
          lastStopReason = "";
        } else {
          // Final turn — flush to client
          flushTurn(res, currentTurn);
          flushed = true;
          currentTurn = [];
        }
      }
    });

    // Synthesize a complete Anthropic SSE response from accumulated text.
    // Used when CLI exits abnormally without a proper end_turn sequence.
    const flushSynthetic = (reason: string) => {
      if (flushed || res.writableEnded || res.destroyed) return;

      // Collect any text from currentTurn or lastCompletedTurn events
      let text = "";
      const events = currentTurn.length > 0 ? currentTurn : lastCompletedTurn;
      for (const { eventType, data } of events) {
        if (eventType === "content_block_delta") {
          const delta = data.delta as Record<string, unknown> | undefined;
          if (delta?.type === "text_delta" && typeof delta.text === "string") {
            text += delta.text;
          }
        }
      }

      if (!text) text = `[CLI exited: ${reason}]`;

      // Send a complete synthetic Anthropic SSE sequence
      const msgId = `msg_${Date.now().toString(36)}`;
      if (!res.headersSent) {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();
      }
      res.write(`event: message_start\ndata: ${JSON.stringify({
        type: "message_start",
        message: { id: msgId, type: "message", role: "assistant", content: [], model: requestModel,
          stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
      })}\n\n`);
      res.write(`event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start", index: 0, content_block: { type: "text", text: "" },
      })}\n\n`);
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta", index: 0, delta: { type: "text_delta", text },
      })}\n\n`);
      res.write(`event: content_block_stop\ndata: ${JSON.stringify({
        type: "content_block_stop", index: 0,
      })}\n\n`);
      res.write(`event: message_delta\ndata: ${JSON.stringify({
        type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 0 },
      })}\n\n`);
      res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      flushed = true;
    };

    sub.on("error", (err: Error) => {
      try {
        console.error(`[${tenantName}] CLI error:`, err.message);
        if (!flushed) flushSynthetic(err.message);
        if (!res.writableEnded) res.end();
      } catch (e) {
        console.error(`[${tenantName}] Error in error handler:`, e);
      }
      done();
    });

    sub.on("close", (code: number | null) => {
      try {
        if (!flushed) {
          if (code !== 0) {
            console.warn(`[${tenantName}] CLI exited with code ${code} without final turn`);
          }
          if (currentTurn.length > 0 && currentTurn.some(e => e.eventType === "message_stop")) {
            flushTurn(res, currentTurn);
          } else if (lastCompletedTurn.length > 0) {
            flushTurn(res, lastCompletedTurn);
          } else {
            flushSynthetic(`exit code ${code}`);
          }
        }
        if (!res.writableEnded) res.end();
      } catch (e) {
        console.error(`[${tenantName}] Error in close handler:`, e);
      }
      done();
    });

    sub.start(cliInput);
  });
}

function flushTurn(res: Response, events: Array<{ eventType: string; data: Record<string, unknown> }>): void {
  if (!res.headersSent) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
  }
  for (const { eventType, data } of events) {
    res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

/**
 * Non-streaming: collect content blocks from the LAST turn only.
 */
function handleNonStream(
  res: Response,
  cliInput: { prompt: string; model: string; sessionId?: string; systemPrompt?: string },
  requestModel: string,
  config: Config,
  tenantName: string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      if (safetyTimer) clearTimeout(safetyTimer);
      resolve();
    };

    const tenant = config.tenants.find((t) => t.name === tenantName);
    const sub = new ClaudeSubprocess({
      bin: config.cli.bin,
      timeout: config.cli.timeout,
      cwd: tenant?.working_dir,
      env: tenant?.env,
      tenantName,
      skillsDir: config.skills.dir,
    });

    // Safety timeout
    const safetyTimer = setTimeout(() => {
      if (!resolved) {
        console.error(`[${tenantName}] Safety timeout reached (non-stream), forcing cleanup`);
        sub.kill();
        sendResponse();
        done();
      }
    }, config.cli.timeout + 30_000);

    // Track per-turn state, reset on each message_start
    let contentBlocks: unknown[] = [];
    let currentBlock: Record<string, unknown> | null = null;
    let stopReason = "end_turn";
    let usage = { input_tokens: 0, output_tokens: 0 };
    let messageId = "";

    sub.on("sse", (eventType: string, data: Record<string, unknown>) => {
      switch (eventType) {
        case "message_start": {
          // New turn — reset everything
          contentBlocks = [];
          currentBlock = null;
          const msg = data.message as Record<string, unknown> | undefined;
          if (msg) {
            messageId = (msg.id as string) || "";
            const u = msg.usage as Record<string, unknown> | undefined;
            if (u) {
              usage.input_tokens = ((u.cache_read_input_tokens as number) || 0) +
                ((u.cache_creation_input_tokens as number) || 0) +
                ((u.input_tokens as number) || 0);
            }
          }
          break;
        }
        case "content_block_start": {
          const block = data.content_block as Record<string, unknown>;
          currentBlock = { ...block };
          if (currentBlock.type === "text") currentBlock.text = "";
          if (currentBlock.type === "tool_use") currentBlock.input = {};
          break;
        }
        case "content_block_delta": {
          if (!currentBlock) break;
          const delta = data.delta as Record<string, unknown>;
          if (delta.type === "text_delta" && currentBlock.type === "text") {
            currentBlock.text = (currentBlock.text as string) + (delta.text as string);
          } else if (delta.type === "input_json_delta" && currentBlock.type === "tool_use") {
            currentBlock._partialJson = ((currentBlock._partialJson as string) || "") + (delta.partial_json as string);
          } else if (delta.type === "thinking_delta" && currentBlock.type === "thinking") {
            currentBlock.thinking = ((currentBlock.thinking as string) || "") + (delta.thinking as string);
          } else if (delta.type === "signature_delta" && currentBlock.type === "thinking") {
            currentBlock.signature = ((currentBlock.signature as string) || "") + (delta.signature as string);
          }
          break;
        }
        case "content_block_stop": {
          if (currentBlock) {
            if (currentBlock.type === "tool_use" && currentBlock._partialJson) {
              try { currentBlock.input = JSON.parse(currentBlock._partialJson as string); } catch { /* keep empty */ }
              delete currentBlock._partialJson;
            }
            contentBlocks.push(currentBlock);
            currentBlock = null;
          }
          break;
        }
        case "message_delta": {
          const delta = data.delta as Record<string, unknown> | undefined;
          if (delta?.stop_reason) stopReason = delta.stop_reason as string;
          const u = data.usage as Record<string, unknown> | undefined;
          if (u?.output_tokens) usage.output_tokens = u.output_tokens as number;
          break;
        }
      }
    });

    const sendResponse = () => {
      if (res.headersSent) return;
      // Filter out thinking blocks for cleaner response
      const filteredBlocks = contentBlocks.filter(
        (b) => (b as Record<string, unknown>).type !== "thinking"
      );
      const response: AnthropicMessagesResponse = {
        id: messageId || `msg_${uuidv4().replace(/-/g, "").slice(0, 24)}`,
        type: "message",
        role: "assistant",
        content: (filteredBlocks.length > 0 ? filteredBlocks : contentBlocks) as AnthropicMessagesResponse["content"],
        model: requestModel,
        stop_reason: stopReason as AnthropicMessagesResponse["stop_reason"],
        stop_sequence: null,
        usage,
      };
      res.json(response);
    };

    sub.on("error", (err: Error) => {
      console.error(`[${tenantName}] CLI error:`, err.message);
      if (!res.headersSent) {
        res.status(500).json({
          type: "error",
          error: { type: "api_error", message: err.message },
        });
      }
      done();
    });

    sub.on("close", () => {
      sendResponse();
      done();
    });

    sub.start(cliInput);
  });
}
