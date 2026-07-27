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
  const { flat: scripts, byName: workspaceScripts } = collectAllScripts(cwd, allFiles);
  const shape = detectShape(cwd, packageJson);
  const untrackedHarness = untrackedHarnessFiles(cwd, allFiles);

  const fractalDocs =
    countBasename(allFiles, "CLAUDE.md") >= 2 || countBasename(allFiles, "AGENTS.md") >= 2;

  const numberedRules = countNumberedRules(roots);
  const ruleTrace = analyzeRuleTraceability(roots, allFiles, cwd);
  const hooks = detectHooksConfig(roots, scripts, workspaceScripts);
  const isClaude = isClaudeCodeProject(allFiles);
  const hasFormatters = hasNodeFormattersAnywhere(roots);
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
  return { cwd, shape, roots, files: allFiles, packageJson, scripts, workspaceScripts, checks, score, warnings, untrackedHarness };
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

/** Merge scripts from every package.json in the tree (root + nested subpackages).
 *  Returns the flat merged `scripts` map (last-write-wins across packages) AND a
 *  `byName` map keyed by each package's `name` — the identity `npm run
 *  --workspace <name>` uses to select a specific package, so a workspace-scoped
 *  script invocation can be resolved against THAT package's scripts rather than
 *  the flattened value (which belongs to whichever manifest was visited last). */
function collectAllScripts(cwd, allFiles) {
  const flat = {};
  const byName = {};
  for (const file of allFiles) {
    if (file.includes("node_modules/")) continue;
    if (file === "package.json" || file.endsWith("/package.json")) {
      const pkg = readJson(path.join(cwd, file));
      if (pkg && pkg.scripts) {
        Object.assign(flat, pkg.scripts);
        if (typeof pkg.name === "string" && pkg.name) byName[pkg.name] = pkg.scripts;
      }
    }
  }
  return { flat, byName };
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
 *  irreversible command. Two substring traps must be avoided:
 *   1. The dangerous verb buried in an argument — `Bash(echo rm -rf:*)` blocks
 *      `echo`, not `rm`. Guarded by extracting the command prefix (the denied
 *      line before the first `:`) and anchoring every alternative with `^`.
 *   2. A flag that is merely a substring of a longer token — `git push origin
 *      release-feature` is NOT a force push (the `-f` lives inside the branch
 *      name), and `rm -readme` is NOT `rm -r` (the `-r` is the prefix of the
 *      longer token `-readme`). Guarded by requiring token boundaries: long
 *      flags must be whitespace-delimited, and short-flag clusters must be drawn
 *      from the verb's real flag alphabet (`[frRivIdP]` for rm) and terminated
 *      by whitespace or end-of-line.
 *  Matches the same families that defaultDenyList scaffolds. */
const DANGEROUS_CMD_RE = new RegExp(
  "^(?:" +
    [
      // rm with a RECURSIVE flag is irreversible (force only suppresses the
      // prompt), so any recursive form counts. `.*?` lets the recursive flag
      // appear after preceding flags (`rm -f -r`, `rm --force --recursive`),
      // not only as the first cluster. Token-bounded so `rm -readme` (the -r
      // is a prefix of the longer token -readme, not a flag) does not match.
      "rm\\s+.*?-[frRivIdP]*[rR][frRivIdP]*(?=\\s|$)",
      "rm\\s+.*?--recursive\\b",
      "git\\s+push\\b.*?\\s(?:--force|-f)(?:\\s|$)",
      "git\\s+reset\\b.*?\\s--hard(?:\\s|$)",
      // git clean needs a FORCE flag to actually delete (without -f git refuses;
      // -n/--dry-run only previews). Require -f in a short-flag cluster or
      // --force, so `Bash(git clean -n:*)` (a safe preview) does not false-satisfy
      // the guard and skip scaffolding of rm -rf / force-push protection.
      "git\\s+clean\\b.*?(?:--force\\b|-[fdxXnie]*f[fdxXnie]*(?:\\s|$))",
      // Bare executables need a token boundary so a deny entry whose command
      // merely STARTS WITH the verb — `Bash(mkfs-report:*)`, `Bash(truncate-log:*)`
      // — does not false-satisfy the guard: such an entry blocks a DIFFERENT
      // command, leaving rm -rf / force-push unguarded while detection reports
      // the guard installed. `(?![\w-])` rejects a following letter/digit/
      // underscore/hyphen (a different command name: `mkfs-report`, `truncated`)
      // but accepts `.`, `/`, space, or end-of-line, so the bare verb (`mkfs`,
      // `TRUNCATE TABLE`) AND the `mkfs.ext4` filesystem-type suffix still match.
      "mkfs(?![\\w-])",
      // dd is destructive when it WRITES to a block device (`dd of=/dev/sda`,
      // `dd if=/dev/zero of=/dev/sda`); `if=` is optional (stdin default) and a
      // read-only `dd if=/dev/sda` is not irreversible. Match the device OUTPUT
      // operand wherever it appears, so the guard is not satisfied by a deny
      // entry that only blocks the `if=` form.
      "dd\\s+.*?\\bof\\s*=\\s*\\/dev\\/",
      "drop\\s+(?:table|database)",
      "truncate(?![\\w-])",
      // SQL reaches the DB through a client, not as a bare command: block the
      // execute flags. Lookahead-terminated so `psql --cluster` / `mysql -u`
      // (where -c/-e is a substring of a different flag) don't false-match.
      "psql\\s+.*?-(?:c|f)(?=\\s|$)",
      "mysql\\s+.*?(?:-e|--execute)(?=\\s|$)",
      "prisma\\s+migrate\\s+reset\\b",
      ">\\s*\\/dev\\/sd",
      "curl.*\\|\\s*(?:sh|bash)",
      "wget.*\\|\\s*(?:sh|bash)",
    ].join("|") +
    ")",
  "i",
);

/** A Claude Code deny entry looks like `Bash(<command>:<qualifier>)` (or
 *  `Bash(<command>)`). The blocked command is the `<command>` prefix before the
 *  first `:`. Return true only when THAT prefix starts with an irreversible
 *  command — never when the dangerous verb is merely mentioned later in the line
 *  or hidden inside a longer token like a branch or file name. */
function denyEntryBlocksDangerousCommand(entry) {
  const m = String(entry).trim().match(/^Bash\(([^)]*)\)$/);
  if (!m) return false;
  let cmd = m[1];
  // Claude Code's argument qualifier is a trailing `:*` (e.g. `Bash(rm -rf:*)`).
  // Strip ONLY that suffix. Slicing at the first colon truncates commands that
  // legitimately contain colons — a URL in `Bash(curl https://x/install.sh |
  // sh)` became `curl https`, so the remote-exec pattern never matched and the
  // guard was falsely reported missing.
  if (cmd.endsWith(":*")) cmd = cmd.slice(0, -2);
  return DANGEROUS_CMD_RE.test(cmd);
}

