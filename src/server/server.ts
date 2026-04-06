import express from "express";
import type { Config } from "../config.js";
import { createAuthMiddleware } from "./auth.js";
import { createAnthropicHandler } from "./anthropic-handler.js";
import { createOpenAIHandler } from "./openai-handler.js";
import { ConcurrencyQueue } from "../cli/queue.js";
import { SessionManager } from "../session/manager.js";
import { mapModel } from "../cli/subprocess.js";

export function createServer(config: Config) {
  const app = express();
  app.use(express.json({ limit: "10mb" }));

  const queue = new ConcurrencyQueue(config.cli.max_concurrent);
  const sessions = new SessionManager(
    config.session.ttl * 1000,
    config.session.cleanup_interval * 1000,
  );
  const auth = createAuthMiddleware(config.tenants);

  // Request logging
  app.use((req, _res, next) => {
    if (req.path !== "/health") {
      const tenant = req.headers["x-api-key"] ? "key:" + (req.headers["x-api-key"] as string).slice(0, 8) + "..." : "no-key";
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} (${tenant})`);
    }
    next();
  });

  // Health check (no auth)
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      provider: "claude-cli-gateway",
      tenants: config.tenants.map((t) => t.name),
      queue: queue.stats,
      timestamp: new Date().toISOString(),
    });
  });

  // Models endpoint (no auth)
  app.get("/v1/models", (_req, res) => {
    const models = [
      { id: "claude-opus-4-6", name: "Claude Opus 4.6" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
      { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
      { id: "claude-opus-4", name: "Claude Opus 4" },
    ];
    res.json({
      object: "list",
      data: models.map((m) => ({
        id: m.id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "anthropic",
      })),
    });
  });

  // Anthropic Messages API (what OpenClaw uses)
  app.post("/v1/messages", auth, createAnthropicHandler(config, queue, sessions));

  // OpenAI Chat Completions API (compatibility)
  app.post("/v1/chat/completions", auth, createOpenAIHandler(config, queue, sessions));

  return { app, sessions };
}
