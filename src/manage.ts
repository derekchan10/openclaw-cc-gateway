/**
 * CLI management tool for tenants.
 *
 * Usage:
 *   node dist/manage.js add <name> [--key <key>] [--docker <container>] [--working-dir <path>] [--apply]
 *   node dist/manage.js remove <name>
 *   node dist/manage.js list
 *   node dist/manage.js gen-key
 *   node dist/manage.js apply [name]        — push config to OpenClaw instance(s)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import yaml from "js-yaml";
import { generateApiKey, detectDockerHostIP, discoverInstances } from "./discover.js";
import { discoverSkills, syncSkills, cleanSkills, listSyncedSkills } from "./skills.js";
import type { Tenant, Config } from "./config.js";

const CONFIG_PATH = resolve(process.cwd(), "config.yaml");

function loadRawConfig(): Record<string, unknown> {
  if (!existsSync(CONFIG_PATH)) {
    console.error(`Config not found: ${CONFIG_PATH}`);
    console.error("Run: node dist/index.js --setup");
    process.exit(1);
  }
  return yaml.load(readFileSync(CONFIG_PATH, "utf8")) as Record<string, unknown>;
}

function saveConfig(raw: Record<string, unknown>): void {
  writeFileSync(CONFIG_PATH, yaml.dump(raw, { lineWidth: 120, noRefs: true }));
}

function getTenants(raw: Record<string, unknown>): Tenant[] {
  return (raw.tenants || []) as Tenant[];
}

function getGatewayUrl(raw: Record<string, unknown>): string {
  const server = raw.server as Record<string, unknown> | undefined;
  const ip = (server?.docker_host_ip as string) || detectDockerHostIP();
  const port = (server?.port as number) || 3456;
  return `http://${ip}:${port}`;
}

// ── Commands ──

function cmdList() {
  const raw = loadRawConfig();
  const tenants = getTenants(raw);
  if (tenants.length === 0) {
    console.log("No tenants configured.");
    return;
  }
  console.log(`${tenants.length} tenant(s):\n`);
  console.log("  Name            API Key                            Working Dir");
  console.log("  ─────────────── ────────────────────────────────── ───────────");
  for (const t of tenants) {
    const key = t.api_key.slice(0, 16) + "..." + t.api_key.slice(-8);
    console.log(`  ${t.name.padEnd(16)}${key.padEnd(35)}${t.working_dir || ""}`);
  }
}

function cmdAdd(name: string, opts: { key?: string; docker?: string; workingDir?: string; apply?: boolean }) {
  if (!name) {
    console.error("Usage: manage add <name> [--key <key>] [--docker <container>] [--working-dir <path>] [--apply]");
    process.exit(1);
  }

  const raw = loadRawConfig();
  const tenants = getTenants(raw);

  // Check duplicate
  if (tenants.some((t) => t.name === name)) {
    console.error(`Tenant "${name}" already exists. Use 'remove' first or edit config.yaml.`);
    process.exit(1);
  }

  const apiKey = opts.key || generateApiKey();
  const tenant: Tenant = { name, api_key: apiKey };
  if (opts.workingDir) tenant.working_dir = opts.workingDir;

  tenants.push(tenant);
  raw.tenants = tenants;
  saveConfig(raw);

  console.log(`Added tenant "${name}"`);
  console.log(`  API Key: ${apiKey}`);
  if (opts.workingDir) console.log(`  Working Dir: ${opts.workingDir}`);

  // Apply to OpenClaw instance
  if (opts.apply) {
    applyToInstance(raw, name, apiKey, opts.docker);
  } else {
    console.log("\nTo apply to OpenClaw instance, run:");
    console.log(`  node dist/manage.js apply ${name}`);
    console.log("\nOr set in OpenClaw manually:");
    const gatewayUrl = getGatewayUrl(raw);
    console.log(`  ANTHROPIC_BASE_URL=${gatewayUrl}`);
    console.log(`  ANTHROPIC_API_KEY=${apiKey}`);
  }

  console.log("\nRestart the gateway to load the new tenant:");
  console.log("  pm2 restart openclaw-cc-gateway");
}

function cmdRemove(name: string) {
  if (!name) {
    console.error("Usage: manage remove <name>");
    process.exit(1);
  }

  const raw = loadRawConfig();
  const tenants = getTenants(raw);
  const idx = tenants.findIndex((t) => t.name === name);
  if (idx === -1) {
    console.error(`Tenant "${name}" not found.`);
    process.exit(1);
  }

  tenants.splice(idx, 1);
  raw.tenants = tenants;
  saveConfig(raw);
  console.log(`Removed tenant "${name}".`);
  console.log("Restart the gateway: pm2 restart openclaw-cc-gateway");
}

function cmdGenKey() {
  console.log(generateApiKey());
}

function cmdApply(name?: string) {
  const raw = loadRawConfig();
  const tenants = getTenants(raw);
  const gatewayUrl = getGatewayUrl(raw);

  const targets = name ? tenants.filter((t) => t.name === name) : tenants;
  if (targets.length === 0) {
    console.error(name ? `Tenant "${name}" not found.` : "No tenants to apply.");
    process.exit(1);
  }

  // Discover running instances for container mapping
  const instances = discoverInstances();

  for (const tenant of targets) {
    console.log(`\nApplying "${tenant.name}"...`);

    // Find matching instance
    const inst = instances.find((i) => i.name === tenant.name);
    if (inst) {
      applyToInstance(raw, tenant.name, tenant.api_key, inst.container);
    } else {
      console.log(`  ⚠ No running instance found for "${tenant.name}"`);
      console.log(`    Set manually:`);
      console.log(`      ANTHROPIC_BASE_URL=${gatewayUrl}`);
      console.log(`      ANTHROPIC_API_KEY=${tenant.api_key}`);
    }
  }
}

function applyToInstance(raw: Record<string, unknown>, name: string, apiKey: string, container?: string) {
  const gatewayUrl = getGatewayUrl(raw);

  // 1. Try to update openclaw.json via discovered config dir
  const instances = discoverInstances();
  const inst = instances.find((i) => i.name === name);
  const configDir = inst?.configDir;

  if (configDir) {
    const ocConfigPath = resolve(configDir, "openclaw.json");
    if (existsSync(ocConfigPath)) {
      try {
        const ocRaw = readFileSync(ocConfigPath, "utf8").replace(/,(\s*[}\]])/g, "$1");
        const d = JSON.parse(ocRaw);
        const providers = d.models?.providers;
        if (providers) {
          const providerName = Object.keys(providers)[0];
          if (providerName) {
            providers[providerName].baseUrl = gatewayUrl;
            providers[providerName].apiKey = apiKey;
            writeFileSync(ocConfigPath, JSON.stringify(d, null, 2));
            console.log(`  ✓ Updated ${ocConfigPath}`);
          }
        }
      } catch (e) {
        console.log(`  ⚠ Could not update openclaw.json: ${e}`);
      }
    }
  }

  // 2. Try to update .env file
  const home = process.env.HOME || "/tmp";
  const envFile = resolve(home, "openclaw", name === "dc" ? ".env" : `.env.${name}`);
  if (existsSync(envFile)) {
    try {
      let content = readFileSync(envFile, "utf8");
      let changed = false;

      if (content.includes("ANTHROPIC_BASE_URL=")) {
        content = content.replace(/ANTHROPIC_BASE_URL=.*/g, `ANTHROPIC_BASE_URL=${gatewayUrl}`);
        changed = true;
      } else {
        content += `\nANTHROPIC_BASE_URL=${gatewayUrl}\n`;
        changed = true;
      }

      if (content.includes("ANTHROPIC_API_KEY=")) {
        if (!content.includes(`ANTHROPIC_API_KEY=${apiKey}`)) {
          content = content.replace(/ANTHROPIC_API_KEY=.*/g, `ANTHROPIC_API_KEY=${apiKey}`);
          changed = true;
        }
      } else {
        content += `ANTHROPIC_API_KEY=${apiKey}\n`;
        changed = true;
      }

      if (changed) {
        writeFileSync(envFile, content);
        console.log(`  ✓ Updated ${envFile}`);
      }
    } catch { /* skip */ }
  }

  // 3. Show restart hint
  const ctr = container || inst?.container;
  if (ctr) {
    console.log(`  → Restart: docker restart ${ctr}`);
  }
}