/** Compile a Claude Code PostToolUse matcher into { catchAll, re }. Claude Code
 *  interprets the matcher field as a REGEX tested against the tool name. An
 *  empty matcher is a catch-all (fires on every tool); a /pattern/flags literal
 *  is unwrapped; an unparseable pattern returns null so callers fall back
 *  safely. Extracted so detection, merge, and the broad-matcher check share one
 *  compilation path instead of each reopening the regex. */
function compileMatcher(matcher) {
  let m = String(matcher ?? "").trim();
  if (m === "") return { catchAll: true, re: null };
  let flags = "";
  const delimited = m.match(/^\/(.+)\/([a-z]*)$/);
  if (delimited) {
    m = delimited[1];
    flags = delimited[2];
  }
  try {
    return { catchAll: false, re: new RegExp(m, flags) };
  } catch {
    return null;
  }
}

/** Classify a matcher by whether it fires on the Edit and Write tools. Compiled
 *  and tested against "Edit" and "Write" rather than split on "|" and compared
 *  as bare fragments, so anchored (`^(Edit|Write)$`) and delimited
 *  (`/Edit|Write/i`) forms are honored exactly like the bare alternation
 *  (`Edit|Write`) the scaffold emits. Returns "catch-all" (empty matcher, fires
 *  on every tool), "both" (non-empty regex matching Edit AND Write), or "no".
 *
 *  NotebookEdit|Write still does NOT cover Edit: as a regex, `NotebookEdit` is
 *  not a substring of the tool name "Edit", so the test fails — exact tool-name
 *  semantics are preserved. An unparseable regex falls back to "no" so detection
 *  never falsely PASSES. */
function matcherCoverage(matcher) {
  const compiled = compileMatcher(matcher);
  if (!compiled) return "no";
  if (compiled.catchAll) return "catch-all";
  return compiled.re.test("Edit") && compiled.re.test("Write") ? "both" : "no";
}

/** True when a compiled matcher fires on a given tool name (a catch-all fires
 *  on every tool). Used to tell whether a matcher that covers Edit+Write is
 *  BROADER than edits — e.g. `.*` or `Edit|Write|Read` also fire on Read. */
function matcherFiresOn(matcher, toolName) {
  const compiled = compileMatcher(matcher);
  if (!compiled) return false;
  if (compiled.catchAll) return true;
  return compiled.re.test(toolName);
}

/** True when a PostToolUse matcher fires on BOTH Edit and Write. Used by
 *  DETECTION: a catch-all (empty) matcher covers everything, so it honors a
 *  no-explicit-matcher lint+format setup rather than skipping it. */
function matcherCoversEditWrite(matcher) {
  const c = matcherCoverage(matcher);
  return c === "catch-all" || c === "both";
}

/** Tools a formatter/linter hook must NOT run after. Read carries a file_path
 *  but formatting on every read mutates the working tree needlessly; the others
 *  (Bash, Glob, Grep, Task) carry NO edited file_path, so an appended
 *  prettier/eslint hook misfires on the literal `{}` arg. Used to reject merge
 *  targets that cover edits but also fire on these. */
const NON_EDIT_TOOLS = ["Read", "Bash", "Glob", "Grep", "Task"];

/** True only for a NON-catch-all matcher scoped to edits — fires on both Edit
 *  and Write AND on nothing else. Used by MERGE: we append formatter hooks to
 *  an existing entry only when it is scoped to edits. Appending to a catch-all
 *  OR a broader matcher (`.*`, `Edit|Write|Read`, `Edit|Write|Bash`) would make
 *  prettier/eslint run after a non-edit tool — Read mutates the tree on every
 *  file read, and Bash/Glob/Grep/Task payloads carry no file_path so the hook
 *  fails on `{`. Such entries are preserved untouched and a separate Edit|Write
 *  entry is added instead. Detection (matcherCoversEditWrite) stays lenient — a
 *  broad matcher still COVERS edits — only the MERGE needs the stricter scope. */
function matcherIsEditWriteEntry(matcher) {
  if (matcherCoverage(matcher) !== "both") return false;
  return !NON_EDIT_TOOLS.some((tool) => matcherFiresOn(matcher, tool));
}

/** Shared classification of a PostToolUse command's formatter purpose. Detection
 *  (detectHooksConfig) and merging (mergeHooksSettings) MUST agree on what counts
 *  as "lint" / "format": if a command already satisfies detection, the merge must
 *  not append a scaffolded command of the same purpose (or every edit runs the
 *  formatter and linter twice). Defined once here so the two stay in lockstep. */
