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
    console.log(`[${tenant.name}] request: model=${body.model} stream=${isStream} messages=${body.messages.length}`);

    // Inject OpenClaw skill + tenant context
    const skill = loadSkill(config);
    if (skill) {
      const tenantContext = `\n\n<!-- openclaw-tenant: ${tenant.name} -->`;
      cliInput.systemPrompt = (cliInput.systemPrompt || "") + "\n\n" + skill + tenantContext;
    }

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
 * Streaming: transparently forward ALL SSE events from CLI to client.
 *
 * CLI produces multiple message rounds when using tools internally.
 * We forward everything — client (pi-ai SDK) will see tool_use events
 * but won't try to execute them (they're CLI's internal tools, not
 * OpenClaw's tools). This keeps the connection alive during long
 * multi-turn tool executions.
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
    const done = (reason?: string) => {
      if (resolved) return;
      resolved = true;
      if (safetyTimer) clearTimeout(safetyTimer);
      console.log(`[${tenantName}] done: ${reason || "unknown"}`);
      resolve();
    };

    // Safety timeout: 10 minutes max
    const safetyTimer = setTimeout(() => {
      if (!resolved) {
        console.error(`[${tenantName}] Safety timeout (10min), forcing cleanup`);
        sub.kill();
        if (!res.writableEnded) res.end();
        done("safety-timeout");
      }
    }, 600_000);

    console.log(`[${tenantName}] stream: starting CLI (prompt=${cliInput.prompt.length} chars)`);

    const tenant = config.tenants.find((t) => t.name === tenantName);
    const sub = new ClaudeSubprocess({
      bin: config.cli.bin,
      timeout: config.cli.timeout,
      cwd: tenant?.working_dir,
      env: tenant?.env,
      tenantName,
      skillsDir: config.skills.dir,
    });

    // Send SSE headers immediately
    if (!res.headersSent) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();
    }

    res.on("close", () => {
      console.log(`[${tenantName}] stream: client disconnected`);
      sub.kill();
      done("client-disconnect");
    });

    // Transparent passthrough: forward every SSE event from CLI to client
    sub.on("sse", (eventType: string, data: Record<string, unknown>) => {
      // Patch model name in message_start events
      if (eventType === "message_start") {
        const msg = data.message as Record<string, unknown> | undefined;
        if (msg) msg.model = requestModel;
      }

      try {
        res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        // Client already disconnected
      }
    });

    sub.on("error", (err: Error) => {
      console.error(`[${tenantName}] CLI error:`, err.message);
      try {
        if (!res.writableEnded) res.end();
      } catch { /* ignore */ }
      done("error");
    });

    sub.on("close", (code: number | null) => {
      if (code !== 0 && code !== null) {
        console.warn(`[${tenantName}] CLI exited with code ${code}`);
      }
      try {
        if (!res.writableEnded) res.end();
      } catch { /* ignore */ }
      done("close");
    });

    sub.start(cliInput);
  });
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
    const done = (reason?: string) => {
      if (resolved) return;
      resolved = true;
      if (safetyTimer) clearTimeout(safetyTimer);
      console.log(`[${tenantName}] done(non-stream): ${reason || "unknown"}`);
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

    // Safety timeout: 10 minutes
    const safetyTimer = setTimeout(() => {
      if (!resolved) {
        console.error(`[${tenantName}] Safety timeout (non-stream), forcing cleanup`);
        sub.kill();
        sendResponse();
        done("safety-timeout");
      }
    }, 600_000);

    // Track per-turn state, reset on each message_start
    let contentBlocks: unknown[] = [];
    let currentBlock: Record<string, unknown> | null = null;
    let stopReason = "end_turn";
    let usage = { input_tokens: 0, output_tokens: 0 };
    let messageId = "";

    sub.on("sse", (eventType: string, data: Record<string, unknown>) => {
      switch (eventType) {
        case "message_start": {
          // New turn — reset
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
      done("error");
    });

    sub.on("close", () => {
      sendResponse();
      done("close");
    });

    sub.start(cliInput);
  });
}