// ── Skill commands ──

function cmdSkillsList(tenantName?: string) {
  const instances = discoverInstances();
  const targets = tenantName
    ? instances.filter((i) => i.name === tenantName)
    : instances;

  if (targets.length === 0) {
    console.error(tenantName ? `No instance found for "${tenantName}".` : "No OpenClaw instances found.");
    process.exit(1);
  }

  for (const inst of targets) {
    const skills = discoverSkills(inst);
    console.log(`\n${inst.mode === "docker" ? "🐳" : "💻"} ${inst.name} (${inst.container || "local"}) — ${skills.length} skills:\n`);
    if (skills.length === 0) {
      console.log("  (none)");
      continue;
    }
    for (const s of skills) {
      const emoji = s.emoji || "  ";
      const src = `[${s.source}]`.padEnd(12);
      const desc = s.description.length > 60 ? s.description.slice(0, 57) + "..." : s.description;
      console.log(`  ${emoji} ${s.name.padEnd(24)} ${src} ${desc}`);
    }
  }

  // Show synced status
  const raw = loadRawConfig();
  const skillsDir = (raw.skills as any)?.dir || resolve(process.cwd(), "skills");
  const synced = listSyncedSkills(skillsDir);
  if (synced.length > 0) {
    console.log(`\n✓ ${synced.length} skills synced locally in ${skillsDir}`);
  }
}