// Word-bounded so "lint"/"format" must appear as a whole word (the tool name),
// not as a substring of an unrelated token. Without boundaries, a hook whose
// command merely echoes a status string (e.g. `echo 'lint and format done'`)
// would be misread as a real linter/formatter and init/evolve would wrongly
// report the agent-hooks check as PASS, skipping the scaffold.
const LINT_CMD_RE = /\beslint\b|\blint\b/i;
const FORMAT_CMD_RE = /\bprettier\b|\bformat\b|\bfmt\b/i;
// A formatter in CHECK mode reports drift but does not rewrite the file, so it
// does not satisfy the "format-on-save" promise the Agent-hooks check advertises.
// `:check` covers script names like `npm run format:check`. FORMAT_WRITE_RE
// distinguishes `--write` (rewrite) from `--no-write` (the --write regex needs a
// double dash, which is NOT present in the single-dash `--no-write`).
const FORMAT_CHECK_RE = /(?:--check|--list-different|--no-write|:check)\b/;
const FORMAT_WRITE_RE = /(?:--write|--fix)\b/;
// A package-manager script invocation (`npm/pnpm/yarn/bun [run] <script>`) hides
// the script body, so the script NAME is captured (group 1) and resolved against
// the merged package.json scripts map in commandPurposes: `npm run format` whose
// body is `prettier --check .` is check-only and must NOT credit format-on-save,
// even though the invocation line shows no check flag. Only when the body is
// unknown (script absent from every package.json we saw) do we fall back to the
// opaque-trust heuristic below. A DIRECT prettier call is different: prettier
// prints to stdout by default and only rewrites in place with --write/-w, so a
// bare `prettier {}` does NOT satisfy format-on-save and must not false-PASS.
// `npx`/`bunx` are NOT matched here — they execute the binary directly, so a
// flag-less `npx prettier {}` is still a direct (non-writing) call. The same is
// true of the PM direct-execution subcommands `exec` (`npm/pnpm/yarn exec
// prettier`) and `dlx` (`bun dlx prettier`): they run the binary transparently,
// so a flag-less `yarn exec prettier {}` is direct, NOT an opaque script. The
// negative lookahead excludes those subcommands so the script-resolution branch
// only fires for genuine `[run] <script>` invocations. `([^\s]+)` captures the
// first token as the script name (flags like `--silent` that follow are ignored).
const PM_SCRIPT_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?!exec\b|dlx\b)([^\s]+)/;
// `-w` is prettier's short write flag. Matched as a standalone token (bounded by
// whitespace or string end) so it does NOT fire inside `--no-write`, whose `-w`
// sits mid-token after `o` (no preceding boundary).
const SHORT_WRITE_FLAG_RE = /(?:^|\s)-w(?=\s|$)/;

/** Resolve a package-manager script invocation to its terminal body from the
 *  merged scripts map (root + nested package.json scripts). `npm run format` ->
 *  the body of the "format" script. Follows a chain when the body is itself a
 *  PM script (`"format": "npm run _fmt"`, `"_fmt": "prettier --write ."`) and
 *  stops at the first body that is NOT a PM-script invocation, so a check-only
 *  flag buried one indirection down is still seen. A `seen` set guards against
 *  cycles (`"a": "npm run b"`, `"b": "npm run a"`). Returns null when the script
 *  name is absent from the map (body opaque/unknown) — callers then fall back to
 *  the opaque-trust heuristic rather than guessing.
 *
 *  When the invocation carries a `-w`/`--workspace <name>` selector, the body is
 *  resolved from THAT package's scripts (`workspaceScripts[name]`) instead of the
 *  flat merged map: the flat value is last-write-wins across packages, so without
 *  scoping a workspace that runs `prettier --check` is misread as another
 *  workspace's `prettier --write` and falsely credited as format-on-save. The
 *  scope carries through the chain (a workspace's `format` -> its own `_fmt`),
 *  and a selector whose package is absent from the map falls back to the flat map
 *  rather than guessing. */
function resolveScriptBody(invocation, scripts, seen, workspaceScripts) {
  const s = String(invocation || "");
  const m = PM_SCRIPT_RE.exec(s);
  if (!m) return null;
  const name = m[1];
  if (!name || seen.has(name)) return null;
  // `-w`/`--workspace` are npm/pnpm/yarn's package selector (documented in
  // `npm run --help`); `[ =]` covers the space and `=` spellings. Bounded by
  // whitespace so it does not fire mid-token, and `-w` alone (no value) leaves
  // wsName undefined -> flat fallback.
  const ws = s.match(/(?:^|\s)(?:--workspace|-w)[ =](\S+)/);
  const wsName = ws && ws[1];
  const scope = wsName && workspaceScripts && workspaceScripts[wsName]
    ? workspaceScripts[wsName]
    : scripts;
  const body = scope ? scope[name] : undefined;
  if (typeof body !== "string" || body.trim() === "") return null;
  seen.add(name);
  return PM_SCRIPT_RE.test(body) ? resolveScriptBody(body, scope, seen, workspaceScripts) : body;
}

