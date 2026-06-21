#!/usr/bin/env node
import fs from "node:fs";

const required = [
  "package.json",
  "README.md",
  "AGENTS.md",
  ".codex-plugin/plugin.json",
  "skills/vibe-coding-analytics/SKILL.md",
  "templates/claude/commands/analytics.md",
  "templates/claude/commands/init.md",
  "templates/claude/commands/evolve.md"
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

const skill = fs.readFileSync("skills/vibe-coding-analytics/SKILL.md", "utf8");
for (const term of ["init", "analytics", "evolve", "/loop"]) {
  if (!skill.includes(term)) {
    console.error(`Skill must mention ${term}.`);
    process.exit(1);
  }
}

console.log("architecture validation ok");
