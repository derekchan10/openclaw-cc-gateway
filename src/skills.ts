import { execSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, readdirSync, cpSync, rmSync, statSync } from "node:fs";
import { resolve, basename, dirname, join } from "node:path";
import type { DiscoveredInstance } from "./discover.js";

export interface SkillInfo {
  name: string;
  description: string;
  source: string;       // "bundled" | "extension" | "workspace" | "managed"
  path: string;         // absolute path to skill directory
  emoji?: string;
}

/**
 * Discover all skills from an OpenClaw instance.
 */
export function discoverSkills(instance: DiscoveredInstance): SkillInfo[] {
  if (instance.mode === "docker") {
    return discoverDockerSkills(instance.container);
  }
  return discoverLocalSkills(instance.configDir);
}

function discoverDockerSkills(container: string): SkillInfo[] {
  const skills: SkillInfo[] = [];

  try {
    // Find all SKILL.md files inside the container
    const output = execSync(
      `docker exec ${container} find /home/node/.openclaw /app/skills /app/extensions -name SKILL.md 2>/dev/null || true`,
      { encoding: "utf8", timeout: 10000 },
    ).trim();

    for (const skillMdPath of output.split("\n")) {
      if (!skillMdPath.trim()) continue;
      const info = parseDockerSkillMd(container, skillMdPath.trim());
      if (info) skills.push(info);
    }
  } catch { /* ignore */ }

  return skills;
}

function discoverLocalSkills(configDir: string): SkillInfo[] {
  const skills: SkillInfo[] = [];
  const dirs = [
    resolve(configDir, "workspace/skills"),
    resolve(configDir, "skills"),
  ];

  // Also check the openclaw repo if it exists
  const home = process.env.HOME || "/tmp";
  const repoSkills = resolve(home, "openclaw/skills");
  const repoExtensions = resolve(home, "openclaw/extensions");
  if (existsSync(repoSkills)) dirs.push(repoSkills);
  if (existsSync(repoExtensions)) {
    try {
      for (const ext of readdirSync(repoExtensions)) {
        const extSkills = resolve(repoExtensions, ext, "skills");
        if (existsSync(extSkills)) dirs.push(extSkills);
        // Extension root may have SKILL.md directly
        const extSkillMd = resolve(repoExtensions, ext, "SKILL.md");
        if (existsSync(extSkillMd)) {
          const info = parseLocalSkillMd(resolve(repoExtensions, ext));
          if (info) skills.push(info);
        }
      }
    } catch { /* ignore */ }
  }

  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const entry of readdirSync(dir)) {
        const skillDir = resolve(dir, entry);
        const skillMd = resolve(skillDir, "SKILL.md");
        if (existsSync(skillMd) && statSync(skillDir).isDirectory()) {
          const info = parseLocalSkillMd(skillDir);
          if (info) skills.push(info);
        }
      }
    } catch { /* ignore */ }
  }

  // Deduplicate by name
  const seen = new Set<string>();
  return skills.filter((s) => {
    if (seen.has(s.name)) return false;
    seen.add(s.name);
    return true;
  });
}

function parseDockerSkillMd(container: string, skillMdPath: string): SkillInfo | null {
  try {
    const content = execSync(
      `docker exec ${container} cat "${skillMdPath}"`,
      { encoding: "utf8", timeout: 5000 },
    );
    const fm = parseFrontmatter(content);
    if (!fm.name) return null;

    let source = "bundled";
    if (skillMdPath.includes("/workspace/skills/")) source = "workspace";
    else if (skillMdPath.includes("/extensions/")) source = "extension";
    else if (skillMdPath.includes("/.openclaw/skills/")) source = "managed";

    return {
      name: fm.name,
      description: fm.description || "",
      source,
      path: dirname(skillMdPath),
      emoji: fm.emoji,
    };
  } catch {
    return null;
  }
}