function commandPurposes(cmd, scripts, workspaceScripts) {
  let c = String(cmd || "");
  // Drop the FULL argument list of echo/printf — status text such as
  // 'lint and format complete' OR unquoted `echo lint && echo format`. Their
  // words must not masquerade as tool invocations. A single pass consumes any
  // mix of quoted and unquoted args, stopping at the next shell operator
  // (&&, ||, ;, |, >) or end of string, so it also strips a bare `echo lint`
  // that the quoted-only replacements missed (the bare word "lint" then matched
  // LINT_CMD_RE and false-PASSed the Agent-hooks check).
  c = c.replace(
    /\b(?:echo|printf)\b(?:(?:\s+(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|[^;&|>\s]+))*)/g,
    " "
  );
  // For OTHER quoted strings — typically a script passed to a shell wrapper like
  // `bash -lc "npm run lint && npm run format"` — the quoted CONTENT is real
  // commands, so strip only the quote characters (keep the content) for scanning
  // rather than discarding it.
  c = c.replace(/['"]/g, " ");
  // Return ALL matched purposes, not just the first: a combined command such as
  // `npm run lint && npm run format` performs both jobs, so both flags must be
  // set. Returning a single value left format undetected, and init/evolve then
  // appended a redundant prettier hook that ran the formatter twice per edit.
  const purposes = [];
  if (LINT_CMD_RE.test(c)) purposes.push("lint");
  // Determine the format purpose from the FORMATTER segment(s) only. A combined
  // command such as `eslint --fix . && prettier --check .` attaches --fix to the
  // LINTER; testing FORMAT_WRITE_RE against the whole string saw eslint's --fix
  // and treated prettier --check as write-enabled, false-PASSing the Agent-hooks
  // check (Prettier never rewrote the file). Split on shell conjunctions and
  // inspect each formatter segment's OWN flags: format counts when at least one
  // formatter segment is not check-only.
  const segments = c.split(/\s*(?:&&|\|\||\||;)\s*/);
  const formatSatisfied = segments.some((seg) => {
    if (!FORMAT_CMD_RE.test(seg)) return false;
    if (PM_SCRIPT_RE.test(seg)) {
      // Package-manager script invocation (`npm/pnpm/yarn/bun [run] <script>`).
      // Resolve the script BODY from the merged package.json scripts map and
      // classify THAT: `npm run format` whose body is `prettier --check .` is
      // check-only (prettier --check reports drift but never rewrites), so it must
      // NOT credit format-on-save — even though the invocation line carries no
      // check flag. Only when the body is unknown (script absent from every
      // package.json we saw) do we fall back to the opaque-trust heuristic: trust
      // it writes unless the invocation line itself signals check-only by name
      // (`format:check`) or flag. The body is classified recursively so a script
      // that chains to prettier --write (or --check) is followed all the way down.
      const body = resolveScriptBody(seg, scripts || {}, new Set(), workspaceScripts);
      if (body != null) return commandPurposes(body, scripts, workspaceScripts).includes("format");
      return !(FORMAT_CHECK_RE.test(seg) && !FORMAT_WRITE_RE.test(seg));
    }
    // Direct binary call: require an explicit write flag. prettier writes to
    // stdout by default, so a flag-less `prettier {}` leaves the file untouched
    // and must not satisfy the format-on-save promise.
    return FORMAT_WRITE_RE.test(seg) || SHORT_WRITE_FLAG_RE.test(seg);
  });
  if (formatSatisfied) purposes.push("format");
  return purposes;
}

/** Detect Claude Code hooks + permission-guard config for the PRIMARY project
 *  root (roots[0], where Claude runs and where init/evolve scaffold settings).
 *  PostToolUse(Edit|Write)->lint+format stops style drift at edit time; a
 *  non-empty permissions.deny blocks irreversible commands. Both are the
 *  highest-leverage agent safety nets after tests/CI.
 *
 *  Coverage is evaluated for the PRIMARY root only, NOT accumulated across every
 *  git-submodule root: a lint hook in the primary and a format hook in a
 *  submodule are two INCOMPLETE setups, not one complete one. Accumulating the
 *  flags globally would merge that split coverage into a false PASS and — because
 *  claudeHooksSettings() also reads these flags — return null so init/evolve
 *  could not repair either half. Scoping to the primary keeps the check honest
 *  (split coverage reports MISS) and the repair working (the missing purpose is
 *  scaffolded at the primary). */
function detectHooksConfig(roots, scripts, workspaceScripts) {
  const primary = roots?.[0];
  const settings = primary ? readJson(path.join(primary, ".claude", "settings.json")) : null;
  const local = primary ? readJson(path.join(primary, ".claude", "settings.local.json")) : null;
  let postToolUseLint = false;
  let postToolUseFormat = false;
  let permissionsDeny = false;
  // PostToolUse hooks and permissions.deny may each live in the shared
  // settings.json OR the gitignored settings.local.json — both are supported
  // Claude settings locations. Inspect both for hooks (as we already do for
  // deny) so a project keeping its hooks in settings.local.json isn't falsely
  // reported as missing Agent hooks and handed redundant init/evolve output.
  for (const file of [settings, local]) {
    const postTool = file?.hooks?.PostToolUse;
    const entries = Array.isArray(postTool) ? postTool : postTool ? [postTool] : [];
    for (const entry of entries) {
      // The matcher must cover BOTH Edit and Write. matcherCoversEditWrite
      // treats an empty matcher as a catch-all (it fires on every tool), so a
      // valid lint+format setup with no explicit matcher is honored rather
      // than skipped — which would falsely report Agent hooks as MISS.
      if (!matcherCoversEditWrite(entry?.matcher)) continue;
      // Classify each hook command individually (not the joined blob): a single
      // wide matcher entry may carry a lint hook AND a format hook, and a
      // quoted status echo inside one command must not flip the other purpose.
      for (const h of entry.hooks || []) {
        for (const purpose of commandPurposes(h?.command, scripts, workspaceScripts)) {
          if (purpose === "lint") postToolUseLint = true;
          else if (purpose === "format") postToolUseFormat = true;
        }
      }
    }
  }
  for (const denyList of [settings?.permissions?.deny, local?.permissions?.deny]) {
    if (Array.isArray(denyList) && denyList.some((d) => denyEntryBlocksDangerousCommand(d))) {
      permissionsDeny = true;
    }
  }
  return { postToolUseLint, postToolUseFormat, permissionsDeny };
}

/** A user-authored Claude skill: a path under .claude/skills/ that names a
 *  skill OTHER than `project-evolution` (the ONE skill `evolve --write`
 *  scaffolds for every stack, not gated on Claude detection). Requires at least
 *  one path segment after .claude/skills/ so the bare directory entry that the
 *  generated skill creates does not itself flip detection — otherwise a
 *  freshly-evolved non-Claude baseline would be misread as a Claude project and
 *  fail its own (absent) hook checks on the next scan, the same regression
 *  `.claude/commands/` already guards against. */
function isUserAuthoredSkillPath(f) {
  return /(?:^|\/)\.claude\/skills\/(?!project-evolution(?:\/|$))[^/]+/.test(f);
}

/** A project is "Claude Code" when it ships CLAUDE.md, a .claude/settings*.json
 *  file, or user-authored Claude Code extensions (.claude/agents/, .claude/skills/)
 *  ANYWHERE in the tree — including an npm workspace member such as
 *  apps/web/CLAUDE.md, which is the sole Claude config in many monorepos. We scan
 *  the full file inventory (not just roots[0] + git submodules) so a member-only
 *  Claude setup still makes the hooks + deny-list checks applicable.
 *
 *  `vca init` writes .claude/commands/ for any stack and `evolve` writes a single
 *  project-evolution skill, so those generated artifacts are excluded: counting
 *  them would make a fresh non-Claude baseline fail its own newly-added hook
 *  checks on the next scan. .claude/agents/ is never generated and any
 *  .claude/skills/ entry besides project-evolution is user-authored, so both
 *  remain reliable signals. */
function isClaudeCodeProject(allFiles) {
  for (const f of allFiles) {
    if (f === "CLAUDE.md" || f.endsWith("/CLAUDE.md")) return true;
    if (f === ".claude/settings.json" || f.endsWith("/.claude/settings.json")) return true;
    if (f === ".claude/settings.local.json" || f.endsWith("/.claude/settings.local.json")) return true;
    if (f.startsWith(".claude/agents/") || f.includes("/.claude/agents/")) return true;
    if (isUserAuthoredSkillPath(f)) return true;
  }
  return false;
}

/** Detect whether the project declares prettier + eslint as dependencies, so we
 *  only scaffold Node edit-time hooks where they can actually run. Without this
 *  gate, a Python/Go/Rust Claude project would invoke undeclared prettier/eslint
 *  (via npx) on every Edit/Write. */
function hasNodeFormatters(packageJson) {
  const deps = { ...packageJson?.dependencies, ...packageJson?.devDependencies };
  return Boolean(deps?.prettier) && Boolean(deps?.eslint);
}

/** Resolve the npm workspace `packages` globs (array form or
 *  `{ packages: [...] }`) from a root manifest. Returns [] when the root is not
 *  a workspace root. */
function workspacePatterns(pkg) {
  const w = pkg?.workspaces;
  if (Array.isArray(w)) return w;
  if (w && Array.isArray(w.packages)) return w.packages;
  return [];
}

/** Immediate subdirectories of `dir`, skipping node_modules/.git. */
function listChildDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !["node_modules", ".git"].includes(e.name))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

/** `dir` itself plus every descendant directory (BFS), skipping node_modules/.git.
 *  Used to expand `**` in workspace globs. */
function listAllDirs(dir) {
  const out = [dir];
  for (let i = 0; i < out.length; i++) out.push(...listChildDirs(out[i]));
  return out;
}

/** Convert a single workspace-glob segment (no slash) into an anchored regex
 *  where a star matches any run of non-slash characters. Regex metacharacters
 *  are escaped first so literal dots and plus signs stay literal; only the star
 *  is special. This lets a partial-wildcard segment such as `*-app` match only
 *  members with that suffix, instead of every child of the parent directory. */
function globSegmentToRegex(seg) {
  const body = seg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${body}$`);
}

/** Resolve a workspace glob against `root` to the concrete member directories it
 *  matches. A segment is a literal directory name, a single star (one level), a
 *  double star (zero or more levels, recursive), or a partial wildcard that
 *  mixes a star with a literal prefix or suffix (e.g. `pkg-*` or `*-app`). A
 *  starred segment that is not a double star is compiled to a per-segment regex
 *  via globSegmentToRegex and tested against each child name, so siblings that
 *  do not match the partial wildcard are excluded rather than over-matched. */
function resolveWorkspacePattern(root, pattern) {
  const segs = String(pattern ?? "").split("/").map((s) => s.trim()).filter(Boolean);
  let dirs = [root];
  for (const seg of segs) {
    const next = [];
    if (seg === "**") {
      for (const d of dirs) next.push(...listAllDirs(d));
    } else if (seg.includes("*")) {
      const segRe = globSegmentToRegex(seg);
      for (const d of dirs) {
        for (const child of listChildDirs(d)) {
          if (segRe.test(path.basename(child))) next.push(child);
        }
      }
    } else {
      for (const d of dirs) {
        const child = path.join(d, seg);
        try {
          if (fs.statSync(child).isDirectory()) next.push(child);
        } catch {
          /* segment doesn't exist */
        }
      }
    }
    dirs = next;
    if (dirs.length === 0) break;
  }
  return dirs;
}

/** Read the manifests of npm workspace members under `root` by resolving each
 *  workspace pattern (literal path, `*`, or `**`) to its concrete directories and
 *  reading each one's package.json. Members without a manifest are skipped. */
function readWorkspaceMemberPackages(root, pkg) {
  const members = [];
  for (const pat of workspacePatterns(pkg)) {
    const p = String(pat ?? "").trim();
    if (!p) continue;
    for (const dir of resolveWorkspacePattern(root, p)) {
      const memberPkg = readJson(path.join(dir, "package.json"));
      if (memberPkg) members.push(memberPkg);
    }
  }
  return members;
}

/** True when `cwd` is governed by Yarn Berry (v2+). Berry's default Plug'n'Play
 *  linker resolves binaries through the root workspace's own dependency store:
 *  `yarn exec <tool>` run from the repository root finds only deps the root
 *  workspace declares, NOT deps that live in a member package, so a member-only
 *  prettier/eslint exits 127 there (it only resolves inside its owning
 *  workspace). We detect Berry two ways: a `.yarnrc.yml` file anywhere up the
 *  tree (Berry's config file, absent in Classic), or an explicit `packageManager`
 *  field pinning yarn >= 2. Yarn Classic (v1) has neither — it hoists member deps
 *  into the root node_modules, so `yarn exec` at the root DOES resolve them and
 *  members are still counted. */
function isYarnBerry(cwd, packageJson) {
  if (packageJson?.packageManager) {
    const m = String(packageJson.packageManager).match(/^yarn@(\d+)/);
    if (m && Number(m[1]) >= 2) return true;
  }
  let dir = cwd;
  while (true) {
    try {
      if (fs.existsSync(path.join(dir, ".yarnrc.yml"))) return true;
    } catch {
      /* ignore fs errors */
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

/** Hooks are scaffolded at the PRIMARY root (roots[0], where settings.json is
 *  written) and run the package-manager executor from there, so only formatters
 *  RESOLVABLE from that root count: its own manifest plus its npm workspace
 *  members. npm hoists member deps into the primary node_modules, so `npx` at the
 *  primary resolves them. pnpm does NOT hoist by default (a member keeps its own
 *  node_modules), and Yarn Berry (Plug'n'Play) resolves only deps the root
 *  workspace declares — in both, a member-only prettier/eslint is invisible to
 *  `pnpm exec` / `yarn exec` run from the primary, and the scaffolded hook would
 *  fail with "command not found" on every edit. For pnpm and Yarn Berry we
 *  therefore skip workspace members exactly like a git submodule; run vca from
 *  inside the member instead. Yarn Classic (v1) hoists member deps into the root
 *  node_modules, so its members remain root-resolvable and are still counted. */
function hasNodeFormattersAnywhere(roots) {
  const primary = roots?.[0];
  if (!primary) return false;
  const pkg = readJson(path.join(primary, "package.json"));
  if (hasNodeFormatters(pkg)) return true;
  // pnpm and Yarn Berry don't expose workspace-member binaries to the executor
  // run from the primary root: pnpm keeps a per-member node_modules, and Yarn
  // Berry Plug'n'Play resolves only root-declared deps at the root (a
  // member-only prettier/eslint returns 127 from `yarn exec` there). Both skip
  // workspace members here. Yarn Classic (v1) hoists, so it still counts.
  const pm = detectPackageManager(primary, pkg);
  if (pm === "pnpm") return false;
  if (pm === "yarn" && isYarnBerry(primary, pkg)) return false;
  // npm (and Yarn Classic) hoist member deps into the primary node_modules, so
  // `npx` at the primary resolves them regardless of which manifest declares
  // them. Aggregate dependency names across the root and every member, then
  // require both tools in the union: checking each manifest individually with
  // hasNodeFormatters misses the split case (prettier in the root + eslint in a
  // member, or split across members), wrongly marking hooks N/A.
  const depNames = new Set();
  const collectDeps = (p) => {
    const deps = { ...p?.dependencies, ...p?.devDependencies };
    for (const name of Object.keys(deps || {})) depNames.add(name);
  };
  collectDeps(pkg);
  for (const memberPkg of readWorkspaceMemberPackages(primary, pkg)) collectDeps(memberPkg);
  return depNames.has("prettier") && depNames.has("eslint");
}

/** DB projects get extra deny guards (DROP/TRUNCATE) since those are
 *  irreversible in any stack with a database. Detected from migrations,
 *  ORM configs, or package deps. */
function isDbProject(report) {
  const files = [...report.files];
  const paths = files.join("\n").toLowerCase();
  const dbFileSignals = ["prisma/schema", "drizzle", "knexfile", "migrations/", "schema.sql"];
  if (dbFileSignals.some((sig) => paths.includes(sig))) return true;
  // A `supabase/` directory at the project root OR nested signals a Supabase
  // project (config.toml, migrations, functions). The bare `/supabase/` substring
  // matched only NESTED paths — a root-level `supabase/config.toml` carries no
  // leading slash, so a fresh Supabase repo with no migrations/ORM deps yet was
  // misread as non-database and the SQL deny guards were omitted. Match the path
  // segment anchored at a path boundary so it does not false-positive on
  // `mysupabase/` (a loose `supabase/` substring would).
  if (files.some((f) => { const lf = f.toLowerCase(); return lf.startsWith("supabase/") || lf.includes("/supabase/"); })) return true;
  // Match the STANDARD published package names. The old keys (`drizzle`,
  // `prisma`) were nonstandard: `drizzle` is not a real package (the ORM is
  // `drizzle-orm`), and a project depending on `@prisma/client` alone (no `prisma`
  // CLI devDep) was misclassified as non-database and skipped the SQL guards.
  const DB_DEP_NAMES = [
    "prisma", "@prisma/client", // Prisma: CLI devDep + runtime client
    "drizzle-orm", "drizzle-kit", // Drizzle: ORM + migration toolkit
    "knex", "typeorm", "sequelize", // SQL query builders / ORMs
  ];
  const hasDbDep = (pkg) => {
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
    return Object.keys(deps).some((name) => DB_DEP_NAMES.includes(name));
  };
  if (hasDbDep(report.packageJson)) return true;
  // A monorepo may declare the DB dep only in a workspace member (e.g.
  // `packages/api` → `@prisma/client`). report.packageJson is the ROOT manifest
  // only; without scanning members, a DB project with no schema/migration file
  // yet was missed and the SQL deny guards were omitted. (Unlike formatter hooks,
  // deny guards are permission patterns — they apply regardless of whether the
  // member's binaries resolve from the primary root.)
  const primary = report.roots?.[0];
  if (primary) {
    for (const memberPkg of readWorkspaceMemberPackages(primary, report.packageJson)) {
      if (hasDbDep(memberPkg)) return true;
    }
  }
  return false;
}

/** Default irreversible-command deny list, generalized from production rules.
 *  Bash(...) patterns follow Claude Code permission syntax. */
function defaultDenyList(report) {
  const deny = [
    // rm with a recursive flag is irreversible whether or not -f is present
    // (force only suppresses the prompt), so block EVERY recursive form.
    // Claude Code deny patterns are literal-prefix + `*`-glob with NO regex, so
    // clustered (`-rf`), whitespace-separated (`-r -f`), and recursive-first vs
    // force-first orderings each need their own entry: `rm -rf X` does not start
    // with the literal `rm -r ` (no space before the f), and `rm -f -r X` does
    // not start with `rm -r `. Enumerating the common forms keeps the guard from
    // being bypassed by simply separating or reordering the flags.
    "Bash(rm -rf:*)",
    "Bash(rm -fr:*)",
    "Bash(rm -Rf:*)",
    "Bash(rm -r *)",
    "Bash(rm -R *)",
    "Bash(rm --recursive *)",
    "Bash(rm -f -r *)",
    "Bash(rm -f -R *)",
    "Bash(rm --force --recursive *)",
    "Bash(rm --force -r *)",
    "Bash(rm -r /)",
    // Recursive rm clustered with a NON-force flag — verbose (-v), interactive
    // (-i/-I), or directory (-d) — is equally irreversible but slips past
    // `Bash(rm -r *)` (which needs a space right after -r) and the force-only
    // clusters above. `rm -rv target` / `rm -rI target` are ordinary spellings.
    // Each common 2-flag cluster needs its own literal entry (both -r and -R,
    // both flag orders) since Claude Code matches the exact cluster. The regex
    // detector covers the full flag alphabet; this list covers the clusters
    // people actually type (3+ flag clusters like -rfv are still missed — a
    // Claude Code literal-matching limitation, not a detection gap).
    "Bash(rm -rv:*)", "Bash(rm -vr:*)", "Bash(rm -Rv:*)", "Bash(rm -vR:*)",
    "Bash(rm -ri:*)", "Bash(rm -ir:*)", "Bash(rm -rI:*)", "Bash(rm -Ir:*)",
    "Bash(rm -rd:*)", "Bash(rm -dr:*)", "Bash(rm -Rd:*)", "Bash(rm -dR:*)",
    // Force + capital-recursive reorder, completing the -rf/-fr/-Rf set above.
    "Bash(rm -fR:*)",
    "Bash(git push --force:*)",
    "Bash(git push -f:*)",
    // A lone star in a Claude Code Bash pattern spans multiple arguments, so
    // these catch a force flag placed AFTER the refspec — e.g. `git push origin
    // main --force` — which the prefix-only colon-star entries above miss (those
    // only match when the flag comes first). Git accepts the trailing placement.
    "Bash(git push * --force)",
    "Bash(git push * -f)",
    "Bash(git reset --hard:*)",
    // Git accepts the revision BEFORE the mode (`git reset HEAD~1 --hard`), which
    // does not start with the `git reset --hard` prefix above and so bypasses it
    // while still discarding index and working-tree changes. A lone `*` spans the
    // revision — the same mechanism `git push * --force` uses for a flag placed
    // after the refspec — so this catches `--hard` in either position.
    "Bash(git reset * --hard:*)",
    // git clean needs only -f to delete untracked files irreversibly (git refuses
    // without it; -d merely adds directories). Claude Code prefix-matches the
    // LITERAL spelling, so every force spelling must be scaffolded — `git clean
    // -f` (plain) is destructive on its own and was missing, leaving the analyzer
    // reporting protection the deny list did not actually provide.
    "Bash(git clean -f:*)",
    "Bash(git clean -fd:*)",
    "Bash(git clean -df:*)",
    "Bash(git clean --force:*)",
    "Bash(sudo rm:*)",
    "Bash(mkfs:*)",
    "Bash(dd of=/dev/:*)",
    // dd may carry an `if=` (or other operands) BEFORE `of=`, e.g.
    // `dd if=/dev/zero of=/dev/sda`, which does not start with `dd of=/dev/` and
    // so bypasses the prefix entry above. A lone `*` spans the leading operands
    // (same mechanism as `git push * --force`), blocking the device write
    // regardless of argument order. `if=` alone is a non-destructive read and is
    // intentionally NOT blocked.
    "Bash(dd * of=/dev/:*)",
    "Bash(> /dev/sd:*)",
    "Bash(:> *)",
    "Bash(curl * | sh)",
    "Bash(curl * | bash)",
    "Bash(wget * | sh)",
    "Bash(wget * | bash)",
  ];
  if (isDbProject(report)) {
    deny.push(
      "Bash(DROP TABLE:*)",
      "Bash(DROP DATABASE:*)",
      "Bash(TRUNCATE TABLE:*)",
      // SQL reaches the DB through a client / migration tool, not as a bare
      // command. psql -c / -f and mysql -e run arbitrary SQL; prisma migrate
      // reset drops & recreates the dev database irreversibly.
      "Bash(psql -c:*)",
      "Bash(psql -f:*)",
      "Bash(mysql -e:*)",
      // An execute flag placed AFTER connection options — `psql -d prod -c
      // 'DROP TABLE users'`, `mysql -h host -e 'TRUNCATE TABLE users'` — is
      // NOT caught by the prefix-only entries above: Claude Code matches
      // `Bash(psql -c:*)` as a literal prefix, so a -c/-f/-e that follows
      // -d/-h/-U/-p/etc. slips past the guard, yet detection still reports
      // the guard installed (the detector regex allows the flag anywhere, so
      // the existing entry already satisfies it). A lone `*` spans the
      // preceding arguments — the same mechanism `git push * --force` uses to
      // catch a flag placed after the refspec — so these catch the execute
      // flag in either position (flag-first OR flag-after-options).
      "Bash(psql * -c:*)",
      "Bash(psql * -f:*)",
      "Bash(mysql * -e:*)",
      "Bash(prisma migrate reset:*)",
      "Bash(npx prisma migrate reset:*)",
    );
  }
  return deny;
}

