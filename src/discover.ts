import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { Tenant } from "./config.js";

export interface DiscoveredInstance {
  name: string;
  container: string;
  port: number;
  configDir: string;
  mode: "docker" | "local";
}

/**
 * Discover all running OpenClaw instances.
 */
export function discoverInstances(): DiscoveredInstance[] {
  const instances: DiscoveredInstance[] = [];

  // 1. Docker containers
  try {
    const output = execSync(
      'docker ps --filter "name=openclaw-gateway" --format "{{.Names}}\\t{{.Ports}}"',
      { encoding: "utf8", timeout: 5000 },
    ).trim();

    for (const line of output.split("\n")) {
      if (!line.trim()) continue;
      const [containerName, ports] = line.split("\t");
      if (!containerName) continue;

      let name: string;
      const match = containerName.match(/^(.+)-openclaw-gateway-\d+$/);
      if (match) {
        name = match[1] === "openclaw" ? "dc" : match[1];
      } else {
        name = containerName;
      }

      let port = 18789;
      const portMatch = ports?.match(/(\d+)->18789/);
      if (portMatch) port = parseInt(portMatch[1], 10);

      let configDir = "";
      try {
        const mounts = execSync(
          `docker inspect ${containerName} --format '{{range .Mounts}}{{.Source}}:{{.Destination}}|{{end}}'`,
          { encoding: "utf8", timeout: 5000 },
        ).trim();
        for (const m of mounts.split("|")) {
          const [src, dst] = m.split(":");
          if (dst === "/home/node/.openclaw" && src) {
            configDir = src;
            break;
          }
        }
      } catch { /* ignore */ }

      instances.push({ name, container: containerName, port, configDir, mode: "docker" });
    }
  } catch { /* Docker not available */ }

  // 2. Local openclaw
  try {
    execSync("which openclaw", { encoding: "utf8", timeout: 3000 });
    const localName = "local";
    if (!instances.some((i) => i.name === localName)) {
      instances.push({
        name: localName,
        container: "",
        port: 0,
        configDir: resolve(process.env.HOME || "/tmp", ".openclaw"),
        mode: "local",
      });
    }
  } catch { /* not installed */ }

  return instances;
}

/**
 * Generate a random API key.
 */
export function generateApiKey(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Detect the Docker host IP accessible from containers.
 * Tries docker bridge gateway, then falls back to common defaults.
 */
export function detectDockerHostIP(): string {
  // env override
  if (process.env.DOCKER_HOST_IP) return process.env.DOCKER_HOST_IP;

  // Try docker bridge network gateway
  try {
    const ip = execSync(
      "docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}'",
      { encoding: "utf8", timeout: 5000 },
    ).trim();
    if (ip && ip !== "<nil>") return ip;
  } catch { /* ignore */ }

  // Try host.docker.internal (Docker Desktop)
  try {
    execSync("getent hosts host.docker.internal", { encoding: "utf8", timeout: 3000 });
    return "host.docker.internal";
  } catch { /* ignore */ }

  // Default
  return "172.17.0.1";
}

/**
 * Extract env vars from an OpenClaw instance's openclaw.json `env` block.
 * For Docker instances, automatically maps container paths to host paths.
 */
export function extractInstanceEnv(instance: DiscoveredInstance): Record<string, string> {
  let env: Record<string, string> = {};

  if (instance.mode === "docker") {
    try {
      const output = execSync(
        `docker exec ${instance.container} node -e "
          const fs = require('fs');
          const raw = fs.readFileSync('/home/node/.openclaw/openclaw.json','utf8').replace(/,(\\s*[}\\]])/g, '\\$1');
          const d = JSON.parse(raw);
          console.log(JSON.stringify(d.env || {}));
        "`,
        { encoding: "utf8", timeout: 5000 },
      ).trim();
      env = JSON.parse(output);
    } catch { return {}; }

    // Map container paths to host paths
    const containerHome = detectContainerHome(instance.container);
    const hostHome = process.env.HOME || "/home/" + (process.env.USER || "user");
    if (containerHome && containerHome !== hostHome) {
      for (const [key, val] of Object.entries(env)) {
        if (typeof val === "string" && val.includes(containerHome)) {
          env[key] = val.replace(new RegExp(escapeRegExp(containerHome), "g"), hostHome);
        }
      }
    }
    return env;
  }

  // Local mode
  if (!instance.configDir) return {};
  const configPath = resolve(instance.configDir, "openclaw.json");
  if (!existsSync(configPath)) return {};
  try {
    const raw = readFileSync(configPath, "utf8").replace(/,(\s*[}\]])/g, "$1");
    const d = JSON.parse(raw);
    return d.env || {};
  } catch { return {}; }
}

/**
 * Detect the HOME directory inside a Docker container.
 */
function detectContainerHome(container: string): string {
  try {
    return execSync(
      `docker exec ${container} sh -c 'echo $HOME'`,
      { encoding: "utf8", timeout: 3000 },
    ).trim();
  } catch {
    return "/home/node"; // OpenClaw default
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Read openclaw.json and extract model provider info.
 */
export function readOpenClawConfig(configDir: string): {
  providerName?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: Array<{ id: string; name: string }>;
} | null {
  const configPath = resolve(configDir, "openclaw.json");
  if (!existsSync(configPath)) return null;

  try {
    const raw = readFileSync(configPath, "utf8").replace(/,(\s*[}\]])/g, "$1");
    const d = JSON.parse(raw);
    const providers = d.models?.providers;
    if (!providers) return null;

    const providerName = Object.keys(providers)[0];
    if (!providerName) return null;
    const p = providers[providerName];
    return {
      providerName,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      models: p.models,
    };
  } catch {
    return null;
  }
}
