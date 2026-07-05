import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execSync } from "node:child_process";

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
    const plan = buildEvolutionPlan(report);
    const files = buildEvolutionFiles(report, plan);
    printEvolution(report, plan);
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

/**
 * Detect harness maturity across the whole repository, including git submodules
 * and nested subpackages. Root-anchored prefix matches miss polyglot monorepos,
 * so checks run against every project root plus a full-tree file walk.
 */
function analyzeProject(cwd) {
  const roots = detectProjectRoots(cwd);
  const filesByRoot = new Map();
  for (const root of roots) filesByRoot.set(root, listFiles(root, 5));
  const allFiles = listFiles(cwd, 7);

  const hasAt = (file) => roots.some((root) => filesByRoot.get(root).has(file));
  const hasPrefixAt = (prefix) =>
    roots.some((root) => [...filesByRoot.get(root)].some((file) => file.startsWith(prefix)));

  const packageJson = readJson(path.join(cwd, "package.json"));
  const scripts = collectAllScripts(cwd, allFiles);
  const shape = detectShape(cwd, packageJson);

  const fractalDocs =
    countBasename(allFiles, "CLAUDE.md") >= 2 || countBasename(allFiles, "AGENTS.md") >= 2;

  const checks = [
    check(
      "Project facts",
      hasAt("README.md") || hasAt("CLAUDE.md") || hasAt("AGENTS.md"),
      "Add a README or CLAUDE.md with architecture, setup, and validation commands.",
    ),
    check(
      "Agent instructions",
      hasAt("AGENTS.md") ||
        hasAt("CLAUDE.md") ||
        hasPrefixAt(".cursor/rules/") ||
        hasAt(".github/copilot-instructions.md"),
      "Add AGENTS.md or CLAUDE.md plus tool-specific instruction files where relevant.",
    ),
    check(
      "Single validation command",
      Boolean(scripts.ci || scripts.validate) ||
        anyMakefileTarget(roots, ["ci", "validate", "test"]),
      "Add npm run ci/validate or a Makefile target that agents can run before completion.",
    ),
    check(
      "Typecheck",
      Boolean(scripts["type-check"] || scripts.typecheck || scripts.lint) ||
        hasAt("go.mod") ||
        hasAt("pubspec.yaml") ||
        hasAt("tsconfig.json") ||
        countBasename(allFiles, "go.mod") > 0 ||
        countBasename(allFiles, "pubspec.yaml") > 0 ||
        countBasename(allFiles, "tsconfig.json") > 0,
      "Add typecheck/lint scripts appropriate to the stack.",
    ),
    check(
      "Tests",
      hasTestFiles(allFiles) ||
        hasPrefixAt("tests/") ||
        hasPrefixAt("test/") ||
        hasAt("vitest.config.ts") ||
        hasAt("playwright.config.ts") ||
        hasAt("pytest.ini"),
      "Add unit tests and at least one smoke test for critical flows.",
    ),
    check(
      "CI",
      hasPrefixAt(".github/workflows/") ||
        hasAt(".gitlab-ci.yml") ||
        hasAt(".circleci/config.yml"),
      "Add CI that runs the same local validation command.",
    ),
    check(
      "Project memory",
      hasPrefixAt("docs/knowledge-base/") ||
        hasPrefixAt("docs/PRD/") ||
        hasPrefixAt("docs/architecture/") ||
        fractalDocs ||
        hasDocsMd(filesByRoot),
      "Add docs/knowledge-base patterns/constraints/known-issues, fractal CLAUDE.md, or docs/*.md.",
    ),
    check(
      "Reusable skills",
      hasPrefixAt(".claude/skills/") || hasPrefixAt("skills/"),
      "Create skills for repeated workflows such as validate, deploy, migrate, or debug.",
    ),
    check(
      "Specialist reviewers",
      hasPrefixAt(".claude/agents/") ||
        hasPluginAgents(allFiles) ||
        hasReviewerSkill(allFiles),
      "Add reviewer agents (.claude/agents/) or a reviewer skill/plugin for high-risk areas.",
    ),
    check(
      "Architecture sensors",
      hasValidateScript(allFiles) || anyMakefileTarget(roots, ["validate", "lint"]),
      "Add project-specific validators (scripts/*validate*/*verify*) for rules that should not rely on memory.",
    ),
    check(
      "Deploy hooks",
      hasScriptPrefix(scripts, ["deploy", "release"]) ||
        anyMakefileTarget(roots, ["deploy", "release"]) ||
        hasDeployArtifact(filesByRoot),
      "Add a deploy/release script, workflow, or skill so code is never deployed unverified.",
    ),
    check(
      "Rule sensors",
      !(hasAt("CLAUDE.md") || hasAt("AGENTS.md")) ||
        hasTestFiles(allFiles) ||
        hasValidateScript(allFiles) ||
        Boolean(scripts.lint || scripts["type-check"] || scripts.typecheck || scripts.validate || scripts.ci),
      "Rules in CLAUDE.md/AGENTS.md need computational sensors (tests, lint, validators); prose-only rules drift.",
    ),
    check(
      "Failure observability",
      Boolean(scripts.monitor) || hasObservabilitySensor(allFiles),
      "Add monitoring/alerting (monitor scripts, health workflows, error counters) so critical-path failures surface instead of failing silently.",
    ),
    check(
      "Cross-session memory",
      hasMemoryStore(filesByRoot),
      "Add cross-session memory (docs/decisions ADRs, .claude/memory, or a decisions log) so context persists across sessions.",
    ),
  ];

  const passed = checks.filter((item) => item.ok).length;
  const score = Math.round((passed / checks.length) * 100);
  return { cwd, shape, roots, files: allFiles, packageJson, scripts, checks, score };
}