function parseLocalSkillMd(skillDir: string): SkillInfo | null {
  const skillMd = resolve(skillDir, "SKILL.md");
  if (!existsSync(skillMd)) return null;

  try {
    const content = readFileSync(skillMd, "utf8");
    const fm = parseFrontmatter(content);
    if (!fm.name) return null;

    let source = "bundled";
    if (skillDir.includes("/workspace/skills/")) source = "workspace";
    else if (skillDir.includes("/extensions/")) source = "extension";
    else if (skillDir.includes("/.openclaw/skills/")) source = "managed";

    return {
      name: fm.name,
      description: fm.description || "",
      source,
      path: skillDir,
      emoji: fm.emoji,
    };
  } catch {
    return null;
  }
}

/**
 * Parse YAML frontmatter from SKILL.md content.
 */
function parseFrontmatter(content: string): { name?: string; description?: string; emoji?: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!match) return {};

  const fm = match[1];
  const name = fm.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1];
  const description = fm.match(/^description:\s*["']?([\s\S]*?)["']?\s*(?:\n\w|\n---)/m)?.[1]?.trim()
    || fm.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();

  let emoji: string | undefined;
  const emojiMatch = fm.match(/emoji:\s*["']?([^\s"']+)["']?/);
  if (emojiMatch) emoji = emojiMatch[1];

  return { name, description, emoji };
}

/**
 * Sync skills from an OpenClaw instance to a per-tenant directory.
 * Skills are stored under `<targetDir>/<tenantName>/<skillName>/`.
 */
export function syncSkills(
  instance: DiscoveredInstance,
  skills: SkillInfo[],
  targetDir: string,
  tenantName?: string,
): { synced: number; errors: string[] } {
  const dest_base = tenantName ? resolve(targetDir, tenantName) : targetDir;
  mkdirSync(dest_base, { recursive: true });

  let synced = 0;
  const errors: string[] = [];

  for (const skill of skills) {
    const dest = resolve(dest_base, skill.name);
    try {
      if (instance.mode === "docker") {
        mkdirSync(dest, { recursive: true });
        execSync(
          `docker cp "${instance.container}:${skill.path}/." "${dest}/"`,
          { timeout: 10000 },
        );
      } else {
        if (existsSync(dest)) rmSync(dest, { recursive: true });
        cpSync(skill.path, dest, { recursive: true });
      }
      synced++;
    } catch (e) {
      errors.push(`${skill.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return { synced, errors };
}

/**
 * Clean synced skills. If tenantName given, only clean that tenant's skills.
 */
export function cleanSkills(targetDir: string, tenantName?: string): number {
  const dir = tenantName ? resolve(targetDir, tenantName) : targetDir;
  if (!existsSync(dir)) return 0;

  if (tenantName) {
    // Remove entire tenant directory
    rmSync(dir, { recursive: true });
    return 1;
  }

  // Remove all tenant directories
  let removed = 0;
  for (const entry of readdirSync(dir)) {
    const p = resolve(dir, entry);
    if (statSync(p).isDirectory()) {
      rmSync(p, { recursive: true });
      removed++;
    }
  }
  return removed;
}

/**
 * List synced skills. If tenantName given, list that tenant's skills.
 */
export function listSyncedSkills(targetDir: string, tenantName?: string): string[] {
  const dir = tenantName ? resolve(targetDir, tenantName) : targetDir;
  if (!existsSync(dir)) return [];

  if (tenantName) {
    return readdirSync(dir).filter((entry) => {
      const p = resolve(dir, entry);
      return statSync(p).isDirectory() && existsSync(resolve(p, "SKILL.md"));
    });
  }

  // List all tenants and their skill counts
  const results: string[] = [];
  for (const tenant of readdirSync(dir)) {
    const tdir = resolve(dir, tenant);
    if (!statSync(tdir).isDirectory()) continue;
    const skills = readdirSync(tdir).filter((e) => {
      const p = resolve(tdir, e);
      return statSync(p).isDirectory() && existsSync(resolve(p, "SKILL.md"));
    });
    results.push(`${tenant}: ${skills.length} skills`);
  }
  return results;
}
