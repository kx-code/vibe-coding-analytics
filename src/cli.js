import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

// File-walk depth limits. Per-root scans stay shallow (the root's own files live
// near the surface); the full-tree walk goes deeper so nested workspace packages
// and deeply-placed harness files (e.g. apps/admin/src/env.d.ts) are seen.
const PER_ROOT_SCAN_DEPTH = 5;
const FULL_TREE_SCAN_DEPTH = 7;

const require = createRequire(import.meta.url);

const COMMANDS = new Set(["init", "analytics", "evolve", "help"]);

export async function runCli(argv) {
  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(cliVersion());
    return;
  }

  const command = COMMANDS.has(argv[0]) ? argv[0] : "help";
  const options = parseOptions(argv.slice(command === "help" ? 0 : 1));

  if (command === "help") {
    printHelp();
    return;
  }

  const cwd = path.resolve(options.cwd || process.cwd());
  const report = analyzeProject(cwd);

  if (command === "analytics") {
    if (options.format === "json") {
      console.log(JSON.stringify({ ...report, files: [...report.files] }, null, 2));
    } else {
      printReport(report);
    }
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

function cliVersion() {
  try {
    return require("../package.json").version;
  } catch {
    return "0.0.0-unknown";
  }
}

export function analyzeForTest(cwd) {
  return analyzeProject(path.resolve(cwd));
}

function parseOptions(args) {
  const options = { write: false, cwd: null, format: "text" };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--write") options.write = true;
    if (arg === "--cwd") options.cwd = args[++i];
    if (arg === "--format") options.format = args[++i] || "text";
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
  for (const root of roots) filesByRoot.set(root, listFiles(root, PER_ROOT_SCAN_DEPTH));
  const allFiles = listFiles(cwd, FULL_TREE_SCAN_DEPTH);

  const hasAt = (file) => roots.some((root) => filesByRoot.get(root).has(file));
  const hasPrefixAt = (prefix) =>
    roots.some((root) => [...filesByRoot.get(root)].some((file) => file.startsWith(prefix)));

  const packageJson = readJson(path.join(cwd, "package.json"));
  const scripts = collectAllScripts(cwd, allFiles);
  const shape = detectShape(cwd, packageJson);
  // Harness anchor files that exist on disk but are NOT git-tracked (the
  // SiteGroup class of bug: a broad `*.d.ts` gitignore silently excluded
  // env.d.ts, so CI checkouts failed with 36 TS errors that never reproduced
  // on the author's machine). Computed once; consumed by the check below.
  const untrackedHarness = untrackedHarnessFiles(cwd, allFiles);

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
      // The validation-command vocabulary is {ci, validate, verify, test} across
      // both npm scripts and Makefile targets -- kept symmetric so the two backends
      // never disagree. `verify` and `test` are the most common names in practice
      // (e.g. a root `verify` that fans out across workspaces + vitest).
      Boolean(scripts.ci || scripts.validate || scripts.verify || scripts.test) ||
        anyMakefileTarget(roots, ["ci", "validate", "verify", "test"]),
      "Add npm run ci/validate/verify/test or a Makefile target that agents can run before completion.",
    ),
    check(
      "Typecheck",
      // Plain-JS projects (no TypeScript/Go/Python/Dart sources and no typed-stack
      // config anywhere in the tree) have nothing to typecheck -- treat as N/A so
      // zero-dependency JS CLIs are not flagged. Typed stacks must still provide a
      // typecheck/lint script OR the config file itself.
      !hasTypedStack(allFiles) ||
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
      "Deploy hooks",
      hasDeployHook(allFiles, scripts),
      "Add a deploy script, workflow, or skill so deployment is repeatable and observable.",
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
      "Harness files committed",
      untrackedHarness.length === 0,
      untrackedHarness.length === 0
        ? "Keep config/declaration files (env.d.ts, tsconfig.json, AGENTS.md) git-tracked; a broad gitignore rule (*.d.ts, *.env) silently drops them from CI checkouts."
        : `These harness files exist on disk but are NOT git-tracked -- remove the matching .gitignore rule (or 'git add -f'): ${untrackedHarness.join(", ")}`,
    ),
  ];

  const passed = checks.filter((item) => item.ok).length;
  const score = Math.round((passed / checks.length) * 100);
  return { cwd, shape, roots, files: allFiles, packageJson, scripts, checks, score };
}

function check(area, ok, action) {
  return { area, ok, action };
}

/**
 * Project roots = cwd plus every git submodule path AND every npm/pnpm workspace
 * package. Workspace packages are first-class project roots: per-root exact-basename
 * lookups (hasAt) must see packages/<name>/tsconfig.json etc., not just the monorepo
 * root. Without this, harness files that live inside a workspace package are missed.
 */
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
  for (const glob of readWorkspacePatterns(cwd)) {
    for (const abs of expandWorkspaceGlob(cwd, glob)) {
      if (!roots.includes(abs)) roots.push(abs);
    }
  }
  return roots;
}

/** Collect workspace patterns from package.json (npm) -- pnpm-workspace.yaml is not
 *  parsed here because pnpm workspace members still appear under cwd and are picked
 *  up by the per-root walk; npm needs explicit glob expansion to be counted as roots. */
function readWorkspacePatterns(cwd) {
  const pkg = readJson(path.join(cwd, "package.json"));
  if (!pkg || !pkg.workspaces) return [];
  return Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces.packages || [];
}

/** Minimal npm-style workspace glob expander: supports a trailing /* (the common
 *  case) and literal directory entries. Only directories containing package.json
 *  are workspace packages. */
