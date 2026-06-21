import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const COMMANDS = new Set(["init", "analytics", "evolve", "help"]);

export async function runCli(argv) {
  const command = COMMANDS.has(argv[0]) ? argv[0] : argv[0] ? "help" : "help";
  const options = parseOptions(argv.slice(command === "help" && argv[0] !== "help" ? 0 : 1));

  if (command === "help") {
    printHelp();
    return;
  }

  const cwd = path.resolve(options.cwd || process.cwd());
  const report = analyzeProject(cwd);

  if (command === "analytics") {
    printReport(report);
    return;
  }

  if (command === "init") {
    printReport(report);
    const files = buildInitFiles(report);
    writeOrPreview(cwd, files, options.write);
    return;
  }

  if (command === "evolve") {
    const files = buildEvolutionFiles(report);
    printEvolution(report);
    writeOrPreview(cwd, files, options.write);
  }
}

export function analyzeForTest(cwd) {
  return analyzeProject(path.resolve(cwd));
}

function parseOptions(args) {
  const options = { write: false, cwd: null };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--write") options.write = true;
    if (arg === "--cwd") options.cwd = args[++i];
  }
  return options;
}

function analyzeProject(cwd) {
  const files = listFiles(cwd, 5);
  const has = (file) => files.has(file);
  const hasPrefix = (prefix) => [...files].some((file) => file.startsWith(prefix));
  const packageJson = readJson(path.join(cwd, "package.json"));
  const scripts = packageJson?.scripts || {};

  const checks = [
    check("Project facts", has("README.md") || has("readme.md"), "Add a README with architecture, setup, and validation commands."),
    check("Agent instructions", has("AGENTS.md") || has("CLAUDE.md") || hasPrefix(".cursor/rules/") || has(".github/copilot-instructions.md"), "Add AGENTS.md plus tool-specific instruction files where relevant."),
    check("Single validation command", Boolean(scripts.ci || scripts.validate), "Add npm run ci or npm run validate that agents can run before completion."),
    check("Typecheck", Boolean(scripts["type-check"] || scripts.typecheck || scripts.lint), "Add typecheck/lint scripts appropriate to the stack."),
    check("Tests", Boolean(scripts.test) || hasPrefix("tests/") || hasPrefix("test/") || has("vitest.config.ts") || has("playwright.config.ts"), "Add unit tests and at least one smoke test for critical flows."),
    check("CI", hasPrefix(".github/workflows/"), "Add CI that runs the same local validation command."),
    check("Project memory", hasPrefix("docs/knowledge-base/") || hasPrefix("docs/PRD/") || hasPrefix("docs/architecture/"), "Add docs/knowledge-base patterns, constraints, and known issues."),
    check("Reusable skills", hasPrefix(".claude/skills/") || hasPrefix("skills/"), "Create skills for repeated workflows such as validate, deploy, migrate, or debug."),
    check("Specialist reviewers", hasPrefix(".claude/agents/"), "Add reviewer agents for the highest-risk areas."),
    check("Architecture sensors", hasPrefix("scripts/validate-architecture"), "Add project-specific validators for rules that should not rely on memory.")
  ];

  const passed = checks.filter((item) => item.ok).length;
  const score = Math.round((passed / checks.length) * 100);
  return { cwd, files, packageJson, scripts, checks, score };
}

function check(area, ok, action) {
  return { area, ok, action };
}

function listFiles(root, maxDepth) {
  const result = new Set();
  walk(root, "", 0, maxDepth, result);
  return result;
}