function cmdSkillsSync(tenantName?: string, all?: boolean) {
  const instances = discoverInstances();
  let targets: typeof instances;

  if (all || tenantName === "--all") {
    targets = instances;
  } else if (tenantName) {
    targets = instances.filter((i) => i.name === tenantName);
  } else {
    targets = instances;
  }

  if (targets.length === 0) {
    console.error(tenantName ? `No instance "${tenantName}" found.` : "No OpenClaw instances found.");
    process.exit(1);
  }

  const raw = loadRawConfig();
  const skillsDir = (raw.skills as any)?.dir || resolve(process.cwd(), "skills");

  let totalSynced = 0;
  const allErrors: string[] = [];

  for (const inst of targets) {
    console.log(`\n${inst.name}: discovering skills...`);
    const skills = discoverSkills(inst);
    console.log(`  Found ${skills.length} skills`);

    if (skills.length === 0) continue;

    const result = syncSkills(inst, skills, skillsDir, inst.name);
    totalSynced += result.synced;
    allErrors.push(...result.errors);
    console.log(`  ✓ ${result.synced} skills → ${skillsDir}/${inst.name}/`);
    if (result.errors.length > 0) {
      for (const e of result.errors) console.log(`  ⚠ ${e}`);
    }
  }

  console.log(`\nTotal: ${totalSynced} skills synced (${targets.length} tenants)`);
  console.log("Restart the gateway: pm2 restart openclaw-cc-gateway");
}

function cmdSkillsClean() {
  const raw = loadRawConfig();
  const skillsDir = (raw.skills as any)?.dir || resolve(process.cwd(), "skills");
  const removed = cleanSkills(skillsDir);
  console.log(`Removed ${removed} synced skills from ${skillsDir}`);
}

// ── Parse args ──

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  switch (cmd) {
    case "list":
    case "ls":
      cmdList();
      break;

    case "add": {
      const name = args[1];
      const opts: { key?: string; docker?: string; workingDir?: string; apply?: boolean } = {};
      for (let i = 2; i < args.length; i++) {
        switch (args[i]) {
          case "--key": opts.key = args[++i]; break;
          case "--docker": opts.docker = args[++i]; break;
          case "--working-dir": opts.workingDir = args[++i]; break;
          case "--apply": opts.apply = true; break;
        }
      }
      cmdAdd(name, opts);
      break;
    }

    case "remove":
    case "rm":
      cmdRemove(args[1]);
      break;

    case "gen-key":
      cmdGenKey();
      break;

    case "apply":
      cmdApply(args[1]);
      break;

    case "skills": {
      const sub = args[1];
      switch (sub) {
        case "list":
          cmdSkillsList(args[2]);
          break;
        case "sync":
          cmdSkillsSync(args[2], args.includes("--all"));
          break;
        case "clean":
          cmdSkillsClean();
          break;
        default:
          console.log(`Usage:
  node dist/manage.js skills list [tenant]    List skills from OpenClaw instance
  node dist/manage.js skills sync [tenant]    Sync skills to local directory
  node dist/manage.js skills sync --all       Sync from all instances
  node dist/manage.js skills clean            Remove all synced skills`);
      }
      break;
    }

    default:
      console.log(`OpenClaw CC Gateway — Tenant Manager

Usage:
  node dist/manage.js <command> [options]

Commands:
  list                          List all tenants
  add <name> [options]          Add a new tenant
    --key <key>                   Use specific API key (default: auto-generate)
    --working-dir <path>          Set working directory
    --docker <container>          Docker container name
    --apply                       Apply config to OpenClaw instance immediately
  remove <name>                 Remove a tenant
  apply [name]                  Push gateway config to OpenClaw instance(s)
  gen-key                       Generate a random API key
  skills list [tenant]          List skills from OpenClaw instance(s)
  skills sync [tenant|--all]    Sync skills to local ./skills/ directory
  skills clean                  Remove all synced skills

Examples:
  node dist/manage.js add mybot --apply
  node dist/manage.js list
  node dist/manage.js skills list dc
  node dist/manage.js skills sync dc
  node dist/manage.js skills sync --all
`);
  }
}

main();