/** Read the edited file path from the hook's stdin JSON payload using the Node
 *  runtime — guaranteed present because prettier/eslint are npm deps — instead
 *  of the external `jq` executable, which minimal CI/dev images may not ship and
 *  which is not a declared prerequisite of this package.
 *
 *  The path is emitted **NUL-delimited** and consumed with `xargs -0 -I{}`.
 *  Plain `xargs -I{}` (newline-delimited) performs shell-style quote and
 *  backslash processing on its input: a path containing `'` aborts with
 *  "unterminated quote" and a `\` is silently stripped. `-0` switches the
 *  delimiter to NUL and disables that processing, so `docs/it's a\b.md` survives
 *  byte-for-byte. We emit the NUL ourselves (rather than relying on a trailing
 *  newline) because `console.log` would append `\n`, which `-0` treats as part
 *  of the argument. `String.fromCharCode(0)` avoids any backslash ambiguity in
 *  the embedded JS source. */
const HOOK_READ_PATH = `node -e "const f=JSON.parse(require('fs').readFileSync(0,'utf8')).tool_input?.file_path;if(f)process.stdout.write(f+String.fromCharCode(0))"`;

/** Map the detected package manager to the executor that runs a LOCAL binary
 *  declared in dependencies. Yarn Plug'n'Play exposes prettier/eslint through
 *  Yarn (no node_modules/.bin), pnpm via `pnpm exec`, bun via `bunx`; only npm
 *  uses `npx`. Hard-coding `npx` would fail (or fetch an unpinned remote copy)
 *  on every edit in non-npm projects. */
