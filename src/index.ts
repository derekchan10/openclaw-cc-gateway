import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "./config.js";
import { createServer } from "./server/server.js";
import { verifyClaude } from "./cli/subprocess.js";
import { discoverInstances, generateApiKey, detectDockerHostIP, extractInstanceEnv } from "./discover.js";
import { discoverSkills, syncSkills } from "./skills.js";

async function main() {
  const args = process.argv.slice(2);
  const isSetup = args.includes("--setup");
  const noSkills = args.includes("--no-skills");
  const forceSkills = args.includes("--skills");
  const configPath = args.find((a) => !a.startsWith("-"));

  const configFile = configPath || resolve(process.cwd(), "config.yaml");
  if (isSetup || !existsSync(configFile)) {
    console.log("[gateway] Running auto-setup...");
    await runAutoSetup(configFile, { syncSkills: !noSkills });
  } else if (forceSkills) {
    console.log("[gateway] Syncing skills...");
    await runSkillSync(configFile);
  }

  const config = loadConfig(configFile);

  const cli = await verifyClaude(config.cli.bin);
  if (!cli.ok) {
    console.error(`[gateway] ${cli.error}`);
    process.exit(1);
  }
  console.log(`[gateway] Claude CLI: ${cli.version}`);

  const { app, sessions } = createServer(config);

  app.listen(config.server.port, config.server.host, () => {
    console.log(`[gateway] Listening on ${config.server.host}:${config.server.port}`);
    console.log(`[gateway] Max concurrent: ${config.cli.max_concurrent}`);
    if (config.tenants.length > 0) {
      console.log(`[gateway] Tenants: ${config.tenants.map((t) => t.name).join(", ")}`);
    } else {
      console.log(`[gateway] No tenants — auth disabled`);
    }
    console.log(`[gateway] Endpoints:`);
    console.log(`         POST /v1/messages          (Anthropic)`);
    console.log(`         POST /v1/chat/completions   (OpenAI)`);
    console.log(`         GET  /v1/models`);
    console.log(`         GET  /health`);
  });

  const shutdown = () => {
    console.log("\n[gateway] Shutting down...");
    sessions.destroy();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function runAutoSetup(configFile: string, opts: { syncSkills?: boolean } = {}) {
  const yaml = await import("js-yaml");

  // Detect Docker host IP
  const dockerHostIP = detectDockerHostIP();
  console.log(`[setup] Docker host IP: ${dockerHostIP}`);

  // Load existing tenant keys to preserve them
  const existingKeys = new Map<string, string>();
  let existingRaw: Record<string, unknown> = {};
  if (existsSync(configFile)) {
    try {
      existingRaw = yaml.default.load(readFileSync(configFile, "utf8")) as Record<string, unknown>;
      for (const t of (existingRaw.tenants || []) as Array<{ name: string; api_key: string }>) {
        existingKeys.set(t.name, t.api_key);
      }
    } catch { /* start fresh */ }
  }

  // Discover instances
  const instances = discoverInstances();
  console.log(`[setup] Found ${instances.length} OpenClaw instance(s):`);
  for (const inst of instances) {
    console.log(`  ${inst.mode === "docker" ? "🐳" : "💻"} ${inst.name} (${inst.container || "local"})`);
  }

  // Build tenants with env vars from each instance
  const tenants = instances.map((inst) => {
    const envVars = extractInstanceEnv(inst);
    const hasEnv = Object.keys(envVars).length > 0;
    if (hasEnv) {
      console.log(`[setup]   ${inst.name}: ${Object.keys(envVars).length} env vars extracted`);
    }
    return {
      name: inst.name,
      api_key: existingKeys.get(inst.name) || generateApiKey(),
      ...(inst.mode === "local" && inst.configDir ? { working_dir: inst.configDir } : {}),
      ...(hasEnv ? { env: envVars } : {}),
    };
  });

  // Resolve skill file path relative to config file location
  const configDir = resolve(configFile, "..");
  const skillFile = resolve(configDir, "openclaw-skill.md");

  // Determine port from existing config or default
  const port = ((existingRaw.server as any)?.port as number) || 3456;

  const config = {
    server: {
      port,
      host: "0.0.0.0",
      docker_host_ip: dockerHostIP,
    },
    cli: {
      bin: ((existingRaw.cli as any)?.bin as string) || "claude",
      timeout: ((existingRaw.cli as any)?.timeout as number) || 900000,
      max_concurrent: ((existingRaw.cli as any)?.max_concurrent as number) || 3,
      skill_file: skillFile,
    },
    session: {
      ttl: ((existingRaw.session as any)?.ttl as number) || 3600,
      cleanup_interval: ((existingRaw.session as any)?.cleanup_interval as number) || 900,
    },
    skills: {
      sync: ((existingRaw.skills as any)?.sync as string) || "auto",
      dir: ((existingRaw.skills as any)?.dir as string) || resolve(configDir, "skills"),
    },
    tenants,
  };

  writeFileSync(configFile, yaml.default.dump(config, { lineWidth: 120, noRefs: true }));
  console.log(`[setup] Config written to ${configFile}`);

  // Update OpenClaw instances
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
            console.log(`[setup] ✓ ${inst.name}: openclaw.json → ${gatewayUrl}`);
          }
        }
      } catch { /* skip */ }
    }
  }

  // Sync skills per tenant (each tenant gets its own skill directory)
  if (opts.syncSkills !== false && config.skills.sync !== "disabled") {
    console.log(`[setup] Syncing skills (per-tenant isolation)...`);
    const skillsDir = config.skills.dir;
    let totalSynced = 0;
    for (const inst of instances) {
      const skills = discoverSkills(inst);
      if (skills.length === 0) continue;
      const result = syncSkills(inst, skills, skillsDir, inst.name);
      totalSynced += result.synced;
      console.log(`[setup]   ✓ ${inst.name}: ${result.synced} skills → ${skillsDir}/${inst.name}/`);
      if (result.errors.length > 0) {
        for (const e of result.errors) console.log(`[setup]     ⚠ ${e}`);
      }
    }
    console.log(`[setup] ✓ ${totalSynced} skills synced (${instances.length} tenants)`);
  }
}

async function runSkillSync(configFile: string) {
  const yaml = await import("js-yaml");
  const raw = yaml.default.load(readFileSync(configFile, "utf8")) as Record<string, unknown>;
  const skillsDir = (raw.skills as any)?.dir || resolve(process.cwd(), "skills");
  const instances = discoverInstances();
  let total = 0;
  for (const inst of instances) {
    const skills = discoverSkills(inst);
    if (skills.length === 0) continue;
    const result = syncSkills(inst, skills, skillsDir, inst.name);
    total += result.synced;
    console.log(`[skills] ✓ ${inst.name}: ${result.synced} skills → ${skillsDir}/${inst.name}/`);
  }
  console.log(`[skills] ✓ ${total} skills synced (${instances.length} tenants)`);
}

main().catch((err) => {
  console.error("[gateway] Fatal:", err);
  process.exit(1);
});
