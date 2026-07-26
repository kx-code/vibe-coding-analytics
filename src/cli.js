import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execSync, spawnSync } from "node:child_process";

const COMMANDS = new Set(["init", "analytics", "scan", "evolve", "help"]);

export async function runCli(argv) {
  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(cliVersion());
    return;
  }

  const rawCommand = COMMANDS.has(argv[0]) ? argv[0] : argv[0] ? "help" : "help";
  // "scan" is the intuitive read-only audit name; "analytics" remains as a
  // backward-compatible alias (already shipped on npm).
  const command = rawCommand === "scan" ? "analytics" : rawCommand;
  const options = parseOptions(argv.slice(command === "help" && argv[0] !== "help" ? 0 : 1));

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
    const plan = buildEvolutionPlan(report, options);
    const files = buildEvolutionFiles(report, plan);
    printEvolution(report, plan);
    writeOrPreview(cwd, files, options.write);
  }
}

/** Read the package version from the cli.js-adjacent package.json (ESM-safe). */
function cliVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return pkg.version || "0.0.0-unknown";
  } catch {
    return "0.0.0-unknown";
  }
}

export function analyzeForTest(cwd) {
  return analyzeProject(path.resolve(cwd));
}

export function parseOptions(args) {
  const options = { write: false, cwd: null, format: "text", ciFailures: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--write") options.write = true;
    if (arg === "--cwd") options.cwd = args[++i];
    if (arg === "--format") options.format = args[++i] || "text";
    if (arg === "--ci-failures") options.ciFailures = true;
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
  const untrackedHarness = untrackedHarnessFiles(cwd, allFiles);

  const fractalDocs =
    countBasename(allFiles, "CLAUDE.md") >= 2 || countBasename(allFiles, "AGENTS.md") >= 2;

  const numberedRules = countNumberedRules(roots);
  const ruleTrace = analyzeRuleTraceability(roots, allFiles, cwd);
  const hooks = detectHooksConfig(roots);
  const isClaude = isClaudeCodeProject(roots);
  const hasFormatters = hasNodeFormatters(packageJson);
  // N/A semantics: a check that does not apply to this project should neither
  // count as a "missing area" nor earn score weight. We mark it `na` so the
  // scoring loop and printReport can exclude it (a check that is merely `ok`
  // but inapplicable would otherwise inflate the score — a perverse incentive).
  const hooksPresent = hooks.postToolUseLint && hooks.postToolUseFormat;
  const hooksNa = !isClaude || (!hasFormatters && !hooksPresent);
  const guardNa = !isClaude;
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
      "Agent hooks",
      hooksNa || hooksPresent,
      !isClaude
        ? "N/A — not a Claude Code project (no CLAUDE.md / .claude/settings*.json). PostToolUse hooks apply to Claude Code; skip for Codex/Cursor/Copilot stacks."
        : !hasFormatters
          ? "N/A — prettier + eslint not found in dependencies. Install them (npm i -D prettier eslint) then run `vca init --write` to scaffold edit-time lint+format hooks; omitted so non-Node stacks don't fail on every edit."
          : "Add .claude/settings.json hooks.PostToolUse on Edit|Write to run eslint + prettier -- format-on-save stops style drift and catches errors at edit time. (vca init --write scaffolds this.)",
      hooksNa,
    ),
    check(
      "Dangerous-command guard",
      guardNa || hooks.permissionsDeny,
      guardNa
        ? "N/A — not a Claude Code project (no CLAUDE.md / .claude/settings*.json). permissions.deny is a Claude Code settings mechanism."
        : "Add .claude/settings.local.json permissions.deny for irreversible commands (rm -rf, git push -f, git reset --hard, mkfs, dd, DROP TABLE) so agents cannot run them. (vca init --write scaffolds a default list.)",
      guardNa,
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
      "Rules traceability",
      ruleTrace.ok,
      ruleTrace.na
        ? "Once you have many numbered rules, back each with a test/validator that references it by name -- aggregate enforcement alone hides prose-only rules."
        : ruleTrace.unenforcedCount === 0
          ? `All ${ruleTrace.total} numbered rule(s) appear referenced by a test or validator sensor.`
          : `${ruleTrace.unenforcedCount}/${ruleTrace.total} numbered rule(s) are not referenced by any test or validator -- add sensors that enforce them by name. Examples: ${ruleTrace.examples.join("; ")}`,
      ruleTrace.na,
    ),
    check(
      "Steering loop",
      numberedRules >= 5,
      numberedRules >= 5
        ? "Keep growing numbered rules after each bug fix; each rule should map to a sensor (see Rule sensors)."
        : `Add numbered rules ("规则 N" / "Rule N") to CLAUDE.md/AGENTS.md that grow after each bug fix -- the rising count is the steering loop heartbeat. Found ${numberedRules}.`,
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
    check(
      "Harness files committed",
      untrackedHarness.length === 0,
      untrackedHarness.length === 0
        ? "Keep config/declaration files (env.d.ts, tsconfig.json, AGENTS.md) git-tracked; a broad gitignore rule (*.d.ts, *.env) silently drops them from CI checkouts."
        : `These harness files exist on disk but are NOT git-tracked -- remove the matching .gitignore rule (or 'git add -f'): ${untrackedHarness.join(", ")}`,
    ),
  ];

  enrichDepth(checks, { allFiles, roots, filesByRoot });
  // Weighted score: critical foundation checks (validation/tests/CI) and
  // enforcement checks weigh more than depth/maturity checks, so missing CI
  // hurts the score more than missing "Reusable skills".
  const weightOf = (area) =>
    ({
      "Single validation command": 3, Tests: 3, CI: 3,
      "Agent instructions": 2, Typecheck: 2, "Rule sensors": 2,
      "Architecture sensors": 2, "Agent hooks": 2, "Deploy hooks": 2, "Harness files committed": 2,
    })[area] ?? 1;
  let earned = 0;
  let total = 0;
  for (const c of checks) {
    const w = weightOf(c.area);
    c.weight = w;
    // N/A checks are excluded from the denominator entirely: an inapplicable
    // check must not dilute a passing score, nor pad it when it would otherwise
    // be low. Only applicable checks (na === false) count toward earned/total.
    if (c.na) continue;
    total += w;
    if (c.ok) earned += w;
  }
  const score = total === 0 ? 100 : Math.round((earned / total) * 100);
  const warnings = detectWarnings(checks);
  return { cwd, shape, roots, files: allFiles, packageJson, scripts, checks, score, warnings, untrackedHarness };
}

