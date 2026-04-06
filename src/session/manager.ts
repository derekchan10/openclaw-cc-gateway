import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { v4 as uuidv4 } from "uuid";

interface SessionEntry {
  cliSessionId: string;
  createdAt: number;
  lastUsedAt: number;
  model: string;
}

export class SessionManager {
  private sessions = new Map<string, SessionEntry>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private filePath: string;

  constructor(
    private ttlMs: number = 3600_000,
    cleanupIntervalMs: number = 900_000,
    storePath?: string,
  ) {
    this.filePath = storePath || resolve(process.env.HOME || "/tmp", ".claude-cli-gateway", "sessions.json");
    this.load();
    this.cleanupTimer = setInterval(() => this.cleanup(), cleanupIntervalMs);
  }

  /**
   * Get or create a CLI session ID, scoped by tenant name.
   * The key is `${tenantName}:${conversationId}` to guarantee isolation.
   */
  getOrCreate(tenantName: string, conversationId: string, model: string): string {
    const key = `${tenantName}:${conversationId}`;
    const now = Date.now();

    const existing = this.sessions.get(key);
    if (existing && now - existing.lastUsedAt < this.ttlMs) {
      existing.lastUsedAt = now;
      this.save();
      return existing.cliSessionId;
    }

    const entry: SessionEntry = {
      cliSessionId: uuidv4(),
      createdAt: now,
      lastUsedAt: now,
      model,
    };
    this.sessions.set(key, entry);
    this.save();
    return entry.cliSessionId;
  }

  private cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.sessions) {
      if (now - entry.lastUsedAt > this.ttlMs) {
        this.sessions.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      this.save();
    }
  }

  private load(): void {
    try {
      const data = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (Array.isArray(data)) {
        for (const [key, value] of data) {
          this.sessions.set(key, value);
        }
      }
    } catch {
      // No existing file
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(Array.from(this.sessions.entries())));
    } catch {
      // Ignore write errors
    }
  }

  destroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }
}
