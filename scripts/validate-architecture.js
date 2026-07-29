#!/usr/bin/env node
import fs from "node:fs";

const required = [
  "package.json",
  "README.md",
  "AGENTS.md",
  ".codex-plugin/plugin.json",
  ".github/workflows/ci.yml",
  ".github/workflows/health-check.yml",
  ".github/workflows/release.yml",
  "skills/vibe-coding-analytics/SKILL.md",
  "skills/vibe-coding-analytics/agents/openai.yaml",
  "templates/claude/commands/analytics.md",
  "templates/claude/commands/init.md",
  "templates/claude/commands/evolve.md",
  "templates/claude/commands/steer.md"
];

const missing = required.filter((file) => !fs.existsSync(file));
if (missing.length) {
  console.error(`Missing required files:\n${missing.map((file) => `- ${file}`).join("\n")}`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
if (!pkg.bin?.["vibe-coding-analytics"] || !pkg.bin?.vca) {
  console.error("package.json must expose both vibe-coding-analytics and vca bins.");
  process.exit(1);
}

for (const dir of ["bin", "src", "scripts", "skills", "templates", ".codex-plugin"]) {
  if (!pkg.files?.includes(dir)) {
    console.error(`package.json files must include ${dir}.`);
    process.exit(1);
  }
}

const plugin = JSON.parse(fs.readFileSync(".codex-plugin/plugin.json", "utf8"));
if (plugin.name !== pkg.name) {
  console.error(".codex-plugin/plugin.json name must match package.json name.");
  process.exit(1);
}
if (plugin.description !== pkg.description) {
  console.error(".codex-plugin/plugin.json description must match package.json description.");
  process.exit(1);
}
if (plugin.skills !== "./skills/") {
  console.error(".codex-plugin/plugin.json must point skills at ./skills/.");
  process.exit(1);
}
if (!plugin.interface?.capabilities?.includes("Read") || !plugin.interface?.capabilities?.includes("Write")) {
  console.error(".codex-plugin/plugin.json must declare Read and Write capabilities.");
  process.exit(1);
}

const skill = fs.readFileSync("skills/vibe-coding-analytics/SKILL.md", "utf8");
for (const term of ["init", "analytics", "evolve", "/loop"]) {
  if (!skill.includes(term)) {
    console.error(`Skill must mention ${term}.`);
    process.exit(1);
  }
}

const ci = fs.readFileSync(".github/workflows/ci.yml", "utf8");
for (const term of ["npm ci", "npm run ci", "npm pack --dry-run"]) {
  if (!ci.includes(term)) {
    console.error(`CI workflow must run ${term}.`);
    process.exit(1);
  }
}

const release = fs.readFileSync(".github/workflows/release.yml", "utf8");
for (const term of ["release:", "npm run ci", "npm publish --provenance --access public"]) {
  if (!release.includes(term)) {
    console.error(`Release workflow must include ${term}.`);
    process.exit(1);
  }
}

const health = fs.readFileSync(".github/workflows/health-check.yml", "utf8");
for (const term of ["schedule:", "npm view vibe-coding-analytics version", "npx --yes vibe-coding-analytics --version"]) {
  if (!health.includes(term)) {
    console.error(`Health-check workflow must include ${term}.`);
    process.exit(1);
  }
}

console.log("architecture validation ok");