/** Surface false-safety combinations (grounded in SKILL.md Red Flags). */
function detectWarnings(checks) {
  const byArea = new Map(checks.map((c) => [c.area, c.ok]));
  const ok = (area) => byArea.get(area) === true;
  const warnings = [];
  if (ok("Tests") && !ok("CI")) {
    warnings.push({ code: "tests-without-ci", message: "Tests exist but no CI runs them -- they can drift to green-only-on-your-machine." });
  }
  if (ok("Agent instructions") && !ok("Tests") && !ok("CI")) {
    warnings.push({ code: "rules-without-enforcement", message: "Agent rules exist but no tests or CI enforce them -- prose-only rules drift." });
  }
  if (!ok("Single validation command") && (ok("Tests") || ok("CI"))) {
    warnings.push({ code: "no-single-command", message: "No single ci/validate command -- agents cannot prove the repo is healthy in one step." });
  }
  return warnings;
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
/** Source-code extensions counted inside a recognized test directory.
 *  Allowlist (not blocklist) so placeholders (.gitkeep), binaries, fixtures,
 *  docs and configs are excluded in one shot. */
const TEST_DIR_SOURCE_EXT = /\.(?:[cm]?js|tsx?|jsx|py|go|rs|rb|java|kt|kts|c(?:pp|\+\+)?|h(?:pp|h)?|cc|sh|bash|zsh|dart|swift|php|cs|scala|clj|ex|exs|lua|pl|r|tcl)$/i;

function countTestFiles(allFiles) {
  let n = 0;
  for (const file of allFiles) {
    if (file.endsWith("/")) continue; // directory entry, not a file
    const base = file.split("/").pop();
    if (isTestFile(base)) { n += 1; continue; }
    // Recognized test directory (Mocha test/, tests/, Jest __tests__/): a source
    // file here counts even without a .test/.spec suffix, mirroring the Tests
    // check hasPrefixAt("test/"|"tests/") predicate.
    if (/(^|\/)(test|tests|__tests__)\//.test(file) && TEST_DIR_SOURCE_EXT.test(base)) {
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
          // Trim trailing newline(s): Markdown convention ends files with \n,
          // which would otherwise add an empty segment and overstate the
          // instruction-line depth hint by one per AGENTS/CLAUDE.md (off-by-one).
          const instructionText = fs.readFileSync(path.join(root, f), "utf8").replace(/\n+$/, "");
          lines += instructionText === "" ? 0 : instructionText.split("\n").length;
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
  // Maturity grade thresholds: count <= stub = "stub", <= functional = "functional",
  // otherwise "mature". Subjective by nature; tuned to separate a stub from a mature project.
  const gradeFor = (area, count) => {
    const t =
      ({
        Tests: { stub: 2, functional: 10 },
        "Agent instructions": { stub: 10, functional: 50 },
        "Reusable skills": { stub: 1, functional: 3 },
        "Architecture sensors": { stub: 1, functional: 3 },
        "Steering loop": { stub: 9, functional: 19 },
      })[area];
    if (!t) return undefined;
    if (count <= t.stub) return "stub";
    if (count <= t.functional) return "functional";
    return "mature";
  };
  const set = (area, count, unit) => {
    const c = checks.find((x) => x.area === area);
    // count may legitimately be 0 (e.g. "0 test file(s)"); guard on ok + presence, not truthiness.
    if (c && c.ok && count !== undefined) {
      c.depth = `${count} ${unit}`;
      const grade = gradeFor(area, count);
      if (grade) c.grade = grade;
    }
  };
  set("Tests", countTestFiles(merged), "test file(s)");
  set("Agent instructions", countInstructionLines(ctx.roots, ctx.filesByRoot), "instruction line(s)");
  set("Reusable skills", countSkills(merged), "skill(s)");
  set("Architecture sensors", countValidators(merged), "validator script(s)");
  set("Steering loop", countNumberedRules(ctx.roots), "numbered rule(s)");
}

function check(area, ok, action, na = false) {
  return { area, ok, action, na: Boolean(na) };
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

/** Count numbered rules ("规则 N" / "Rule N") across project roots. */
function countNumberedRules(roots) {
  let count = 0;
  for (const root of roots) {
    for (const name of ["CLAUDE.md", "AGENTS.md"]) {
      try {
        const text = fs.readFileSync(path.join(root, name), "utf8");
        const matches = text.match(/(?:规则|Rule)\s*\d+/gi);
        if (matches) count += matches.length;
      } catch {
        /* ignore */
      }
    }
  }
  return count;
}

/** Per-rule traceability: extract numbered-rule prose, pull keywords, and check each
 *  against a corpus of test/validator file contents. N/A (pass) when there are no
 *  numbered rules or no sensor corpus -- the coarse "Rule sensors" check covers the
 *  latter so we don't double-penalize. Chinese-only rules yield no keywords (no word
 *  boundaries) and are skipped rather than false-flagged. */
function analyzeRuleTraceability(roots, allFiles, cwd) {
  const rules = [];
  for (const root of roots) {
    for (const name of ["CLAUDE.md", "AGENTS.md"]) {
      try {
        const text = fs.readFileSync(path.join(root, name), "utf8");
        const re = /^[ \t]*(?:规则|Rule)\s*\d+\s*[:：.\-—)]?[ \t]*(.+)/gim;
        let m;
        while ((m = re.exec(text)) !== null) {
          const t = m[1].trim();
          if (t) rules.push(t);
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (rules.length === 0) {
    return { ok: true, total: 0, unenforcedCount: 0, examples: [], na: true };
  }
  const sensorFiles = [];
  for (const f of allFiles) {
    if (f.endsWith("/")) continue; // directory entry, not a file
    const base = f.split("/").pop();
    const isSensor =
      isTestFile(base) ||
      /(^|\/)(test|tests|__tests__|scripts)\//i.test(f) ||
      /(validate|verify|check|lint)/i.test(f);
    if (!isSensor) continue;
    if (!/\.(?:[cm]?js|tsx?|jsx|py|go|rs|rb|ya?ml|md|sh|bash)$/i.test(base)) continue;
    sensorFiles.push(f);
  }
  let corpus = "";
  for (const f of sensorFiles.slice(0, 50)) {
    try {
      corpus += "\n" + fs.readFileSync(path.join(cwd, f), "utf8");
    } catch {
      /* ignore unreadable files */
    }
  }
  corpus = corpus.toLowerCase();
  if (!corpus.trim()) {
    return { ok: true, total: rules.length, unenforcedCount: 0, examples: [], na: true };
  }
  const STOPWORDS = new Set(
    "the a an to is are was must should may can cannot be in on at and or nor not do does for of with without when whenever before after each every all any no if then else this that these those it its their our your you we they them as by from into out up down using use used".split(" "),
  );
  let unenforced = 0;
  const examples = [];
  for (const rule of rules) {
    const kws = rule
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    const unique = [...new Set(kws)].slice(0, 6);
    if (unique.length === 0) continue;
    if (!unique.some((kw) => corpus.includes(kw))) {
      unenforced += 1;
      if (examples.length < 3) examples.push(rule.slice(0, 70));
    }
  }
  return { ok: unenforced === 0, total: rules.length, unenforcedCount: unenforced, examples, na: false };
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

/** True when f sits inside a nested repo/worktree/submodule: an ancestor dir carries its own .git. */
function insideNestedRepo(cwd, f) {
  const parts = f.split("/");
  for (let i = 1; i < parts.length; i += 1) {
    const ancestor = parts.slice(0, i).join("/");
    if (fs.existsSync(path.join(cwd, ancestor, ".git"))) return true;
  }
  return false;
}

/** Harness anchor files that exist on disk but are NOT git-tracked. A broad gitignore
 *  (*.d.ts, *.env) can silently drop env.d.ts/tsconfig.json/AGENTS.md from CI checkouts,
 *  so they reproduce locally but fail in CI. N/A outside a git repo. */
function untrackedHarnessFiles(cwd, allFiles) {
  // Detect a git repo even when cwd is a subdirectory (--cwd packages/app):
  // .git lives in an ancestor, so fs.existsSync(cwd/.git) misses it and the
  // check would silently pass for gitignored harness files. Probe via git.
  let inGitRepo = fs.existsSync(path.join(cwd, ".git"));
  if (!inGitRepo) {
    const probe = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8" });
    inGitRepo = probe.status === 0 && probe.stdout.trim() === "true";
  }
  if (!inGitRepo) return [];
  const BUILD_OUT_RE = /(^|\/)(dist|build|\.next|\.astro|node_modules|out|coverage)\//i;
  const offenders = [];
  for (const f of allFiles) {
    const isAnchor = /(^|\/)(AGENTS\.md|CLAUDE\.md|env\.d\.ts|tsconfig\.json|jsconfig\.json)$/i.test(f)
      || (/\.d\.ts$/i.test(f) && !BUILD_OUT_RE.test(f));
    if (!isAnchor) continue;
    if (insideNestedRepo(cwd, f)) continue;
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

/** A deny list only counts as a real guard if it actually blocks at least one
 *  irreversible command — a list of only `WebFetch` or harmless entries must not
 *  pass. Matches the same families that defaultDenyList scaffolds. */
const DANGEROUS_DENY_PATTERN = /rm\s+-r|git\s+push.*(-f|force)|git\s+reset.*--hard|git\s+clean|mkfs|dd\s+if|drop\s+(table|database)|truncate|>\s*\/dev\/sd|curl.*\|\s*(sh|bash)|wget.*\|\s*(sh|bash)/i;

/** Detect Claude Code hooks + permission-guard config across project roots.
 *  PostToolUse(Edit|Write)->lint+format stops style drift at edit time; a
 *  non-empty permissions.deny blocks irreversible commands. Both are the
 *  highest-leverage agent safety nets after tests/CI. */
function detectHooksConfig(roots) {
  let postToolUseLint = false;
  let postToolUseFormat = false;
  let permissionsDeny = false;
  for (const root of roots) {
    const settings = readJson(path.join(root, ".claude", "settings.json"));
    const postTool = settings?.hooks?.PostToolUse;
    const entries = Array.isArray(postTool) ? postTool : postTool ? [postTool] : [];
    for (const entry of entries) {
      // The matcher must cover BOTH Edit and Write — the scaffold promises
      // `Edit|Write`. An unanchored `/Edit|Write/` would accept a matcher that
      // hooks only one of the two, leaving the other mutation tool unchecked.
      const matcher = entry?.matcher || "";
      if (!/Edit/i.test(matcher) || !/Write/i.test(matcher)) continue;
      const cmds = (entry.hooks || []).map((h) => h?.command || "").join("\n");
      if (/eslint|lint/i.test(cmds)) postToolUseLint = true;
      if (/prettier|format/i.test(cmds)) postToolUseFormat = true;
    }
    // permissions.deny may live in the shared settings.json OR the gitignored
    // settings.local.json — check both so a project keeping its deny list in
    // shared settings isn't falsely reported as missing the guard.
    const local = readJson(path.join(root, ".claude", "settings.local.json"));
    for (const denyList of [settings?.permissions?.deny, local?.permissions?.deny]) {
      if (Array.isArray(denyList) && denyList.some((d) => DANGEROUS_DENY_PATTERN.test(String(d)))) {
        permissionsDeny = true;
      }
    }
  }
  return { postToolUseLint, postToolUseFormat, permissionsDeny };
}

/** A project is "Claude Code" when it ships CLAUDE.md or a .claude/settings*.json
 *  file. A bare `.claude/commands/` dir is NOT enough — `vca init` scaffolds those
 *  slash commands for any stack, so counting them would make a fresh non-Claude
 *  baseline fail its own newly-added hook checks on the next scan. */
function isClaudeCodeProject(roots) {
  return roots.some((root) =>
    fs.existsSync(path.join(root, "CLAUDE.md")) ||
    fs.existsSync(path.join(root, ".claude", "settings.json")) ||
    fs.existsSync(path.join(root, ".claude", "settings.local.json")));
}

/** Detect whether the project declares prettier + eslint as dependencies, so we
 *  only scaffold Node edit-time hooks where they can actually run. Without this
 *  gate, a Python/Go/Rust Claude project would invoke undeclared prettier/eslint
 *  (via npx) on every Edit/Write. */
function hasNodeFormatters(packageJson) {
  const deps = { ...packageJson?.dependencies, ...packageJson?.devDependencies };
  return Boolean(deps?.prettier) && Boolean(deps?.eslint);
}

/** DB projects get extra deny guards (DROP/TRUNCATE) since those are
 *  irreversible in any stack with a database. Detected from migrations,
 *  ORM configs, or package deps. */
function isDbProject(report) {
  const paths = [...report.files].join("\n").toLowerCase();
  const dbFileSignals = ["prisma/schema", "drizzle", "knexfile", "migrations/", "schema.sql", "/supabase/"];
  if (dbFileSignals.some((sig) => paths.includes(sig))) return true;
  const deps = { ...report.packageJson?.dependencies, ...report.packageJson?.devDependencies };
  return Boolean(deps?.prisma || deps?.drizzle || deps?.knex || deps?.typeorm || deps?.sequelize);
}

/** Default irreversible-command deny list, generalized from production rules.
 *  Bash(...) patterns follow Claude Code permission syntax. */
function defaultDenyList(report) {
  const deny = [
    "Bash(rm -rf:*)",
    "Bash(rm -r /)",
    "Bash(git push --force:*)",
    "Bash(git push -f:*)",
    "Bash(git reset --hard:*)",
    "Bash(git clean -fd:*)",
    "Bash(sudo rm:*)",
    "Bash(mkfs:*)",
    "Bash(dd if=:*)",
    "Bash(> /dev/sd:*)",
    "Bash(:> *)",
    "Bash(curl * | sh)",
    "Bash(curl * | bash)",
    "Bash(wget * | sh)",
    "Bash(wget * | bash)",
  ];
  if (isDbProject(report)) {
    deny.push("Bash(DROP TABLE:*)", "Bash(DROP DATABASE:*)", "Bash(TRUNCATE TABLE:*)");
  }
  return deny;
}

/** Read the edited file path from the hook's stdin JSON payload using the Node
 *  runtime — guaranteed present because prettier/eslint are npm deps — instead
 *  of the external `jq` executable, which minimal CI/dev images may not ship and
 *  which is not a declared prerequisite of this package. Piped through
 *  `xargs -I{}` so paths with spaces/quotes survive (bare `xargs` word-splits
 *  `docs/my file.md` into two targets). */
const HOOK_READ_PATH = `node -e "const f=JSON.parse(require('fs').readFileSync(0,'utf8')).tool_input?.file_path;if(f)console.log(f)"`;

/** Claude Code settings.json with PostToolUse(Edit|Write) -> prettier + eslint.
 *  Format-on-save + lint-on-edit are the cheapest computational sensors.
 *  Returns null when prettier/eslint aren't declared deps, so we never scaffold
 *  Node hooks that would fail on every edit in a non-Node stack. */
function claudeHooksSettings(packageJson) {
  if (!hasNodeFormatters(packageJson)) return null;
  const config = {
    hooks: {
      PostToolUse: [
        {
          matcher: "Edit|Write",
          hooks: [
            { type: "command", command: `${HOOK_READ_PATH} | xargs -I{} npx prettier --write {}` },
            { type: "command", command: `${HOOK_READ_PATH} | xargs -I{} npx eslint --no-warn-ignored {}` },
          ],
        },
      ],
    },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Claude Code settings.local.json with a deny list of irreversible commands. */
function claudePermissionsLocal(report) {
  const config = { permissions: { allow: [], ask: [], deny: defaultDenyList(report) } };
  return `${JSON.stringify(config, null, 2)}\n`;
}

function printHelp() {
  console.log(`vibe-coding-analytics

Usage:
  npx vibe-coding-analytics scan [--cwd path]
  npx vibe-coding-analytics init [--cwd path] [--write]
  npx vibe-coding-analytics evolve [--cwd path] [--write] [--ci-failures]

Commands:
  scan       Audit the current project harness and print gaps (alias: analytics).
  init       Propose or write baseline AI coding harness files.
  evolve     Propose or write self-evolution loop files.

Flags:
  --write         Create missing harness files instead of previewing them.
  --cwd path      Operate on a different directory.
  --format json   (analytics) Emit the report as JSON.
  --ci-failures   (evolve) Mine recent CI failures via \`gh\` and list the worst offenders.

By default commands are read-only.`);
}

export function printReport(report) {
  console.log(`Vibe Coding Analytics: ${report.cwd}`);
  console.log(`Project shape: ${report.shape}`);
  console.log(`Harness score: ${report.score}/100\n`);
  for (const item of report.checks) {
    const grade = item.grade ? ` · ${item.grade}` : "";
    const label = item.na ? "N/A" : item.ok ? "PASS" : "MISS";
    console.log(`${label}  ${item.area}${item.depth ? `  (${item.depth})` : ""}${grade}`);
    if (!item.ok && !item.na) console.log(`      ${item.action}`);
  }
  if (report.warnings && report.warnings.length) {
    console.log("\nWarnings:");
    for (const w of report.warnings) console.log(`! ${w.message}`);
  }
  const missing = report.checks.filter((c) => !c.ok && !c.na);
  if (missing.length) {
    console.log(
      `\n→ ${missing.length} missing area(s). Run \`vca evolve --write\` to backfill hooks, deny list, commands, and sensors — or \`vca init --write\` for the full baseline harness.`,
    );
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
  if (safePlan.ciFailures && !safePlan.ciFailures.available) {
    console.log(`CI failure mining skipped (${safePlan.ciFailures.reason}): install and authenticate \`gh\` to enable --ci-failures.`);
    console.log();
  } else if (safePlan.ciFailures && safePlan.ciFailures.available && safePlan.ciFailures.failures.length) {
    console.log("Recent CI failures:");
    for (const f of safePlan.ciFailures.failures) console.log(`- ${f.workflow} (${f.count}x)`);
    console.log();
  } else if (safePlan.ciFailures && safePlan.ciFailures.available) {
    console.log("No recent CI failures.");
    console.log();
  }
}

function detectPackageManager(cwd, packageJson) {
  // Explicit packageManager field wins; otherwise infer from lockfile.
  if (packageJson && packageJson.packageManager) {
    const pm = String(packageJson.packageManager).split("@")[0].trim();
    if (pm === "npm" || pm === "pnpm" || pm === "yarn" || pm === "bun") return pm;
  }
  // Walk up the directory tree so a workspace subdirectory inherits the
  // package manager declared by the workspace root lockfile.
  let dir = cwd;
  while (true) {
    try {
      if (fs.existsSync(path.join(dir, "package-lock.json"))) return "npm";
      if (fs.existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
      if (fs.existsSync(path.join(dir, "yarn.lock"))) return "yarn";
      if (fs.existsSync(path.join(dir, "bun.lockb")) || fs.existsSync(path.join(dir, "bun.lock"))) return "bun";
    } catch {
      /* ignore fs errors (e.g. permission) */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root reached
    dir = parent;
  }
  return "npm";
}

function buildInitFiles(report) {
  const name = report.packageJson?.name || path.basename(report.cwd);
  const files = [
    file("AGENTS.md", agentInstructions(name, report.packageJson?.scripts, Boolean(report.packageJson), detectPackageManager(report.cwd, report.packageJson))),
    file(".github/copilot-instructions.md", copilotInstructions(name)),
    file("docs/knowledge-base/patterns.md", "# Patterns\n\nDocument project-specific code patterns that agents should reuse.\n"),
    file("docs/knowledge-base/constraints.md", "# Constraints\n\nDocument rules that must not be violated. Promote repeated rules into tests or validators.\n"),
    file("docs/knowledge-base/known-issues.md", "# Known Issues\n\nTrack recurring failures, root causes, and the sensor added to prevent recurrence.\n"),
    file(".claude/commands/analytics.md", slashAnalyticsCommand()),
    file(".claude/commands/init.md", slashInitCommand()),
    file(".claude/commands/evolve.md", slashEvolveCommand()),
    file(".claude/commands/steer.md", slashSteerCommand()),
  ];
  // Claude Code projects: scaffold PostToolUse lint+format hooks + a deny list
  // of irreversible commands. Skipped for non-Claude stacks (Codex/Cursor).
  // Hooks (settings.json) are also gated on prettier+eslint being present so we
  // don't break every edit in a non-Node stack. The deny list (settings.local.json)
  // is tool-agnostic and valuable for any Claude project, so it is always emitted.
  if (isClaudeCodeProject(report.roots)) {
    files.push(file(".claude/settings.local.json", claudePermissionsLocal(report), mergePermissionsLocal));
    const hooksContent = claudeHooksSettings(report.packageJson);
    if (hooksContent) files.push(file(".claude/settings.json", hooksContent, mergeHooksSettings));
  }
  return files;
}

const EVOLVE_PROMOTIONS = {
  "Project facts": { promoteTo: "README / CLAUDE.md", action: "Add a README or CLAUDE.md with architecture, setup, and validation commands." },
  "Agent instructions": { promoteTo: "AGENTS.md / CLAUDE.md rule", action: "Add AGENTS.md or CLAUDE.md so agents inherit stable project rules." },
  "Single validation command": { promoteTo: "package script / Makefile target", action: "Add an npm run ci/validate script (or a Makefile ci/validate target) that agents run before completion." },
  "Typecheck": { promoteTo: "typecheck script", action: "Add a typecheck/lint script appropriate to the stack." },
  "Tests": { promoteTo: "regression test", action: "Add a failing test for the most recent bug, then make it pass." },
  "CI": { promoteTo: "CI workflow", action: "Add CI that runs the same local validation command on every push." },
  "Project memory": { promoteTo: "docs/knowledge-base entry", action: "Add docs/knowledge-base patterns/constraints/known-issues." },
  "Reusable skills": { promoteTo: "project skill", action: "Create a skill for a repeated workflow (validate, deploy, migrate, debug)." },
  "Specialist reviewers": { promoteTo: "reviewer agent", action: "Add a reviewer agent for the highest-risk domain." },
  "Architecture sensors": { promoteTo: "architecture validator", action: "Add a scripts/validate validator for rules that should not rely on memory." },
  "Agent hooks": { promoteTo: ".claude/settings.json PostToolUse hooks", action: "Add PostToolUse(Edit|Write) hooks running eslint + prettier so every edit is lint+format checked at edit time." },
  "Dangerous-command guard": { promoteTo: ".claude/settings.local.json deny list", action: "Add permissions.deny for irreversible commands (rm -rf, git push -f, git reset --hard, mkfs, dd, DROP TABLE)." },
  "Deploy hooks": { promoteTo: "deploy script / CI workflow", action: "Add a deploy/release script or .github/workflows/*.yml so deployments are repeatable and auditable." },
  "Rule sensors": { promoteTo: "test / validator / lint rule", action: "Back prose rules with a computational sensor (test, lint rule, or scripts/validator) so violations are caught, not just documented." },
  "Rules traceability": { promoteTo: "named test / validator per rule", action: "For each numbered rule no sensor references, add a test or validator whose name/path mentions the rule keyword." },
  "Steering loop": { promoteTo: "numbered rules section in CLAUDE.md", action: "Start a numbered rules section (Rule N) in CLAUDE.md/AGENTS.md and add a rule after each bug fix; the rising count is the feedback-loop heartbeat." },
  "Failure observability": { promoteTo: "monitor / alert / health-check", action: "Add a monitor, alert, or health-check (script or CI cron) so critical-path failures surface instead of failing silently." },
  "Cross-session memory": { promoteTo: "ADR / decisions log", action: "Add docs/decisions/ ADRs or a .claude/memory log so decisions survive across sessions." },
  "Harness files committed": { promoteTo: "git-tracked harness files", action: "git add harness files that are gitignored or untracked so the next agent inherits them." },
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

/** Build a concrete evolution plan from analytics gaps + recent fix history.
 *  options.ciFailures opts into attaching a ciFailures block to the plan. */
export function buildEvolutionPlan(report, options = {}) {
  const plan = {
    recommendations: evolutionRecommendations(report),
    fixPatterns: recentFixPatterns(report.cwd),
  };
  if (options.ciFailures) {
    const gh = options.ghRunner || ((args, opts) => spawnSync("gh", args, opts));
    const probe = gh(["--version"], {});
    if (probe && probe.status === 0) {
      const run = gh(
        ["run", "list", "--status", "failure", "--limit", "10", "--json", "workflowName", "-q", ".[].workflowName"],
        { cwd: report.cwd, encoding: "utf8" },
      );
      const counts = new Map();
      for (const wf of (run && run.status === 0 ? run.stdout : "").split("\n").map((s) => s.trim()).filter(Boolean)) {
        counts.set(wf, (counts.get(wf) || 0) + 1);
      }
      const failures = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([workflow, count]) => ({ workflow, count }));
      plan.ciFailures = { available: true, failures };
    } else {
      plan.ciFailures = { available: false, reason: "gh-not-found", failures: [] };
    }
  }
  return plan;
}

function buildEvolutionFiles(report, plan) {
  const name = report.packageJson?.name || path.basename(report.cwd);
  const safePlan = plan || buildEvolutionPlan(report);
  const files = [
    file("docs/knowledge-base/agent-evolution.md", evolutionDoc(name, safePlan)),
    file(".claude/commands/evolve.md", slashEvolveCommand()),
    file(".claude/commands/steer.md", slashSteerCommand()),
    file(".claude/skills/project-evolution/SKILL.md", projectEvolutionSkill(name)),
  ];
  // evolve also backfills hooks + deny list when missing on Claude Code projects.
  // When settings already exist (but lack the hook/deny entry), writeOrPreview
  // MERGES the missing keys instead of skipping — otherwise the backfill this
  // command advertises would be a no-op and the next scan would still MISS.
  if (isClaudeCodeProject(report.roots)) {
    files.push(file(".claude/settings.local.json", claudePermissionsLocal(report), mergePermissionsLocal));
    const hooksContent = claudeHooksSettings(report.packageJson);
    if (hooksContent) files.push(file(".claude/settings.json", hooksContent, mergeHooksSettings));
  }
  return files;
}

function file(relativePath, content, merge) {
  return { relativePath, content, merge };
}

/** Merge PostToolUse hooks into an existing settings.json without clobbering
 *  unrelated user settings. Dedupes commands within the Edit|Write matcher.
 *  Used as the `merge` strategy so `evolve --write` backfills hooks even when
 *  settings.json already exists with user content. */
function mergeHooksSettings(existingContent, incomingContent) {
  const existing = JSON.parse(existingContent);
  const incoming = JSON.parse(incomingContent);
  existing.hooks ??= {};
  existing.hooks.PostToolUse ??= [];
  for (const entry of incoming.hooks?.PostToolUse || []) {
    const matcher = entry.matcher || "";
    const idx = existing.hooks.PostToolUse.findIndex((e) => (e.matcher || "") === matcher);
    if (idx === -1) {
      existing.hooks.PostToolUse.push(entry);
    } else {
      // Preserve existing hook objects (which may carry `timeout`, `prompt`,
      // or other fields) and only append incoming *command* hooks whose command
      // string is not already present. Rebuilding the whole list from a Set of
      // command strings would (a) drop `timeout`, and (b) turn prompt/agent
      // hooks (no `command` field) into invalid `{type:"command",command:undefined}`.
      const existingEntry = existing.hooks.PostToolUse[idx];
      existingEntry.hooks ??= [];
      const knownCmds = new Set(existingEntry.hooks.map((h) => h?.command));
      for (const h of entry.hooks || []) {
        if (h?.command && !knownCmds.has(h.command)) {
          existingEntry.hooks.push(h);
          knownCmds.add(h.command);
        }
      }
    }
  }
  return `${JSON.stringify(existing, null, 2)}\n`;
}

/** Merge the deny list into an existing settings.local.json without clobbering
 *  existing allow/ask entries. Unions deny arrays, dedupes entries. */
function mergePermissionsLocal(existingContent, incomingContent) {
  const existing = JSON.parse(existingContent);
  const incoming = JSON.parse(incomingContent);
  existing.permissions ??= {};
  existing.permissions.deny ??= [];
  const set = new Set(existing.permissions.deny);
  for (const d of incoming.permissions?.deny || []) set.add(d);
  existing.permissions.deny = [...set];
  return `${JSON.stringify(existing, null, 2)}\n`;
}

/** Wrap a merge strategy so an unparseable/partially-existing target file never
 *  crashes the run; skip with a warning instead and let the user merge manually. */
function safeMerge(mergeFn, existing, incoming, relativePath) {
  try {
    return mergeFn(existing, incoming);
  } catch (err) {
    console.warn(`  ! Skipped merge for ${relativePath}: existing file is not valid JSON or merge failed (${err.message}). Edit manually.`);
    return null;
  }
}

function writeOrPreview(cwd, files, write) {
  const create = [];
  const merge = [];
  for (const item of files) {
    const target = path.join(cwd, item.relativePath);
    if (!fs.existsSync(target)) {
      create.push(item);
    } else if (typeof item.merge === "function") {
      // File exists but may be missing the keys we backfill; merge instead of skip.
      merge.push(item);
    }
    // else: exists and not mergeable -> intentionally leave the user's file alone.
  }
  if (!create.length && !merge.length) {
    console.log("\nNo missing harness files from this template set.");
    return;
  }

  if (create.length) {
    console.log(`\n${write ? "Writing" : "Would write"} ${create.length} file(s):`);
    for (const item of create) {
      console.log(`- ${item.relativePath}`);
      if (write) {
        const target = path.join(cwd, item.relativePath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, item.content);
      }
    }
  }
  if (merge.length) {
    console.log(`\n${write ? "Merging" : "Would merge"} into ${merge.length} existing file(s):`);
    for (const item of merge) {
      console.log(`- ${item.relativePath}`);
      if (write) {
        const target = path.join(cwd, item.relativePath);
        const existing = fs.readFileSync(target, "utf8");
        const merged = safeMerge(item.merge, existing, item.content, item.relativePath);
        if (merged !== null) fs.writeFileSync(target, merged);
      }
    }
  }

  if (!write) console.log("\nRun again with --write to apply these changes.");
}

function agentInstructions(name, scripts, hasPackageJson = false, pm = "npm") {
  // Emit `npm run <script>` rather than the raw body: locally installed binaries
  //  (vite, tsc, eslint) are only on PATH when run through npm scripts.
  const cmd = (...keys) => {
    for (const k of keys) if (scripts && scripts[k]) return `${pm} run ${k}`;
    return "";
  };
  const dev = cmd("dev", "start");
  const validate = cmd("verify", "validate", "ci");
  const build = cmd("build");
  const testCmd = cmd("test");
  const line = (label, value) => `- ${label}: ${value || ""}`;
  return `# ${name} Agent Instructions

## Project Facts

- Fill in architecture, runtime, deployment, and data model facts.
- Keep stable facts here. Put temporary notes in issues or plans.

## Commands

${line("Install", hasPackageJson ? `${pm} install` : "")}
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

function slashSteerCommand() {
  return `Steer the harness after a bug fix or a repeated failure.

For the issue just fixed, run the steering loop:

1. **Root-cause the harness gap** — ask "Why did the harness (tests, lint, validators, rules) NOT catch this?" Name the specific missing sensor.
2. **Add the smallest durable sensor** that would have caught it, in order of preference:
   - a regression test that reproduces the bug (preferred — computational and self-verifying)
   - a lint rule or a scripts/ architecture validator
   - a numbered rule (Rule N) in CLAUDE.md / AGENTS.md
   - a slash command or a specialist reviewer agent
3. **Verify the sensor fires** — confirm it fails on the pre-fix code and passes after the fix.
4. **Record it** — append a numbered rule and note which sensor now enforces it.

A rule without a sensor is documentation that decays; a sensor without a rule is silent enforcement. Add both when it matters.

Designed for loop usage, for example:
\`\`\`text
/loop 30m /steer
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
