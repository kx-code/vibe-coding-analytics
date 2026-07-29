#!/usr/bin/env node
import fs from "node:fs";

const required = [
  "AGENTS.md",
  "CLAUDE.md",
  ".github/copilot-instructions.md",
  ".cursor/rules/vibe-coding-analytics.mdc",
  ".kiro/steering/vibe-coding-analytics.md",
  ".github/workflows/ci.yml",
  "docs/knowledge-base/patterns.md",
  "docs/knowledge-base/constraints.md",
  "docs/knowledge-base/known-issues.md",
  "docs/decisions/0001-harness-baseline.md",
  ".ai/workflows/analytics.md",
  ".ai/workflows/init.md",
  ".ai/workflows/evolve.md",
  ".ai/workflows/steer.md",
  ".ai/reviewers/harness-reviewer.md",
  ".claude/commands/analytics.md",
  ".claude/commands/init.md",
  ".claude/commands/evolve.md",
  ".claude/commands/steer.md",
  ".claude/agents/harness-reviewer.md"
];

const missing = required.filter((file) => !fs.existsSync(file));
if (missing.length) {
  console.error(`Missing harness files:\n${missing.map((file) => `- ${file}`).join("\n")}`);
  process.exit(1);
}

const agents = fs.readFileSync("AGENTS.md", "utf8");
if (!/npm run|pnpm run|yarn run|bun run|make /.test(agents)) {
  console.warn("AGENTS.md does not name concrete validation commands yet.");
}

console.log("harness validation ok");
