import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import type { OpenAIChatRequest } from "../types/openai.js";
import { openaiToCliInput } from "../adapter/openai-to-cli.js";
import { buildChatResponse, buildChatChunk } from "../adapter/cli-to-openai.js";
import { ClaudeSubprocess } from "../cli/subprocess.js";
import { ConcurrencyQueue, TooManyRequestsError } from "../cli/queue.js";
import { SessionManager } from "../session/manager.js";
import type { Config } from "../config.js";

export function createOpenAIHandler(config: Config, queue: ConcurrencyQueue, sessions: SessionManager) {
  return async (req: Request, res: Response): Promise<void> => {
    const body = req.body as OpenAIChatRequest;

    if (!body?.messages || !Array.isArray(body.messages) || body.messages.length === 0) {
      res.status(400).json({ error: { message: "messages is required", type: "invalid_request_error" } });
      return;
    }

    const tenant = req.tenant!;
    const conversationId = body.user || uuidv4();
    const sessionId = sessions.getOrCreate(tenant.name, conversationId, body.model);
    const cliInput = openaiToCliInput(body, sessionId);
    const isStream = body.stream === true;

    try {
      await queue.acquire(tenant.name, () =>
        isStream
          ? handleStream(res, cliInput, body.model, config, tenant.name)
          : handleNonStream(res, cliInput, body.model, config, tenant.name),
      );
    } catch (err) {
      if (err instanceof TooManyRequestsError) {
        res.status(429).json({ error: { message: "Too many concurrent requests", type: "rate_limit_error" } });
      } else {
        if (!res.headersSent) {
          res.status(500).json({ error: { message: String(err), type: "server_error" } });
        }
      }
    }
  };
}

function handleStream(
  res: Response,
  cliInput: { prompt: string; model: string; sessionId?: string; systemPrompt?: string },
  requestModel: string,
  config: Config,
  tenantName: string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    res.write(":ok\n\n");

    const chatId = `chatcmpl-${uuidv4()}`;
    let firstChunk = true;
    let resolved = false;
    let usage = { input_tokens: 0, output_tokens: 0 };

    const done = () => { if (!resolved) { resolved = true; resolve(); } };

    const sub = new ClaudeSubprocess({
      bin: config.cli.bin,
      timeout: config.cli.timeout,
      cwd: config.tenants.find((t) => t.name === tenantName)?.working_dir,
    });

    res.on("close", () => { sub.kill(); done(); });

    sub.on("content_delta", (text: string) => {
      const delta: { role?: "assistant"; content?: string } = { content: text };
      if (firstChunk) { delta.role = "assistant"; firstChunk = false; }
      const chunk = buildChatChunk(chatId, requestModel, delta);
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    });

    sub.on("result", (result: { usage?: { input_tokens: number; output_tokens: number } }) => {
      if (result.usage) usage = result.usage;
    });

    sub.on("error", (err: Error) => {
      console.error(`[${tenantName}] CLI error:`, err.message);
      const chunk = buildChatChunk(chatId, requestModel, {}, "stop", {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        total_tokens: usage.input_tokens + usage.output_tokens,
      });
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      done();
    });

    sub.on("close", () => {
      const chunk = buildChatChunk(chatId, requestModel, {}, "stop", {
        prompt_tokens: usage.input_tokens,
        completion_tokens: usage.output_tokens,
        total_tokens: usage.input_tokens + usage.output_tokens,
      });
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      done();
    });

    sub.start(cliInput);
  });
}

function handleNonStream(
  res: Response,
  cliInput: { prompt: string; model: string; sessionId?: string; systemPrompt?: string },
  requestModel: string,
  config: Config,
  tenantName: string,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const sub = new ClaudeSubprocess({
      bin: config.cli.bin,
      timeout: config.cli.timeout,
      cwd: config.tenants.find((t) => t.name === tenantName)?.working_dir,
    });

    let content = "";
    let usage = { input_tokens: 0, output_tokens: 0 };

    sub.on("content_delta", (text: string) => { content += text; });
    sub.on("result", (result: { content?: string; usage?: { input_tokens: number; output_tokens: number } }) => {
      if (result.content) content = result.content;
      if (result.usage) usage = result.usage;
    });

    sub.on("error", (err: Error) => {
      if (!res.headersSent) {
        res.status(500).json({ error: { message: err.message, type: "server_error" } });
      }
      resolve();
    });

    sub.on("close", () => {
      if (!res.headersSent) {
        res.json(buildChatResponse(content, requestModel, usage));
      }
      resolve();
    });

    sub.start(cliInput);
  });
}
