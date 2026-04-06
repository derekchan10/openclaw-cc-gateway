import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { EventEmitter } from "node:events";
import type { CliInput } from "../types/cli.js";

export interface SubprocessOptions {
  bin?: string;
  timeout?: number;
  cwd?: string;
  skillsDir?: string;
  tenantName?: string;           // load skills from skills/<tenantName>/
  env?: Record<string, string>;  // extra env vars (from tenant config)
}

const MODEL_MAP: Record<string, string> = {
  "claude-opus-4": "opus",
  "claude-opus-4-6": "opus",
  "claude-opus-4-5": "opus",
  "claude-sonnet-4": "sonnet",
  "claude-sonnet-4-6": "sonnet",
  "claude-sonnet-4-5": "sonnet",
  "claude-haiku-4": "haiku",
  "claude-haiku-4-5": "haiku",
  opus: "opus",
  sonnet: "sonnet",
  haiku: "haiku",
};

export function mapModel(model: string): string {
  const base = model
    .replace(/^claude-code-cli\//, "")
    .replace(/^claude-max\//, "")
    .replace(/^cc-gateway\//, "");
  return MODEL_MAP[base] || "sonnet";
}

/**
 * Claude CLI subprocess that transparently emits Anthropic SSE events.
 *
 * Events emitted:
 *   "sse" (eventType: string, data: object) — raw Anthropic SSE event from CLI
 *   "assistant" (message: object) — CLI's assistant snapshot
 *   "result" (result: object) — CLI's final result
 *   "first_turn_done" (stopReason: string) — first message_stop, with stop_reason
 *   "error" (err: Error)
 *   "close" (code: number | null)
 */
export class ClaudeSubprocess extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private killed = false;
  private turnCount = 0;
  private lastStopReason = "";
  private _singleTurn = false;

  constructor(private opts: SubprocessOptions = {}) {
    super();
  }

  /**
   * If true, kill the CLI process after the first message_stop event.
   * This lets us intercept tool_use before CLI executes it.
   */
  set singleTurn(v: boolean) { this._singleTurn = v; }

  start(input: CliInput): void {
    const bin = this.opts.bin || "claude";
    const args = [
      "--print",
      "--dangerously-skip-permissions",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--model", mapModel(input.model),
      "--no-session-persistence",
      // Keep CLI built-in tools enabled so it can execute them internally.
      // The singleTurn mode controls whether to stop after the first message.
    ];

    // Add per-tenant synced skill directories: skills/<tenantName>/<skillName>/
    const baseSkillsDir = this.opts.skillsDir || resolve(process.cwd(), "skills");
    const tenantSkillsDir = this.opts.tenantName
      ? resolve(baseSkillsDir, this.opts.tenantName)
      : baseSkillsDir;
    if (existsSync(tenantSkillsDir)) {
      try {
        for (const entry of readdirSync(tenantSkillsDir)) {
          const skillPath = resolve(tenantSkillsDir, entry);
          if (statSync(skillPath).isDirectory() && existsSync(resolve(skillPath, "SKILL.md"))) {
            args.push("--add-dir", skillPath);
          }
        }
      } catch { /* ignore */ }
    }

    if (input.sessionId) {
      args.push("--session-id", input.sessionId);
    }

    if (input.systemPrompt) {
      args.push("--append-system-prompt", input.systemPrompt);
    }

    const env = { ...process.env, ...this.opts.env };
    delete env.CLAUDECODE;

    this.process = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: this.opts.cwd || process.cwd(),
      env,
    });

    this.process.stdin?.write(input.prompt);
    this.process.stdin?.end();

    this.process.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.process.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text && process.env.DEBUG) {
        console.error(`[cli:stderr] ${text}`);
      }
    });

    this.process.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        this.emit("error", new Error(
          `Claude CLI not found at "${bin}". Install with: npm install -g @anthropic-ai/claude-code`
        ));
      } else {
        this.emit("error", err);
      }
    });

    this.process.on("close", (code) => {
      if (this.buffer.trim()) {
        this.processBuffer();
      }
      this.emit("close", code);
    });

    const timeout = this.opts.timeout || 900_000;
    this.timer = setTimeout(() => {
      this.emit("error", new Error(`CLI subprocess timed out after ${timeout}ms`));
      this.kill();
    }, timeout);
  }

  kill(): void {
    if (this.killed || !this.process) return;
    this.killed = true;
    if (this.timer) clearTimeout(this.timer);

    this.process.kill("SIGTERM");
    setTimeout(() => {
      if (this.process && !this.process.killed) {
        this.process.kill("SIGKILL");
      }
    }, 5000);
  }

  private processBuffer(): void {
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const raw = JSON.parse(trimmed) as Record<string, unknown>;

        if (raw.type === "stream_event" && raw.event) {
          const inner = raw.event as Record<string, unknown>;

          // Emit raw SSE event for transparent passthrough
          this.emit("sse", inner.type as string, inner);

          // Track stop_reason from message_delta
          if (inner.type === "message_delta") {
            const delta = inner.delta as Record<string, unknown> | undefined;
            if (delta?.stop_reason) {
              this.lastStopReason = delta.stop_reason as string;
            }
          }

          // Track message_stop = end of one turn
          if (inner.type === "message_stop") {
            this.turnCount++;
            this.emit("first_turn_done", this.lastStopReason);

            // In singleTurn mode, signal completion after the first message.
            // Don't kill immediately — emit "turn_complete" so the handler
            // can cleanly end the HTTP response, THEN kill the CLI.
            if (this._singleTurn && this.turnCount === 1) {
              if (this.timer) clearTimeout(this.timer);
              this.emit("turn_complete", this.lastStopReason);
            }
          }

          // Also emit legacy events for OpenAI handler compatibility
          if (inner.type === "content_block_delta") {
            const delta = inner.delta as Record<string, unknown>;
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              this.emit("content_delta", delta.text);
            }
          }

        } else if (raw.type === "assistant") {
          this.emit("assistant", raw.message);
        } else if (raw.type === "result") {
          const usage = raw.usage as Record<string, unknown> | undefined;
          this.emit("result", {
            content: raw.result as string,
            usage: usage ? {
              input_tokens: ((usage.cache_read_input_tokens as number) || 0) +
                            ((usage.cache_creation_input_tokens as number) || 0) +
                            ((usage.input_tokens as number) || 0),
              output_tokens: (usage.output_tokens as number) || 0,
            } : undefined,
          });
          if (this.timer) clearTimeout(this.timer);
        } else if (raw.type === "error") {
          this.emit("error", new Error(String((raw as any).error || "Unknown CLI error")));
        }
      } catch {
        // Non-JSON line, ignore
      }
    }
  }
}

export async function verifyClaude(bin = "claude"): Promise<{ ok: boolean; version?: string; error?: string }> {
  return new Promise((resolve) => {
    const proc = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("error", () => resolve({ ok: false, error: `Claude CLI not found at "${bin}"` }));
    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ ok: true, version: out.trim() });
      } else {
        resolve({ ok: false, error: `Claude CLI exited with code ${code}` });
      }
    });
  });
}