function check(area, ok, action) {
  return { area, ok, action };
}

/** Project roots = cwd plus every git submodule path declared in .gitmodules. */
function detectProjectRoots(cwd) {
  const roots = [cwd];
  try {
    const gitmodules = path.join(cwd, ".gitmodules");
    if (fs.existsSync(gitmodules)) {
      const text = fs.readFileSync(gitmodules, "utf8");
      const re = /path\s*=\s*(.+)/g;
      let match;
      while ((match = re.exec(text)) !== null) {
        const abs = path.resolve(cwd, match[1].trim());
        if (fs.existsSync(abs) && !roots.includes(abs)) roots.push(abs);
      }
    }
  } catch {
    /* ignore */
  }
  return roots;
}

function detectShape(cwd, packageJson) {
  if (fs.existsSync(path.join(cwd, ".gitmodules"))) return "git submodule monorepo";
  if (packageJson && packageJson.workspaces) return "npm workspaces monorepo";
  return "single project";
}

/** Merge scripts from every package.json in the tree (root + nested subpackages). */
function collectAllScripts(cwd, allFiles) {
  const scripts = {};
  for (const file of allFiles) {
    if (file.includes("node_modules/")) continue;
    if (file === "package.json" || file.endsWith("/package.json")) {
      const pkg = readJson(path.join(cwd, file));
      if (pkg && pkg.scripts) Object.assign(scripts, pkg.scripts);
    }
  }
  return scripts;
}

function anyMakefileTarget(roots, targets) {
  for (const root of roots) {
    try {
      const text = fs.readFileSync(path.join(root, "Makefile"), "utf8");
      for (const target of targets) {
        if (new RegExp(`^${target}:`, "m").test(text)) return true;
      }
    } catch {
      /* ignore */
    }
  }
  return false;
}

/** Detect test files by language conventions across the whole tree. */
function hasTestFiles(allFiles) {
  for (const file of allFiles) {
    const base = file.split("/").pop();
    if (
      base.endsWith("_test.go") ||
      base.endsWith("_test.dart") ||
      /\.(test|spec)\.(js|ts|mjs|jsx|tsx)$/.test(base) ||
      (base.startsWith("test_") && base.endsWith(".py")) ||
      base.endsWith("_test.py")
    ) {
      return true;
    }
  }
  return false;
}

function countBasename(allFiles, basename) {
  let count = 0;
  for (const file of allFiles) {
    if (file.split("/").pop() === basename) count += 1;
  }
  return count;
}

function hasDocsMd(filesByRoot) {
  for (const [, files] of filesByRoot) {
    for (const file of files) {
      if (file.startsWith("docs/") && file.endsWith(".md") && file !== "docs/README.md") {
        return true;
      }
    }
  }
  return false;
}