function expandWorkspaceGlob(root, glob) {
  const out = [];
  const starIdx = glob.indexOf("*");
  if (starIdx >= 0) {
    const base = path.join(root, glob.slice(0, starIdx).replace(/\/$/, ""));
    let entries = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const abs = path.join(base, entry.name);
      if (fs.existsSync(path.join(abs, "package.json"))) out.push(abs);
    }
  } else {
    const abs = path.join(root, glob);
    if (fs.existsSync(path.join(abs, "package.json"))) out.push(abs);
  }
  return out;
}

function detectShape(cwd, packageJson) {
  if (fs.existsSync(path.join(cwd, ".gitmodules"))) return "git submodule monorepo";
  if (fs.existsSync(path.join(cwd, "pnpm-workspace.yaml"))) return "pnpm workspace monorepo";
  if (packageJson && packageJson.workspaces) return "npm workspaces monorepo";
  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
    try {
      const toml = fs.readFileSync(path.join(cwd, "Cargo.toml"), "utf8");
      if (/^\s*\[workspace\]/m.test(toml)) return "cargo workspace monorepo";
    } catch {
      /* ignore */
    }
  }
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

function hasTypedStack(allFiles) {
  if (countBasename(allFiles, "tsconfig.json") > 0) return true;
  if (countBasename(allFiles, "go.mod") > 0) return true;
  if (countBasename(allFiles, "pubspec.yaml") > 0) return true;
  for (const file of allFiles) {
    if (/\.(ts|tsx|go|py|dart)$/i.test(file)) return true;
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

function hasDeployHook(allFiles, scripts) {
  if (scripts.deploy) return true;
  for (const file of allFiles) {
    if (/\.github\/workflows\/[^/]*deploy/i.test(file)) return true;
    if (/skills\/[^/]*deploy/i.test(file)) return true;
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

function insideNestedRepo(cwd, relPath) {
  // True if any ancestor directory of relPath (between cwd and the file) carries
  // its own .git -- a worktree (.git file) or nested repo/submodule (.git dir).
  // Such files are tracked by THAT repo's index, not the cwd repo's.
  const parts = relPath.split("/");
  for (let i = 1; i < parts.length; i += 1) {
    const ancestor = parts.slice(0, i).join("/");
    if (fs.existsSync(path.join(cwd, ancestor, ".git"))) return true;
  }
  return false;
}

function untrackedHarnessFiles(cwd, allFiles) {
  // N/A outside a git repo -- there is no "committed" to check.
  if (!fs.existsSync(path.join(cwd, ".git"))) return [];
  const BUILD_OUT_RE = /(^|\/)(dist|build|\.next|\.astro|node_modules|out|coverage)\//i;
  const offenders = [];
  for (const f of allFiles) {
    const isAnchor = /(^|\/)(AGENTS\.md|CLAUDE\.md|env\.d\.ts|tsconfig\.json|jsconfig\.json)$/i.test(f)
      || (/\.d\.ts$/i.test(f) && !BUILD_OUT_RE.test(f));
    if (!isAnchor) continue;
    // Skip files that live inside a NESTED repo/worktree/submodule: an ancestor
    // dir carries its own .git, so its index (not the cwd repo's) tracks the file.
    // git ls-files from cwd would otherwise mis-flag every file checked out in a
    // sibling `git worktree` (e.g. .claude/worktrees/<name>/...) as untracked.
    if (insideNestedRepo(cwd, f)) continue;
    // git ls-files --error-unmatch exits 0 only for tracked paths; ignored AND
    // merely-unstaged paths both fail -- both break a fresh CI checkout, so both
    // are flagged. ENOENT (git missing) yields status null (!== 0) -> flagged,
    // which errs toward warning in pathological no-git environments.
    const r = spawnSync("git", ["ls-files", "--error-unmatch", f], { cwd, encoding: "utf8" });
    if (r.status !== 0) offenders.push(f);
  }
  return offenders;
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
  npx vibe-coding-analytics analytics [--cwd path] [--format json]
  npx vibe-coding-analytics init [--cwd path] [--write]
  npx vibe-coding-analytics evolve [--cwd path] [--write]
  npx vibe-coding-analytics --version | -V

Commands:
  analytics  Audit the current project harness and print gaps.
  init       Propose or write baseline AI coding harness files.
  evolve     Propose or write self-evolution loop files.

Options:
  --cwd <path>     Run against this directory (default: current directory).
  --write          Create missing harness files (init/evolve). Default is read-only.
  --format json    Emit the analytics report as machine-readable JSON (analytics only).
  --version, -V    Print the vibe-coding-analytics version and exit.`);
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

function printEvolution(report) {
  console.log(`Vibe Coding Evolution: ${report.cwd}`);
  console.log(`Project shape: ${report.shape}`);
  console.log("Adds a recurring improvement loop for extracting repeated work into rules, tests, commands, and skills.\n");
}

export function buildInitFiles(report) {
  const name = report.packageJson?.name || path.basename(report.cwd);
  return [
    file("AGENTS.md", agentInstructions(name, report.scripts)),
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

function agentInstructions(name, scripts) {
  // Pre-fill Commands from detected package.json scripts so the generated file is
  // immediately accurate, not a fill-in worksheet. Missing commands stay blank.
  const cmd = (...keys) => {
    for (const k of keys) if (scripts && scripts[k]) return scripts[k];
    return "";
  };
  const dev = cmd("dev", "start");
  const validate = cmd("verify", "validate");
  const build = cmd("build");
  const testCmd = cmd("test");
  const line = (label, value) => `- ${label}: ${value || ""}`;
  return `# ${name} Agent Instructions

## Project Facts

- Fill in architecture, runtime, deployment, and data model facts.
- Keep stable facts here. Put temporary notes in issues or plans.

## Commands

${line("Install", "npm install")}
${line("Dev", dev)}
${line("Validate", validate)}
${line("Build", build)}
${line("Test", testCmd)}

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