function packageManagerExecutor(pm) {
  switch (pm) {
    case "pnpm": return "pnpm exec";
    case "yarn": return "yarn exec";
    case "bun": return "bunx";
    default: return "npx";
  }
}

/** Claude Code settings.json with PostToolUse(Edit|Write) -> prettier + eslint.
 *  Format-on-save + lint-on-edit are the cheapest computational sensors.
 *  Returns null (no scaffold) when: (a) prettier/eslint aren't declared deps,
 *  so we never scaffold Node hooks that would fail on every edit in a non-Node
 *  stack; or (b) Edit/Write lint+format hooks are already wired in either
 *  settings file — Claude loads hooks from both, so emitting a second set would
 *  run the tools twice. Only the MISSING purpose(s) are emitted: if, say, eslint
 *  is already wired in settings.local.json but prettier is not, the scaffold
 *  emits only prettier — re-emitting eslint here would make Claude run it twice
 *  on every edit (once from each settings file). The executor follows the
 *  detected package manager so the hook resolves the project's own binaries
 *  (yarn/pnpm/bun, not just npx). `--ignore-unknown` keeps prettier from erroring
 *  on edits to file types it has no parser for (custom config extensions,
 *  lockfiles, …); eslint already exits cleanly on unmatched files via
 *  `--no-warn-ignored`. When both purposes are missing they are emitted as a
 *  SINGLE sequential command (prettier && eslint) because Claude Code runs
 *  matching hooks in parallel; eslint is gated to exit 2 + stderr so the model
 *  actually sees the violation (see the inline comment below). */
