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
  ];

  enrichDepth(checks, { allFiles, roots, filesByRoot });
  const passed = checks.filter((item) => item.ok).length;
  const score = Math.round((passed / checks.length) * 100);
  return { cwd, shape, roots, files: allFiles, packageJson, scripts, checks, score };
}

/** Count test files across the tree (no regex, mirrors hasTestFile conventions). */
function isTestFile(base) {
  return (
    base.endsWith("_test.go") ||
    base.endsWith("_test.dart") ||
    base.endsWith(".test.js") ||
    base.endsWith(".test.ts") ||
    base.endsWith(".test.tsx") ||
    base.endsWith(".spec.js") ||
    base.endsWith(".spec.ts") ||
    base.endsWith(".spec.tsx") ||
    base.endsWith(".test.mjs") ||
    base.endsWith(".test.jsx") ||
    base.endsWith(".spec.jsx") ||
    base.endsWith(".spec.mjs") ||
    (base.startsWith("test_") && base.endsWith(".py")) ||
    base.endsWith("_test.py")
  );
}
function countTestFiles(allFiles) {
  let n = 0;
  for (const file of allFiles) {
    if (file.endsWith("/")) continue; // directory entry, not a file
    const base = file.split("/").pop();
    if (isTestFile(base)) { n += 1; continue; }
    // Recognized test directory (Mocha test/, tests/, Jest __tests__/): a source
    // file here counts even without a .test/.spec suffix, mirroring the Tests
    // check hasPrefixAt("test/"|"tests/") predicate.
    if (/(^|\/)(test|tests|__tests__)\//.test(file) && !/\.(md|markdown|txt|json|ya?ml|lock)$/i.test(base)) {
      n += 1;
    }
  }
  return n;
}
function countInstructionLines(roots, filesByRoot) {
  let lines = 0;
  for (const root of roots) {
    for (const f of filesByRoot.get(root)) {
      if (f === "CLAUDE.md" || f === "AGENTS.md") {
        try {
          lines += fs.readFileSync(path.join(root, f), "utf8").split("\n").length;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return lines;
}
function countSkills(allFiles) {
  let n = 0;
  for (const f of allFiles) {
    const inSkills = f.startsWith(".claude/skills/") || f.startsWith("skills/") || f.includes("/.claude/skills/") || f.includes("/skills/");
    if (inSkills && f.split("/").pop().toUpperCase() === "SKILL.MD") n += 1;
  }
  return n;
}
function countValidators(allFiles) {
  let n = 0;
  for (const f of allFiles) {
    if (f.endsWith("/")) continue; // directory entry, not a file
    const inScripts = f.startsWith("scripts/") || f.includes("/scripts/");
    // Match the full path, like hasValidateScript, so scripts/validate/architecture.js
    // counts via its directory rather than only its basename.
    if (inScripts && /validate|verify|check|lint/i.test(f)) n += 1;
  }
  return n;
}
/** Attach a depth hint to key PASS-ing checks so a stub (1 test) is distinguishable from a mature project (hundreds). */
function enrichDepth(checks, ctx) {
  // Depth counters must see every project root, not just the top-level walk:
  // (tests/skills/validators in a deep submodule live in filesByRoot and can be
  // truncated out of allFiles by the listFiles(cwd, 7) depth cap). Normalize each
  // non-cwd root to cwd-relative paths so deep files are counted without
  // double-counting shallow ones already in allFiles.
  const cwd = ctx.roots[0];
  const allRootFiles = new Set(ctx.allFiles);
  for (const [root, files] of ctx.filesByRoot) {
    if (root === cwd) continue;
    const prefix = path.relative(cwd, root);
    for (const f of files) allRootFiles.add(prefix ? `${prefix}/${f}` : f);
  }
  const merged = [...allRootFiles];
  const set = (area, depth) => {
    const c = checks.find((x) => x.area === area);
    if (c && c.ok && depth) c.depth = depth;
  };
  set("Tests", `${countTestFiles(merged)} test file(s)`);
  set("Agent instructions", `${countInstructionLines(ctx.roots, ctx.filesByRoot)} instruction line(s)`);
  set("Reusable skills", `${countSkills(merged)} skill(s)`);
  set("Architecture sensors", `${countValidators(merged)} validator script(s)`);
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
    console.log(`${item.ok ? "PASS" : "MISS"}  ${item.area}${item.depth ? `  (${item.depth})` : ""}`);
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