function hasPluginAgents(allFiles) {
  for (const file of allFiles) {
    // Relative paths have no leading slash, so match `.claude/plugins/<name>/agents/`
    // anywhere in the tree (root-level or nested), mirroring hasReviewerSkill.
    if (/\.claude\/plugins\/[^/]+\/agents\//i.test(file)) return true;
  }
  return false;
}

function hasReviewerSkill(allFiles) {
  for (const file of allFiles) {
    if (/\.claude\/skills\/[^/]*(review|reviewer)/i.test(file)) return true;
  }
  return false;
}

function hasValidateScript(allFiles) {
  for (const file of allFiles) {
    const inScripts = file.startsWith("scripts/") || file.includes("/scripts/");
    if (inScripts && /(validate|verify|check|lint)/i.test(file)) return true;
  }
  return false;
}

/** Deploy/release artifacts: scripts, CI workflows, or deploy/release skills. */
/** True if any package script key starts with one of the given heads (e.g. deploy:prod). */
function hasScriptPrefix(scripts, prefixes) {
  for (const name of Object.keys(scripts)) {
    if (prefixes.includes(name.split(":")[0])) return true;
  }
  return false;
}

/** Deploy artifacts in scripts/workflows/skills. Scanned per root so a deploy
 *  hook inside a deep git submodule is not lost to the root listFiles depth cap. */
function hasDeployArtifact(filesByRoot) {
  for (const [, files] of filesByRoot) {
    for (const file of files) {
      if (/scripts\/[^/]*(deploy|release)/i.test(file)) return true;
      if (/\.github\/workflows\/[^/]*(deploy|release)/i.test(file)) return true;
      if (/\.claude\/skills\/[^/]*(deploy|release)/i.test(file)) return true;
    }
  }
  return false;
}

/** Observability sensors: monitor/alert/health files in script/workflow/worker paths.
 *  README or docs that merely mention monitoring do not count. */
function hasObservabilitySensor(allFiles) {
  for (const file of allFiles) {
    if (!/(monitor|alert|observability|health[-_]?check)/i.test(file)) continue;
    if (file.includes(".github/workflows/")) return true;
    if (file.startsWith("scripts/") || file.includes("/scripts/")) return true;
    if (file.startsWith("workers/") || file.includes("/workers/")) return true;
  }
  return false;
}

/** Cross-session memory: ADR/decisions logs or agent memory stores. */
/** Cross-session memory: ADR/decisions logs or agent memory stores.
 *  Scanned per root so submodule decision docs (e.g. backend/docs/decisions/) count. */
function hasMemoryStore(filesByRoot) {
  for (const [, files] of filesByRoot) {
    for (const file of files) {
      // Root-anchored (docs/decisions/) AND submodule paths (backend/docs/decisions/).
      if (/(^|\/)docs\/(decisions|adr)\//i.test(file)) return true;
      if (/\.claude\/memory\//i.test(file)) return true;
      if (/(^|\/)(DECISIONS|ARCHITECTURE[-_]DECISIONS)\.md$/i.test(file)) return true;
    }
  }
  return false;
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

By default commands are read-only. Add --write to create missing harness files.`);
}

function printReport(report) {
  console.log(`Vibe Coding Analytics: ${report.cwd}`);
  console.log(`Project shape: ${report.shape}`);
  console.log(`Harness score: ${report.score}/100\n`);
  for (const item of report.checks) {
    console.log(`${item.ok ? "PASS" : "MISS"}  ${item.area}`);
    if (!item.ok) console.log(`      ${item.action}`);
  }
  if (report.shape !== "single project") {
    console.log(
      `\nScanned ${report.roots.length} project root(s): ${report.shape} aware (root + git submodules).`,
    );
  }
}

export function printEvolution(report, plan) {
  const safePlan = plan || buildEvolutionPlan(report);
  console.log(`Vibe Coding Evolution: ${report.cwd}`);
  console.log(`Project shape: ${report.shape}`);
  console.log("Adds a recurring improvement loop for extracting repeated work into rules, tests, commands, and skills.\n");
  if (safePlan.recommendations.length) {
    console.log("Promote these current gaps into durable sensors:");
    for (const r of safePlan.recommendations) console.log(`- ${r.area} -> ${r.promoteTo}`);
    console.log();
  } else {
    console.log("No missing harness areas detected. Focus on promoting repeated work from recent activity.\n");
  }
  if (safePlan.fixPatterns.hotFiles.length) {
    console.log(`Recent fix hotspots (${safePlan.fixPatterns.fixCommits} fix commits):`);
    for (const h of safePlan.fixPatterns.hotFiles) console.log(`- ${h.file} (${h.count}x)`);
    console.log();
  }
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

const EVOLVE_PROMOTIONS = {
  "Project facts": { promoteTo: "README / CLAUDE.md", action: "Add a README or CLAUDE.md with architecture, setup, and validation commands." },
  "Agent instructions": { promoteTo: "AGENTS.md / CLAUDE.md rule", action: "Add AGENTS.md or CLAUDE.md so agents inherit stable project rules." },
  "Single validation command": { promoteTo: "package script (ci/validate)", action: "Add an npm run ci/validate script that agents run before completion." },
  "Typecheck": { promoteTo: "typecheck script", action: "Add a typecheck/lint script appropriate to the stack." },
  "Tests": { promoteTo: "regression test", action: "Add a failing test for the most recent bug, then make it pass." },
  "CI": { promoteTo: "CI workflow", action: "Add CI that runs the same local validation command on every push." },
  "Project memory": { promoteTo: "docs/knowledge-base entry", action: "Add docs/knowledge-base patterns/constraints/known-issues." },
  "Reusable skills": { promoteTo: "project skill", action: "Create a skill for a repeated workflow (validate, deploy, migrate, debug)." },
  "Specialist reviewers": { promoteTo: "reviewer agent", action: "Add a reviewer agent for the highest-risk domain." },
  "Architecture sensors": { promoteTo: "architecture validator", action: "Add a scripts/validate validator for rules that should not rely on memory." },
};

/** Map each missing analytics check to a concrete promotion target (the "evolve" half of analytics). */
function evolutionRecommendations(report) {
  const recs = [];
  for (const item of report.checks) {
    if (item.ok) continue;
    const promotion = EVOLVE_PROMOTIONS[item.area];
    if (!promotion) continue;
    recs.push({ area: item.area, promoteTo: promotion.promoteTo, action: promotion.action });
  }
  return recs;
}

/** Read recent git history for fix commits + repeatedly-changed files. Degrades to empty when cwd is not a git repo. */
function recentFixPatterns(cwd, limit = 40) {
  let log = "";
  try {
    log = execSync(`git log --no-merges --pretty=format:%s --name-only -n ${limit} -- .`, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 4000,
    });
  } catch {
    return { fixCommits: 0, hotFiles: [] };
  }
  let fixCommits = 0;
  const counts = new Map();
  let expectSubject = true;
  let inFixCommit = false;
  for (const raw of log.split("\n")) {
    const line = raw.trim();
    if (!line) { expectSubject = true; continue; }
    if (expectSubject) {
      inFixCommit = /\b(fix|bug|patch|hotfix)\b/i.test(line);
      if (inFixCommit) fixCommits += 1;
      expectSubject = false;
    } else if (inFixCommit) {
      counts.set(line, (counts.get(line) || 0) + 1);
    }
  }
  const hotFiles = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([file, count]) => ({ file, count }));
  return { fixCommits, hotFiles };
}

/** Build a concrete evolution plan from analytics gaps + recent fix history. */
export function buildEvolutionPlan(report) {
  return {
    recommendations: evolutionRecommendations(report),
    fixPatterns: recentFixPatterns(report.cwd),
  };
}

function buildEvolutionFiles(report, plan) {
  const name = report.packageJson?.name || path.basename(report.cwd);
  const safePlan = plan || buildEvolutionPlan(report);
  return [
    file("docs/knowledge-base/agent-evolution.md", evolutionDoc(name, safePlan)),
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

function evolutionDoc(name, plan) {
  const safePlan = plan || { recommendations: [], fixPatterns: { fixCommits: 0, hotFiles: [] } };
  const recLines = safePlan.recommendations.length
    ? safePlan.recommendations.map((r) => `- ${r.area} -> ${r.promoteTo}: ${r.action}`).join("\n")
    : "- No missing harness areas detected. Keep promoting repeated work into durable sensors.";
  const hotspotSection = safePlan.fixPatterns.hotFiles.length
    ? [
        "## Recent Fix Hotspots",
        "",
        `${safePlan.fixPatterns.fixCommits} fix commit(s) found in recent history. Files changed more than once are regression-test candidates:`,
        "",
        ...safePlan.fixPatterns.hotFiles.map((h) => `- ${h.file} (${h.count}x)`),
        "",
      ].join("\n")
    : "";
  return `# ${name} Agent Evolution Loop

Use this document to record how the project harness improves over time.

## Loop Inputs

- Recent user corrections
- Repeated shell commands
- Failed tests or CI failures
- Review comments
- Production incidents
- Manual checklist items that keep recurring

## Current Gaps -> Promote To

${recLines}

${hotspotSection}## Promotion Rules

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