function claudeHooksSettings(report) {
  const roots = report.roots;
  if (!hasNodeFormattersAnywhere(roots)) return null;
  const { postToolUseLint, postToolUseFormat } = detectHooksConfig(roots, report.scripts, report.workspaceScripts);
  if (postToolUseLint && postToolUseFormat) return null;
  const exec = packageManagerExecutor(detectPackageManager(report.cwd, report.packageJson));
  // Emit only the formatter purpose(s) not already satisfied in EITHER settings
  // file. Claude loads PostToolUse hooks from settings.json AND settings.local.json,
  // so a freshly-created settings.json that re-emits a purpose already covered in
  // settings.local.json would run that tool twice on every edit.
  //
  // Claude Code runs ALL matching PostToolUse hooks in PARALLEL, so when BOTH
  // purposes are missing prettier and eslint must share ONE command — emitting
  // two separate hooks lets eslint lint the file BEFORE prettier has rewritten it
  // (a TOCTOU race: eslint flags exactly the style prettier would have just
  // fixed). `sh -c '...prettier "$1" && eslint "$1"...' _ {}` runs prettier first
  // and only lints the formatted result. `sh` is a system binary, never prefixed
  // with the package-manager executor (npx/yarn exec resolve npm packages, which
  // `sh` is not); only the inner prettier/eslint calls take `${exec}`.
  //
  // ESLint is the gate that should BLOCK: Claude Code only feeds a hook's output
  // back to the model on exit code 2 (a non-2 non-zero code is shown to the user
  // but never reaches the agent), so eslint exits 1 on violations yet the hook
  // would silently fail to teach the agent about the lint error it just
  // introduced. `|| exit 2` promotes any non-zero result (eslint violations, or a
  // prettier failure on a file it genuinely cannot parse despite
  // --ignore-unknown) to a blocking exit 2, and `1>&2` moves eslint's
  // diagnostics onto stderr (eslint writes to stdout by default; Claude Code
  // surfaces STDERR on exit 2). The prettier-ONLY branch (lint already wired
  // elsewhere) deliberately omits exit 2: prettier --write rarely fails and
  // blocking the agent on a benign formatter parse gap is worse than skipping it.
  // `"$1"` carries the path as a positional param: xargs -0 -I{} replaces {} with
  // the path as a SINGLE argv element (NUL-delimited, byte-for-byte), which
  // becomes $1 — so paths with spaces/apostrophes/backslashes are never
  // re-parsed by a shell.
  const hooks = [];
  if (!postToolUseFormat && !postToolUseLint) {
    hooks.push({ type: "command", command: `${HOOK_READ_PATH} | xargs -0 -I{} sh -c '${exec} prettier --write --ignore-unknown "$1" && ${exec} eslint --no-warn-ignored "$1" 1>&2' _ {} || exit 2` });
  } else if (!postToolUseFormat) {
    hooks.push({ type: "command", command: `${HOOK_READ_PATH} | xargs -0 -I{} ${exec} prettier --write --ignore-unknown {}` });
  } else if (!postToolUseLint) {
    hooks.push({ type: "command", command: `${HOOK_READ_PATH} | xargs -0 -I{} ${exec} eslint --no-warn-ignored {} 1>&2 || exit 2` });
  }
  const config = {
    hooks: {
      PostToolUse: [
        { matcher: "Edit|Write", hooks },
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
  // is tool-agnostic and valuable for any Claude project — but it is SKIPPED when
  // a dangerous-command guard is already detected in either settings file, so
  // init does not duplicate (or expand beyond) an existing committed guard.
  if (isClaudeCodeProject(report.files)) {
    const { permissionsDeny } = detectHooksConfig(report.roots);
    if (!permissionsDeny) {
      files.push(file(".claude/settings.local.json", claudePermissionsLocal(report), mergePermissionsLocal));
    }
    const hooksContent = claudeHooksSettings(report);
    if (hooksContent) files.push(file(".claude/settings.json", hooksContent, (existing, incoming) => mergeHooksSettings(existing, incoming, report.scripts, report.workspaceScripts)));
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
  // command advertises would be a no-op and the next scan would still MISS. The
  // deny list is skipped when a dangerous-command guard is already detected in
  // either settings file, so evolve does not duplicate or expand an existing one.
  if (isClaudeCodeProject(report.files)) {
    const { permissionsDeny } = detectHooksConfig(report.roots);
    if (!permissionsDeny) {
      files.push(file(".claude/settings.local.json", claudePermissionsLocal(report), mergePermissionsLocal));
    }
    const hooksContent = claudeHooksSettings(report);
    if (hooksContent) files.push(file(".claude/settings.json", hooksContent, (existing, incoming) => mergeHooksSettings(existing, incoming, report.scripts, report.workspaceScripts)));
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
function mergeHooksSettings(existingContent, incomingContent, scripts, workspaceScripts) {
  const existing = JSON.parse(existingContent);
  const incoming = JSON.parse(incomingContent);
  existing.hooks ??= {};
  existing.hooks.PostToolUse ??= [];
  for (const entry of incoming.hooks?.PostToolUse || []) {
    // Identify an existing entry whose matcher is scoped to Edit+Write
    // (`Write|Edit`, `Edit|Write|MultiEdit`) — NOT a catch-all — and merge into
    // it rather than appending a duplicate. The scaffold always emits
    // `Edit|Write`; exact comparison would miss a semantically-equivalent
    // matcher and append a duplicate (running the formatter twice). A catch-all
    // entry is deliberately excluded here: appending prettier/eslint to it would
    // also fire after Read and rewrite the working tree on every file read, so
    // a catch-all is preserved untouched and a separate Edit|Write entry is
    // pushed below instead.
    const idx = existing.hooks.PostToolUse.findIndex((e) => matcherIsEditWriteEntry(e.matcher));
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
      // Track which formatter purposes the entry already covers, so a scaffolded
      // command is skipped when a semantically-equivalent custom command already
      // satisfies it. Exact-string dedup alone would treat `prettier --write .`
      // as different from the scaffold's `npx prettier --write` and append it,
      // running the formatter and linter twice on every edit. Classification
      // mirrors detectHooksConfig (commandPurposes), so "already satisfies
      // detection" and "already merged" stay consistent.
      const coveredPurposes = new Set();
      for (const h of existingEntry.hooks) {
        for (const purpose of commandPurposes(h?.command, scripts, workspaceScripts)) coveredPurposes.add(purpose);
      }
      for (const h of entry.hooks || []) {
        if (!h?.command || knownCmds.has(h.command)) continue;
        // A combined command (e.g. `npm run lint && npm run format`) carries
        // multiple purposes; only skip it when EVERY purpose it serves is
        // already covered, otherwise an uncovered purpose would go unscaffolded.
        const purposes = commandPurposes(h.command, scripts, workspaceScripts);
        if (purposes.length && purposes.every((p) => coveredPurposes.has(p))) continue;
        existingEntry.hooks.push(h);
        knownCmds.add(h.command);
        for (const p of purposes) coveredPurposes.add(p);
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
