import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import {
  discoverInstances,
  generateApiKey,
  readOpenClawConfig,
  detectDockerHostIP,
  extractInstanceEnv,
} from "./discover.js";
import { verifyClaude } from "./cli/subprocess.js";
import type { Tenant } from "./config.js";

const CONFIG_PATH = resolve(process.cwd(), "config.yaml");

async function main() {
  console.log("╔══════════════════════════════════════════════╗");
  console.log("║     OpenClaw CC Gateway — Auto Setup         ║");
  console.log("╚══════════════════════════════════════════════╝\n");

  // 1. Verify Claude CLI
  console.log("[1/5] Checking Claude CLI...");
  const cli = await verifyClaude();
  if (!cli.ok) {
    console.error(`  ✗ ${cli.error}`);
    console.error("  Install: npm install -g @anthropic-ai/claude-code && claude auth login");
    process.exit(1);
  }
  console.log(`  ✓ Claude CLI ${cli.version}`);

  // 2. Detect Docker host IP
  console.log("\n[2/5] Detecting Docker host IP...");
  const dockerHostIP = detectDockerHostIP();
  console.log(`  ✓ ${dockerHostIP}`);

  // 3. Discover OpenClaw instances
  console.log("\n[3/5] Discovering OpenClaw instances...");
  const instances = discoverInstances();

  if (instances.length === 0) {
    console.log("  ✗ No OpenClaw instances found.");
    process.exit(1);
  }

  for (const inst of instances) {
    const providerInfo = inst.configDir ? readOpenClawConfig(inst.configDir) : null;
    console.log(`  ✓ ${inst.name} (${inst.mode})`);
    console.log(`    Container: ${inst.container || "N/A"}`);
    console.log(`    Config: ${inst.configDir || "N/A"}`);
    if (providerInfo) {
      console.log(`    Provider: ${providerInfo.providerName} → ${providerInfo.baseUrl}`);
    }
  }

  // 4. Generate config
  console.log("\n[4/5] Generating config.yaml...");
  const existingKeys = new Map<string, string>();
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = yaml.load(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
      for (const t of (raw.tenants || []) as Tenant[]) {
        existingKeys.set(t.name, t.api_key);
      }
      console.log(`  ℹ Found existing config with ${existingKeys.size} tenants`);
    } catch { /* start fresh */ }
  }

  const port = 3456;
  const tenants: Tenant[] = instances.map((inst) => {
    const envVars = extractInstanceEnv(inst);
    const hasEnv = Object.keys(envVars).length > 0;
    if (hasEnv) console.log(`    ${inst.name}: ${Object.keys(envVars).length} env vars`);
    return {
      name: inst.name,
      api_key: existingKeys.get(inst.name) || generateApiKey(),
      ...(inst.mode === "local" && inst.configDir ? { working_dir: inst.configDir } : {}),
      ...(hasEnv ? { env: envVars } : {}),
    };
  });

  const config = {
    server: { port, host: "0.0.0.0", docker_host_ip: dockerHostIP },
    cli: {
      bin: "claude",
      timeout: 900000,
      max_concurrent: 3,
      skill_file: resolve(process.cwd(), "openclaw-skill.md"),
    },
    session: { ttl: 3600, cleanup_interval: 900 },
    tenants,
  };

  writeFileSync(CONFIG_PATH, yaml.dump(config, { lineWidth: 120, noRefs: true }));
  console.log(`  ✓ Written to ${CONFIG_PATH}`);
  for (const t of tenants) {
    const isNew = !existingKeys.has(t.name);
    console.log(`    ${isNew ? "(new)" : "(keep)"} ${t.name} → key:${t.api_key.slice(0, 12)}...`);
  }

  // 5. Update OpenClaw instances
  console.log("\n[5/5] Updating OpenClaw instances...");
  const gatewayUrl = `http://${dockerHostIP}:${port}`;

  for (const inst of instances) {
    const tenant = tenants.find((t) => t.name === inst.name);
    if (!tenant || !inst.configDir) continue;

    const ocConfigPath = resolve(inst.configDir, "openclaw.json");
    if (existsSync(ocConfigPath)) {
      try {
        const raw = readFileSync(ocConfigPath, "utf8").replace(/,(\s*[}\]])/g, "$1");
        const d = JSON.parse(raw);
        const providers = d.models?.providers;
        if (providers) {
          const providerName = Object.keys(providers)[0];
          if (providerName) {
            providers[providerName].baseUrl = gatewayUrl;
            providers[providerName].apiKey = tenant.api_key;
            writeFileSync(ocConfigPath, JSON.stringify(d, null, 2));
            console.log(`  ✓ ${inst.name}: openclaw.json → ${gatewayUrl}`);
          }
        }
      } catch {
        console.log(`  ⚠ ${inst.name}: could not update openclaw.json`);
      }
    }

    // Update .env files
    if (inst.mode === "docker") {
      const envPaths = findEnvFiles(inst.name);
      for (const envPath of envPaths) {
        try {
          let content = readFileSync(envPath, "utf8");
          let changed = false;
          if (content.includes("ANTHROPIC_BASE_URL=")) {
            content = content.replace(/ANTHROPIC_BASE_URL=.*/g, `ANTHROPIC_BASE_URL=${gatewayUrl}`);
            changed = true;
          }
          if (content.includes("ANTHROPIC_API_KEY=") && !content.includes(`ANTHROPIC_API_KEY=${tenant.api_key}`)) {
            content = content.replace(/ANTHROPIC_API_KEY=.*/g, `ANTHROPIC_API_KEY=${tenant.api_key}`);
            changed = true;
          }
          if (changed) {
            writeFileSync(envPath, content);
            console.log(`  ✓ ${inst.name}: ${envPath}`);
          }
        } catch { /* skip */ }
      }
    }
  }

  // Summary
  console.log("\n" + "═".repeat(50));
  console.log("Setup complete!\n");
  console.log("Start:   npm start");
  console.log("PM2:     pm2 start dist/index.js --name openclaw-cc-gateway");
  console.log(`Gateway: ${gatewayUrl}`);
  console.log("\nRestart OpenClaw containers:");
  console.log("  cd ~/openclaw && ./manage.sh restart-all");
}

function findEnvFiles(tenantName: string): string[] {
  // Search for .env files in common locations
  const home = process.env.HOME || "/tmp";
  const candidates = [
    resolve(home, "openclaw", tenantName === "dc" ? ".env" : `.env.${tenantName}`),
  ];
  return candidates.filter(existsSync);
}

main().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