function walk(root, rel, depth, maxDepth, result) {
  if (depth > maxDepth) return;
  const dir = path.join(root, rel);
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (["node_modules", ".git", "dist", "build", ".next", ".astro"].includes(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      result.add(`${childRel}/`);
      walk(root, childRel, depth + 1, maxDepth, result);
    } else {
      result.add(childRel);
    }
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function printHelp() {
  console.log(`vibe-coding-analytics

Usage:
  npx vibe-coding-analytics analytics [--cwd path]
  npx vibe-coding-analytics init [--cwd path] [--write]
  npx vibe-coding-analytics evolve [--cwd path] [--write]

Commands:
  analytics  Audit the current project harness and print gaps.
  init       Propose or write baseline AI coding harness files.
  evolve     Propose or write self-evolution loop files.

By default commands are read-only. Add --write to create missing files.`);
}

function printReport(report) {
  console.log(`Vibe Coding Analytics: ${report.cwd}`);
  console.log(`Harness score: ${report.score}/100\n`);
  for (const item of report.checks) {
    console.log(`${item.ok ? "PASS" : "MISS"}  ${item.area}`);
    if (!item.ok) console.log(`      ${item.action}`);
  }
}

function printEvolution(report) {
  console.log(`Vibe Coding Evolution: ${report.cwd}`);
  console.log("Adds a recurring improvement loop for extracting repeated work into rules, tests, commands, and skills.\n");
}

function buildInitFiles(report) {
  const name = report.packageJson?.name || path.basename(report.cwd);
  return [
    file("AGENTS.md", agentInstructions(name)),
    file(".github/copilot-instructions.md", copilotInstructions(name)),
    file("docs/knowledge-base/patterns.md", "# Patterns\n\nDocument project-specific code patterns that agents should reuse.\n"),
    file("docs/knowledge-base/constraints.md", "# Constraints\n\nDocument rules that must not be violated. Promote repeated rules into tests or validators.\n"),
    file("docs/knowledge-base/known-issues.md", "# Known Issues\n\nTrack recurring failures, root causes, and the sensor added to prevent recurrence.\n"),
    file(".claude/commands/analytics.md", slashAnalyticsCommand()),
    file(".claude/commands/init.md", slashInitCommand()),
    file(".claude/commands/evolve.md", slashEvolveCommand())
  ];
}

function buildEvolutionFiles(report) {
  const name = report.packageJson?.name || path.basename(report.cwd);
  return [
    file("docs/knowledge-base/agent-evolution.md", evolutionDoc(name)),
    file(".claude/commands/evolve.md", slashEvolveCommand()),
    file(".claude/skills/project-evolution/SKILL.md", projectEvolutionSkill(name))
  ];
}

function file(relativePath, content) {
  return { relativePath, content };
}

function writeOrPreview(cwd, files, write) {
  const missing = files.filter(({ relativePath }) => !fs.existsSync(path.join(cwd, relativePath)));
  if (!missing.length) {
    console.log("\nNo missing harness files from this template set.");
    return;
  }

  console.log(`\n${write ? "Writing" : "Would write"} ${missing.length} file(s):`);
  for (const item of missing) {
    console.log(`- ${item.relativePath}`);
    if (write) {
      const target = path.join(cwd, item.relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, item.content);
    }
  }

  if (!write) console.log("\nRun again with --write to create these files.");
}

function agentInstructions(name) {
  return `# ${name} Agent Instructions

## Project Facts

- Fill in architecture, runtime, deployment, and data model facts.
- Keep stable facts here. Put temporary notes in issues or plans.

## Commands

- Install:
- Dev:
- Validate:
- Build:
- Test:

## Agent Rules

- Read project context before editing.
- Prefer existing patterns over new abstractions.
- Do not touch production services, secrets, or databases without explicit approval.
- Convert repeated failures into tests, validators, commands, or skills.
`;
}

function copilotInstructions(name) {
  return `# ${name} Copilot Instructions

Follow AGENTS.md for project facts and commands.

Before completing a change:
- run the repository validation command when available
- explain any checks that could not be run
- preserve user changes and avoid unrelated refactors
`;
}

function slashAnalyticsCommand() {
  return `Audit this repository for AI coding readiness.

Run or simulate:
\`\`\`bash
npx vibe-coding-analytics analytics
\`\`\`

Return current maturity, missing harness areas, and now/next/later recommendations.
`;
}

function slashInitCommand() {
  return `Initialize a minimal AI coding harness for this repository.

Run:
\`\`\`bash
npx vibe-coding-analytics init --write
\`\`\`

Review created files, adapt them to the project, then run available validation.
`;
}

function slashEvolveCommand() {
  return `Improve this project's AI coding harness from recent work.

Look for repeated failures, repeated user corrections, recurring commands, and missing checks.
Promote each repeated pattern into one of:
- test
- lint or architecture validator
- AGENTS.md / CLAUDE.md rule
- slash command
- reusable skill
- specialist reviewer agent

This command is designed for loop usage, for example:
\`\`\`text
/loop 30m /evolve
\`\`\`
`;
}

function evolutionDoc(name) {
  return `# ${name} Agent Evolution Loop

Use this document to record how the project harness improves over time.

## Loop Inputs

- Recent user corrections
- Repeated shell commands
- Failed tests or CI failures
- Review comments
- Production incidents
- Manual checklist items that keep recurring

## Promotion Rules

- Repeated bug -> regression test or validator
- Repeated command sequence -> slash command or package script
- Repeated domain workflow -> skill
- Repeated review concern -> specialist reviewer agent
- Repeated ambiguous instruction -> AGENTS.md or CLAUDE.md update

## Loop Cadence

Use a short local loop during active development and a slower scheduled review for documentation drift.
`;
}

function projectEvolutionSkill(name) {
  return `---
name: project-evolution
description: Use when repeated work, user corrections, failed checks, review comments, or operational incidents suggest this project's AI coding harness should be improved with tests, validators, commands, rules, skills, or reviewer agents.
---

# Project Evolution

Review recent work in ${name} and promote repeated patterns into durable harness improvements.

## Process

1. Gather recent corrections, failed checks, repeated commands, and review comments.
2. Classify each item as bug, workflow, ambiguity, safety risk, or missing context.
3. Add the smallest durable sensor: test, validator, command, rule, skill, or reviewer.
4. Run available validation.
5. Record the change in docs/knowledge-base/agent-evolution.md.

Do not touch production systems or secrets during evolution unless explicitly asked.
`;
}
