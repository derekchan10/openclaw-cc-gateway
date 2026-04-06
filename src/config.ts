import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";

export interface Tenant {
  name: string;
  api_key: string;
  working_dir?: string;
  env?: Record<string, string>;
}

export interface Config {
  server: { port: number; host: string; docker_host_ip?: string };
  cli: { bin: string; timeout: number; max_concurrent: number; max_per_tenant: number; skill_file?: string };
  tenants: Tenant[];
  session: { ttl: number; cleanup_interval: number };
  skills: { sync: "auto" | "manual" | "disabled"; dir: string };
}

const DEFAULT_CONFIG: Config = {
  server: { port: 3456, host: "0.0.0.0" },
  cli: { bin: "claude", timeout: 900_000, max_concurrent: 3, max_per_tenant: 2 },
  tenants: [],
  session: { ttl: 3600, cleanup_interval: 900 },
  skills: { sync: "auto", dir: resolve(process.cwd(), "skills") },
};

export function loadConfig(configPath?: string): Config {
  const file = configPath || resolve(process.cwd(), "config.yaml");
  let raw: Record<string, unknown> = {};
  try {
    raw = yaml.load(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    console.warn(`[config] Could not load ${file}, using defaults + env`);
  }

  const cfg: Config = {
    server: {
      port: env("PORT", (raw.server as any)?.port) ?? DEFAULT_CONFIG.server.port,
      host: env("HOST", (raw.server as any)?.host) ?? DEFAULT_CONFIG.server.host,
      docker_host_ip: env("DOCKER_HOST_IP", (raw.server as any)?.docker_host_ip),
    },
    cli: {
      bin: env("CLAUDE_BIN", (raw.cli as any)?.bin) ?? DEFAULT_CONFIG.cli.bin,
      timeout: env("CLI_TIMEOUT", (raw.cli as any)?.timeout) ?? DEFAULT_CONFIG.cli.timeout,
      max_concurrent: env("MAX_CONCURRENT", (raw.cli as any)?.max_concurrent) ?? DEFAULT_CONFIG.cli.max_concurrent,
      max_per_tenant: env("MAX_PER_TENANT", (raw.cli as any)?.max_per_tenant) ?? DEFAULT_CONFIG.cli.max_per_tenant,
      skill_file: (raw.cli as any)?.skill_file ?? resolve(process.cwd(), "openclaw-skill.md"),
    },
    tenants: (raw.tenants as Tenant[]) || [],
    session: {
      ttl: (raw.session as any)?.ttl ?? DEFAULT_CONFIG.session.ttl,
      cleanup_interval: (raw.session as any)?.cleanup_interval ?? DEFAULT_CONFIG.session.cleanup_interval,
    },
    skills: {
      sync: (raw.skills as any)?.sync ?? DEFAULT_CONFIG.skills.sync,
      dir: (raw.skills as any)?.dir ?? DEFAULT_CONFIG.skills.dir,
    },
  };

  if (cfg.tenants.length === 0) {
    console.warn("[config] No tenants configured — all requests will be accepted without auth");
  }

  return cfg;
}

function env(key: string, fallback?: unknown): any {
  const v = process.env[key];
  if (v !== undefined) {
    const n = Number(v);
    return isNaN(n) ? v : n;
  }
  return fallback;
}
