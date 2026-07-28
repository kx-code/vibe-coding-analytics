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
  const { flat: scripts, byName: workspaceScripts, byDir: dirScripts, all: allScripts } = collectAllScripts(cwd, allFiles);
  const shape = detectShape(cwd, packageJson);
  const untrackedHarness = untrackedHarnessFiles(cwd, allFiles);

  const fractalDocs =
    countBasename(allFiles, "CLAUDE.md") >= 2 || countBasename(allFiles, "AGENTS.md") >= 2;

  const numberedRules = countNumberedRules(roots);
  const ruleTrace = analyzeRuleTraceability(roots, allFiles, cwd);
  const hooks = detectHooksConfig(roots, scripts, workspaceScripts, dirScripts);
  const isClaude = isClaudeCodeProject(allFiles);
  const hasFormatters = hasNodeFormattersAnywhere(roots);
  // N/A semantics: a check that does not apply to this project should neither
  // count as a "missing area" nor earn score weight. We mark it `na` so the
  // scoring loop and printReport can exclude it (a check that is merely `ok`
  // but inapplicable would otherwise inflate the score — a perverse incentive).
  const hooksPresent = hooks.postToolUseLint && hooks.postToolUseFormat;
  const hooksNa = !isClaude || (!hasFormatters && !hooksPresent);
  const guardNa = !isClaude;
  // Entry-level completeness: every scaffolded default must already be present.
  // See denyGuardIsComplete for why family-level coverage was too coarse.
  const permissionsDeny = denyGuardIsComplete({ files: allFiles, packageJson, roots });
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
      Boolean(allScripts.ci || allScripts.validate) ||
        anyMakefileTarget(roots, ["ci", "validate", "test"]),
      "Add npm run ci/validate or a Makefile target that agents can run before completion.",
    ),
    check(
      "Typecheck",
      Boolean(allScripts["type-check"] || allScripts.typecheck || allScripts.lint) ||
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
      guardNa || permissionsDeny,
      guardNa
        ? "N/A — not a Claude Code project (no CLAUDE.md / .claude/settings*.json). permissions.deny is a Claude Code settings mechanism."
        : "Add .claude/settings.local.json permissions.deny for irreversible commands (rm -rf, git push -f, git reset --hard, mkfs, dd, DROP TABLE) so agents cannot run them. (vca init --write scaffolds a default list.)",
      guardNa,
      { coveredFamilies: hooks.coveredDenyFamilies },
    ),
    check(
      "Deploy hooks",
      hasScriptPrefix(allScripts, ["deploy", "release"]) ||
        anyMakefileTarget(roots, ["deploy", "release"]) ||
        hasDeployArtifact(filesByRoot),
      "Add a deploy/release script, workflow, or skill so code is never deployed unverified.",
    ),
    check(
      "Rule sensors",
      !(hasAt("CLAUDE.md") || hasAt("AGENTS.md")) ||
        hasTestFiles(allFiles) ||
        hasValidateScript(allFiles) ||
        Boolean(allScripts.lint || allScripts["type-check"] || allScripts.typecheck || allScripts.validate || allScripts.ci),
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
      Boolean(allScripts.monitor) || hasObservabilitySensor(allFiles),
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
  return { cwd, shape, roots, files: allFiles, packageJson, scripts, workspaceScripts, dirScripts, checks, score, warnings, untrackedHarness };
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

function check(area, ok, action, na = false, extra = {}) {
  return { area, ok, action, na: Boolean(na), ...extra };
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

/** Collect script maps for the package tree, split by how npm actually resolves
 *  them — the SAME script body legitimately resolves or not depending on whether
 *  the invocation is scoped:
 *
 *  - `flat` — ROOT package scripts only. An UNSCOPED `npm run <cmd>` runs in the
 *    CURRENT package (npm run --help: `npm run <command>` with no `--workspace`
 *    selector runs in the current package), so a member's same-named script must
 *    NOT satisfy an unscoped hook: npm would print "Missing script: <cmd>" and the
 *    hook would never run. Rooting the unscoped map in the root package prevents a
 *    member body from false-PASSing the Agent-hooks check. (Codex P2 #3659878984)
 *
 *  - `byName` — DECLARED workspace members only (from `workspaces` /
 *    pnpm-workspace.yaml), keyed by each member's `name` AND its directory path
 *    (relative to cwd, e.g. `packages/a`). npm's `--workspace` selector accepts a
 *    package NAME or a member PATH (`--workspace packages/a`, npm run --help); the
 *    path key is normalized the same way the selector is (leading `./` stripped).
 *    A nested manifest that exists on disk but is NOT declared as a workspace
 *    cannot be selected with `--workspace` (npm errors "No workspaces found"), so
 *    indexing it would make `npm --workspace <name> run <cmd>` resolve to a command
 *    npm rejects -> false PASS. The root package is also keyed by name (the root is
 *    an implicit workspace target reachable via `--workspace <rootname>`).
 *    (Codex P2 #3659878984)
 *
 *  - `all` — every manifest's scripts merged (members first, root last so root wins
 *    on conflict). This is an INVENTORY used only for presence checks that do not
 *    depend on resolution semantics (the "Deploy hooks" and "Rule sensors" checks,
 *    which ask "does this repo have a deploy/lint script anywhere?"). It is NOT
 *    used to resolve hook commands. Scoped lookups use `byName`; unscoped use
 *    `flat`. */
function collectAllScripts(cwd, allFiles) {
  const flat = {};
  const byName = {};
  // EVERY package.json's scripts keyed by its directory (relative to cwd). A
  // `--prefix <dir>` / `-C <dir>` / `--dir <dir>` hint reads <dir>/package.json
  // DIRECTLY — whether or not <dir> is a declared workspace member — so resolving
  // its script body needs a dir->scripts map that is independent of the declared
  // workspace membership that gates `--workspace`/`--filter`. (Codex P2 #3660483494)
  const byDir = {};
  const all = {};
  const rootPkg = readJson(path.join(cwd, "package.json"));
  for (const file of allFiles) {
    if (file.includes("node_modules/")) continue;
    if (file === "package.json" || file.endsWith("/package.json")) {
      if (file === "package.json") continue; // root merged into `all` last, below
      const pkg = readJson(path.join(cwd, file));
      if (pkg && pkg.scripts) {
        Object.assign(all, pkg.scripts);
        const relDir = path.dirname(file);
        if (relDir && relDir !== ".") byDir[normalizeWorkspaceKey(relDir)] = pkg.scripts;
      }
    }
  }
  if (rootPkg && rootPkg.scripts) {
    Object.assign(flat, rootPkg.scripts);
    Object.assign(all, rootPkg.scripts); // root last: wins the inventory merge
    // The root package is NOT a selectable npm workspace member: `--workspace
    // <root-name>` errors "No workspaces found" (root access uses the separate
    // `--include-workspace-root` option; npm run --help). Registering the root
    // name here made such a hook resolve to the root script and false-PASS the
    // Agent-hooks check. Unscoped `npm run <script>` still resolves via `flat`.
    // (Codex P2 #3660714234)
  }
  for (const { dir, pkg } of readDeclaredWorkspaceMembers(cwd, rootPkg)) {
    if (!pkg.scripts) continue;
    if (typeof pkg.name === "string" && pkg.name) byName[pkg.name] = pkg.scripts;
    // Also key by member DIRECTORY (relative to cwd) so the `--workspace <path>`
    // selector form resolves to THIS package.
    const rel = path.relative(cwd, dir);
    if (rel) byName[rel] = pkg.scripts;
  }
  return { flat, byName, byDir, all };
}

/** Normalize a `--workspace`/`--filter` selector value for `byName` lookup. npm
 *  accepts a package NAME or a member PATH (`packages/a`, `./packages/a`); strip a
 *  leading `./` so the path form matches the directory key collectAllScripts
 *  records.
 *
 *  pnpm `--filter` (npm `--workspace` does NOT use these) appends modifiers that
 *  are NOT part of the package name: a trailing `...` selects the package plus its
 *  dependencies, a leading `...` selects it plus its dependents, and `^...`
 *  selects direct dependencies only (pnpm --filter run --help). Strip them so the
 *  BASE name/path resolves against byName; otherwise `pnpm --filter a... run
 *  format` (which pnpm runs successfully) is rejected as an unknown workspace ->
 *  false MISS + redundant scaffolding. Package names cannot contain `...`
 *  (npm naming rules), so the strip is safe for npm/yarn selectors too.
 *  (Codex P2 #3660031350) */
function normalizeWorkspaceKey(sel) {
  return String(sel || "")
    .replace(/^\.\/+/, "")
    .replace(/\^?\.\.\.$/, "") // trailing `...` (pkg + deps) or `^...` (direct deps)
    .replace(/^\.\.\./, ""); //  leading `...` (pkg + dependents)
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
const DANGEROUS_CMD_FAMILIES = [
  // rm-recursive
  { fam: "rm-recursive", pats: [
      // rm with a RECURSIVE flag is irreversible (force only suppresses the
      // prompt), so any recursive form counts. `.*?` lets the recursive flag
      // appear after preceding flags (`rm -f -r`, `rm --force --recursive`),
      // not only as the first cluster. Token-bounded so `rm -readme` (the -r
      // is a prefix of the longer token -readme, not a flag) does not match.
      "rm\\s+.*?-[frRivIdP]*[rR][frRivIdP]*(?=\\s|$)",
      "rm\\s+.*?--recursive\\b",
  ] },
  // git-force-push
  { fam: "git-force-push", pats: [
      // Force as a standalone flag (`-f`/`--force`) OR clustered with other git
      // push short flags (`-qf`, `-fq`). The cluster `[fqvnutd]*f[fqvnutd]*` draws
      // from git push's real short-flag alphabet (f/q/v/n/u/t/d) so a lone `-u`
      // (set-upstream, no force) does not false-match, and the trailing
      // `(?:\s|$)` requires whitespace/end AFTER the cluster so `--force-with-lease`
      // (the safer, conditional variant) is NOT matched. (Codex P1 #3663668182)
      "git\\s+push\\b.*?\\s(?:--force|-[fqvnutd]*f[fqvnutd]*)(?:\\s|$)",
  ] },
  // git-hard-reset
  { fam: "git-hard-reset", pats: [
      "git\\s+reset\\b.*?\\s--hard(?:\\s|$)",
  ] },
  // git-clean-force
  { fam: "git-clean-force", pats: [
      // git clean needs a FORCE flag to actually delete (without -f git refuses;
      // -n/--dry-run only previews). Require -f in a short-flag cluster or
      // --force, so `Bash(git clean -n:*)` (a safe preview) does not false-satisfy
      // the guard and skip scaffolding of rm -rf / force-push protection.
      "git\\s+clean\\b.*?(?:--force\\b|-[fdxXnie]*f[fdxXnie]*(?:\\s|$))",
  ] },
  // device-write
  { fam: "device-write", pats: [
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
      ">\\s*\\/dev\\/sd",
  ] },
  // sql-destructive
  { fam: "sql-destructive", pats: [
      "drop\\s+(?:table|database)",
      "truncate(?![\\w-])",
      // SQL reaches the DB through a client, not as a bare command: block the
      // execute flags. Lookahead-terminated so `psql --cluster` / `mysql -u`
      // (where -c/-e is a substring of a different flag) don't false-match.
      "psql\\s+.*?-(?:c|f)(?=\\s|$)",
      "mysql\\s+.*?(?:-e|--execute)(?=\\s|$)",
      // prisma reset runs through any package manager's runner (`npx`, `pnpm exec`,
      // `yarn exec`, `bunx`), each prefixing the command differently. An optional
      // runner + `.*?` for its subcommand lets the detector (and denyEntryFamily)
      // recognize wrapper-wrapped forms, not just bare `prisma …`. (Codex P1 #3663410490.)
      "(?:(?:npx|pnpm|yarn|bunx?)\\s+.*?)?prisma\\s+migrate\\s+reset\\b",
  ] },
  // pipe-to-shell
  { fam: "pipe-to-shell", pats: [
      "curl.*\\|\\s*(?:sh|bash)",
      "wget.*\\|\\s*(?:sh|bash)",
  ] },
];

const DANGEROUS_CMD_RE = new RegExp(
  "^(?:" + DANGEROUS_CMD_FAMILIES.flatMap((f) => f.pats).join("|") + ")",
  "i",
);
// Per-family regexes let the guard track WHICH irreversible-command families
// a deny list already covers, so a single-family list (e.g. only `Bash(mkfs:*)`)
// is not mistaken for a complete guard. (Codex P1 #3660296403)
const DANGEROUS_FAMILY_RES = new Map(
  DANGEROUS_CMD_FAMILIES.map((f) => [f.fam, new RegExp("^(?:" + f.pats.join("|") + ")", "i")]),
);

/** A Claude Code deny entry looks like `Bash(<command>:<qualifier>)` (or
 *  `Bash(<command>)`). The blocked command is the `<command>` prefix before the
 *  first `:`. Return the NAME of the irreversible-command family this entry
 *  blocks (e.g. "rm-recursive", "device-write"), or null when the prefix does
 *  not start with a dangerous command — never when the verb is merely mentioned
 *  later in the line or hidden inside a longer token like a branch or file name. */
export function denyEntryFamily(entry) {
  const m = String(entry).trim().match(/^Bash\(([^)]*)\)$/);
  if (!m) return null;
  let cmd = m[1];
  // Claude Code's argument qualifier is a trailing `:*` (e.g. `Bash(rm -rf:*)`).
  // Strip ONLY that suffix. Slicing at the first colon truncates commands that
  // legitimately contain colons — a URL in `Bash(curl https://x/install.sh |
  // sh)` became `curl https`, so the remote-exec pattern never matched and the
  // guard was falsely reported missing.
  if (cmd.endsWith(":*")) cmd = cmd.slice(0, -2);
  // Recognize the dangerous command behind a leading `sudo` runner: sudo is a
  // privilege escalator, not the command itself, so `sudo rm -rf` / `sudo git
  // push --force` resolve to the dangerous verb after sudo (and its trailing
  // space) are stripped. (Codex P2 #3659066974)
  const stripped = cmd.replace(/^sudo\b\s*/, "");
  for (const [fam, re] of DANGEROUS_FAMILY_RES) {
    if (re.test(stripped)) return fam;
  }
  // `Bash(sudo rm:*)` — which defaultDenyList() itself emits — is a BROAD sudo rm
  // block with no explicit recursive flag, so the regex above (which needs a
  // flag) misses it after stripping to bare `rm`. sudo rm as root is dangerous
  // regardless of flags, so recognize a leading-sudo rm runner explicitly as
  // rm-recursive. The leading-sudo requirement keeps `Bash(rm -readme:*)` (no
  // sudo, where -r is a prefix of the -readme token) MISSing, and
  // `Bash(echo sudo rm:*)` (sudo not leading) MISSing.
  if (/^(?:sudo\s+)+rm\b/.test(cmd)) return "rm-recursive";
  return null;
}

/** Compile a Claude Code PostToolUse matcher into { catchAll, re }. An empty
 *  matcher is a catch-all (fires on every tool); a /pattern/flags literal is
 *  unwrapped; an unparseable pattern returns null so callers fall back safely.
 *  Extracted so detection, merge, and the broad-matcher check share one
 *  compilation path. This only COMPILES the regex — whether it "fires on" a tool
 *  name uses exact-alternation-vs-regex semantics (see matcherFiresOn). */
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

/** True when a matcher fires on a given tool name. A catch-all fires on every
 *  tool. Otherwise matching follows Claude Code's documented matcher model
 *  (code.claude.com/docs/en/hooks): a matcher is either an EXACT alternation of
 *  tool names (only letters, digits, _, -, space, comma, |) or a regular
 *  expression. For an exact alternation we match WHOLE tool names — `Edit|Write`
 *  fires on Edit and Write ONLY, not on TodoWrite / NotebookEdit / MultiEdit
 *  that merely contain those substrings (the docs describe `Edit|Write` as
 *  firing on "only the Edit or Write tools"). A matcher containing any OTHER
 *  regex metacharacter (^ $ . * + ? ( ) [ ] { } \ / : etc.) is the user's own
 *  regex and is tested AS WRITTEN, so their anchors (`^(Edit|Write)$`) and
 *  prefixes (`^mcp__`) stand. This matters for MERGE: a bare unanchored
 *  `.test()` made `Edit|Write` fire on TodoWrite, so matcherIsEditWriteEntry
 *  rejected the scaffolded entry and evolve duplicated it instead of merging. */
function matcherFiresOn(matcher, toolName) {
  const compiled = compileMatcher(matcher);
  if (!compiled) return false;
  if (compiled.catchAll) return true;
  const src = compiled.re.source;
  // Exact-alternation charset per the Claude Code docs. Inside a character class
  // `-` is literal at the tail and `|`/`,`/space are literal (not operators).
  const isExactAlternation = /^[A-Za-z0-9_ ,|-]+$/.test(src) && src.trim() !== "";
  if (isExactAlternation) {
    return new RegExp("^(?:" + src + ")$").test(toolName);
  }
  return compiled.re.test(toolName);
}

/** Classify a matcher by whether it fires on the Edit and Write tools, via the
 *  shared matcherFiresOn primitive so exact-alternation and regex forms agree.
 *  Returns "catch-all" (empty matcher, fires on every tool), "both" (non-empty
 *  matcher firing on Edit AND Write), or "no". `NotebookEdit|Write` is "no"
 *  (NotebookEdit does not equal Edit as a whole name); an unparseable regex
 *  falls back to "no" so detection never falsely PASSES. */
function matcherCoverage(matcher) {
  const compiled = compileMatcher(matcher);
  if (!compiled) return "no";
  if (compiled.catchAll) return "catch-all";
  return matcherFiresOn(matcher, "Edit") && matcherFiresOn(matcher, "Write") ? "both" : "no";
}

/** True when a PostToolUse matcher fires on BOTH Edit and Write. Used by
 *  DETECTION: a catch-all (empty) matcher covers everything, so it honors a
 *  no-explicit-matcher lint+format setup rather than skipping it. */
function matcherCoversEditWrite(matcher) {
  const c = matcherCoverage(matcher);
  return c === "catch-all" || c === "both";
}

/** PostToolUse tools whose payload carries `tool_input.file_path` and that we
 *  want a formatter/linter to run after. A matcher is a safe MERGE target only
 *  when it fires on a SUBSET of these: any other tool either carries no
 *  file_path (so the appended `{}` hook runs on an empty arg and blocks) or is
 *  needlessly broad (Read mutates the tree on every read). NotebookEdit edits
 *  notebooks but exposes `notebook_path`, not `file_path`, so it is NOT here. */
const FILE_EDIT_TOOLS = ["Edit", "Write", "MultiEdit"];

/** Every OTHER known Claude Code tool — the complement of FILE_EDIT_TOOLS.
 *  matcherIsEditWriteEntry treats this as an ALLOWLIST: a matcher that fires on
 *  ANY of these is rejected as a merge target, so `Edit|Write|WebFetch`,
 *  `Edit|Write|WebSearch`, and `Edit|Write|NotebookEdit` are caught even though
 *  none was named in a small banned list. A matcher covering an unknown future
 *  non-edit tool would slip through — add such tools here when discovered. */
const NON_FILE_EDIT_TOOLS = [
  "Read", "Bash", "Glob", "Grep", "Task", "LS", "TodoWrite",
  "WebFetch", "WebSearch", "NotebookEdit",
];

/** True only for a NON-catch-all matcher scoped to file edits — fires on both
 *  Edit and Write AND on no tool outside FILE_EDIT_TOOLS. Used by MERGE: we
 *  append formatter hooks to an existing entry only when it is scoped to file
 *  edits. Appending to a catch-all OR a broader matcher (`.*`, `Edit|Write|Read`,
 *  `Edit|Write|WebFetch`) would make prettier/eslint run after a tool whose
 *  payload carries no file_path, so the hook fails on the literal `{` arg and
 *  blocks after an unrelated tool use. Such entries are preserved untouched and
 *  a separate Edit|Write entry is added instead. Detection
 *  (matcherCoversEditWrite) stays lenient — a broad matcher still COVERS edits
 *  — only the MERGE needs the stricter allowlist scope. */
function matcherIsEditWriteEntry(matcher) {
  if (matcherCoverage(matcher) !== "both") return false;
  return !NON_FILE_EDIT_TOOLS.some((tool) => matcherFiresOn(matcher, tool));
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
// The DIRECT-binary lint branch (commandPurposes) requires `lint`/`eslint` to be
// the EXECUTED command — the first non-option, non-runner token — not merely a
// word appearing anywhere in the segment. LINT_CMD_RE above scans the whole line,
// so `cat lint.log` or `tee lint-report` would match \blint\b inside a filename
// or argument and false-PASS the lint check (the format path is gated by a write
// flag; lint has no such secondary gate). The `.*\/` prefix lets an explicit
// `./node_modules/.bin/eslint` count, and only the basename (after the last slash)
// is matched against lint|eslint.
const COMMAND_IS_LINTER_RE = /^(?:.*\/)?(?:lint|eslint)$/i;
// Symmetric to COMMAND_IS_LINTER_RE for the DIRECT-binary format branch: the
// formatter (prettier/format/fmt) must be the executed command, so `cat prettier
// --write` or `node tool.js format --write` does not false-PASS format-on-save.
const COMMAND_IS_FORMATTER_RE = /^(?:.*\/)?(?:prettier|format|fmt)$/i;
// The package-manager keyword must be the EXECUTED command to enter the
// script-resolution branch. PM_SCRIPT_RE is unanchored (\b), so `npm run lint`
// appearing as DATA — e.g. `node -e "console.log('npm run lint')"` — matched it,
// resolved the real `lint` script, and credited lint though npm never ran. This
// mirrors COMMAND_IS_LINTER_RE and is checked via segmentExecutes (pass-through
// aware) so `... | xargs npm run lint` still counts.
const PM_KEYWORD_RE = /^(?:.*\/)?(?:npm|pnpm|yarn|bun)$/i;
const FORMAT_CMD_RE = /\bprettier\b|\bformat\b|\bfmt\b/i;
// A REAL formatter binary name (`prettier`) versus a generic script-name word
// (`format`/`fmt`/`style`). When a PM script resolves OPAQUE (body unseen) and
// the captured name is a real binary, yarn/bun running it WITHOUT `run`
// (implicit binary mode) executes node_modules/.bin/prettier directly, so the
// flags on the line are the real prettier flags — prettier writes to stdout by
// default and only rewrites with --write/-w. Generic script names keep
// opaque-trust (the write flag lives in the unseen body). (Codex P2 #3659302760)
const FORMATTER_BINARY_NAME_RE = /^(?:.*\/)?prettier$/i;
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
// only fires for genuine `[run] <script>` invocations. A global option may
// PRECEDE the subcommand (`npm --silent exec prettier .`), and the lookahead
// only sees the IMMEDIATELY following token — so without skipping leading flags
// it sees `--silent` (not exec/dlx), matches, and routes a direct-execution
// command into script resolution: the captured flag/exec token is absent from the
// scripts map → opaque → the name heuristic sees `prettier` and false-PASSes a
// check-only formatter. `(?:--?\S+\s+)*` consumes leading option flags so the
// lookahead still reaches `exec`/`dlx`, excludes the command, and routes it to
// the direct-binary classifier (segmentExecutes), which requires `--write`
// (Codex P2 #3656758667). Value-consuming options (`--workspace`/`-w`/`--filter`/
// `--prefix`/`-C`/`--dir`) take a following VALUE token, so the skipper must
// consume BOTH the flag and its value — otherwise `npm --prefix packages/a exec
// prettier .` stops the skip at the value `packages/a`, the lookahead sees the
// value (not `exec`), the regex matches, and the command is routed into script
// resolution: "exec" is absent from the scripts map → opaque → the name heuristic
// trusts a bare `prettier` and false-PASSes format-on-save (#3657507803). The
// skipper tries the (flag+value) pair for the known value options first, then the
// generic single-flag fallback for boolean options like `--silent`.
// ANTI-BACKTRACKING (two parts):
//  1) The trailing `\s+` sits OUTSIDE the alternation so EACH skipped option must
//     be a COMPLETE whitespace-terminated token. A value like `packages/a` is
//     consumed whole because `\S+`'s partial backtracks (`packages/`, leaving `a`)
//     are rejected — none is followed by the `\s+` this iteration requires.
//  2) The boolean fallback must NOT swallow a value-option FLAG alone (leaving
//     its value dangling as the captured "script"). It carries a negative
//     lookahead for the value-option names AND starts its name with `[^\s-]`, so
//     `--prefix` is rejected by the lookahead and `--?` cannot backtrack to a
//     single dash to match a double-dash flag (the char after one dash is `-`,
//     which `[^\s-]` forbids). Together these force `--prefix <val>` to be skipped
//     as a unit or not at all.
// (Emulating possessive matching; JS has no atomic groups.)
// `([^\s-]\S*)` captures the first token as the script name; it must NOT begin
// with `-` (a script name never does), otherwise the `*` group backtracks to ZERO
// iterations and the capture grabs the option flag itself (`--silent`),
// re-enabling the opaque false-PASS the skip was meant to prevent. JavaScript
// lacks possessive quantifiers, so the non-dash first char is what makes the skip
// non-backtracking in practice.
const PM_SCRIPT_RE = /\b(?:npm|pnpm|yarn|bun)\s+(?:(?:--?(?:workspace|w|filter|prefix|C|dir)(?:=\S+|\s+\S+)|--?(?!workspace\b|w\b|filter\b|prefix\b|C\b|dir\b)[^\s-]\S*)\s+)*(?:run\s+)?(?!exec\b|dlx\b)([^\s-]\S*)/;
// Global-flagged regex matching a FULL PM invocation span — the keyword plus
// every non-operator token up to the next shell operator (&& || ; |) or end of
// string — for inline substitution in a script body (resolveScriptBody).
// PM_SCRIPT_RE captures only the FIRST token after the keyword, so for a
// selector-before-run body like `npm --workspace a run format` its match is the
// TRUNCATED `npm --workspace` — passing that to resolveScriptBody loses both the
// selector and the script name, resolution goes opaque, and the caller's
// name-heuristic false-PASSes (Codex P2 #3656270108). Matching the whole span
// lets resolveScriptBody see selector + name together. PM_SCRIPT_RE (above)
// remains the unanchored test used elsewhere; this is the replace-only copy.
const PM_SCRIPT_CALL_RE_G = /\b(?:npm|pnpm|yarn|bun)\b[^;&|]*/g;
// npm lifecycle scripts runnable WITHOUT `run` (`npm test`, `npm start`, ...).
// Every OTHER npm script REQUIRES `run` — `npm lint` errors "Unknown command:
// lint" (npm run --help) and never invokes scripts.lint. pnpm/yarn/bun run scripts
// WITHOUT `run`, so this set is npm-only. Used by resolveScriptBody to MISS a bare
// `npm <script>` whose name is not a lifecycle shortcut. (Codex P2 #3660108922)
const NPM_LIFECYCLE_SCRIPTS = new Set(["test", "start", "stop", "restart"]);
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
 *  and a selector whose package is absent from the map FAILS CLOSED (definitive
 *  MISS) rather than falling back to the flat map, which would resolve an
 *  unrelated package's same-named script and false-PASS (#3659471687). */
/** Walk a package-manager invocation's tokens POSITIONALLY to extract both the
 *  script/command NAME and the workspace SELECTOR value. Positional is the key
 *  invariant: a selector is recorded only when it appears BEFORE the command
 *  name. `-w` is overloaded — npm/pnpm use `-w <pkg>` as `--workspace` (a
 *  pre-command selector) while prettier uses `-w` as `--write` (a POST-command
 *  write flag). A non-positional regex would misread prettier's `-w` as a
 *  workspace selector, pick a bogus package, and (with the fail-closed selector
 *  guard in resolveScriptBody) false-MISS a valid `bun prettier -w .` write hook.
 *  The walk reaches prettier as the command name first and returns ws=null so the
 *  caller falls through to the unscoped/flat map as intended. (Codex P2 #3659471687)
 *
 *  Returns { name, ws }: name is the first bare (non-option) token after the PM
 *  keyword + `run` + any selectors (or null); ws is the FIRST selector value seen
 *  before the name (or null). The inline `=val` spelling is a single token handled
 *  by its own branch. Yarn's positional `workspace <name>` is honored only under
 *  yarn so a script literally named "workspace" under npm/pnpm/bun is not eaten. */
function parsePmInvocation(invocation) {
  const s = String(invocation || "");
  const pm = s.match(/\b(?:npm|pnpm|yarn|bun)\b/);
  if (!pm) return { name: null, ws: null, prefix: null, pm: null, hasRun: false };
  const isYarn = pm[0] === "yarn";
  const tokens = s.slice(pm.index + pm[0].length).split(/\s+/).filter(Boolean);
  let ws = null;
  let prefix = null;
  let hasRun = false; // whether an explicit `run` keyword preceded the script name
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "run") { hasRun = true; i++; continue; }
    // STRICT workspace selectors — record the FOLLOWING token as the named member
    // (only the FIRST one, before the command name) and skip selector + value so
    // the real script NAME is returned instead of the value:
    //   `--workspace <pkg>` / `-w <pkg>`  (npm, pnpm)
    //   `--filter <pkg>`                  (pnpm)
    //   `workspace <name> <cmd>`          (yarn classic, POSITIONAL — no flag)
    if (t === "--workspace" || t === "-w" || t === "--filter") {
      if (ws === null && tokens[i + 1] !== undefined) ws = tokens[i + 1];
      i += 2; continue;
    }
    if (isYarn && t === "workspace") {
      if (ws === null && tokens[i + 1] !== undefined) ws = tokens[i + 1];
      i += 2; continue;
    }
    // DIRECTORY hints — change WHERE the PM reads package.json, NOT which member
    // it selects. `--prefix <dir>` / `-C <dir>` / `--dir <dir>` (npm/pnpm). These
    // are tracked SEPARATELY from `ws` because npm reads <dir>/package.json
    // directly and does NOT error when <dir> is not a declared workspace member
    // (unlike `--workspace <unknown>`, which errors "No workspaces found").
    // (Codex P2 #3660483494)
    if (t === "--prefix" || t === "-C" || t === "--dir") {
      if (prefix === null && tokens[i + 1] !== undefined) prefix = tokens[i + 1];
      i += 2; continue;
    }
    if (/^(?:--workspace|-w|--filter)=/.test(t)) {                                // inline strict selector (--filter=a)
      if (ws === null) ws = t.slice(t.indexOf("=") + 1);
      i++; continue;
    }
    if (/^(?:--prefix|-C|--dir)=/.test(t)) {                                      // inline directory hint (--prefix=a)
      if (prefix === null) prefix = t.slice(t.indexOf("=") + 1);
      i++; continue;
    }
    // `--script-shell <path>` (npm/pnpm) takes a VALUE (the shell binary) but does
    // NOT select a member or change where package.json is read — it only sets the
    // shell used to run the script body. Consume the value so it is NOT misread as
    // the script name (which would skip body resolution). (Codex P2 #3663668188)
    if (t === "--script-shell") { i += 2; continue; }
    if (/^--script-shell=/.test(t)) { i++; continue; }                            // inline (--script-shell=/bin/sh)
    if (t.startsWith("-")) { i++; continue; }                                     // boolean option
    return { name: t, ws, prefix, pm: pm[0], hasRun };                            // first bare token = command
  }
  return { name: null, ws, prefix, pm: pm[0], hasRun };
}

function extractScriptName(invocation) {
  return parsePmInvocation(invocation).name;
}

function resolveScriptBody(invocation, scripts, seen, workspaceScripts, byDir) {
  const s = String(invocation || "");
  if (!PM_SCRIPT_RE.test(s)) return null;
  // npm/pnpm/yarn forward trailing args after a bare `--`: `npm run format --
  // --write` runs the format script body with `--write` appended (documented in
  // `npm run --help`). Capture them so they reach the caller's purpose
  // classifier — otherwise a forwarded `--write` is dropped (format false-MISSes
  // and init/evolve append a redundant hook) or a forwarded `--check` is hidden
  // (a write body false-PASSes as covered). (Codex P2 #3656425156)
  const forwardedMatch = s.match(/(?:^|\s)--\s+(.+)$/);
  const forwarded = forwardedMatch ? forwardedMatch[1].trim() : "";
  const { name, ws: wsRaw, prefix: prefixRaw, pm, hasRun } = parsePmInvocation(s);
  if (!name) return null;
  // npm REQUIRES `run` (or a lifecycle shortcut) to execute a user script: `npm
  // lint` exits "Unknown command: lint" (npm run --help) and never invokes
  // scripts.lint, so resolving it against the root `lint` script false-PASSes a
  // hook npm never runs. pnpm/yarn/bun run scripts WITHOUT `run` (unaffected).
  // Treat a no-`run` npm invocation whose name is not a lifecycle shortcut
  // (test/start/stop/restart) as a definitive MISS ("") — NOT null (opaque) — so
  // the caller's name-heuristic trust does NOT credit `npm lint` as a lint script.
  // (Codex P2 #3660108922)
  if (pm === "npm" && !hasRun && !NPM_LIFECYCLE_SCRIPTS.has(name)) return "";
  // Workspace/package selector vs directory hint. Long-form flags are
  // UNAMBIGUOUS PM global flags valid in ANY position, including AFTER the script
  // name (`npm run format --workspace a` — npm scans all args); they are matched
  // non-positionally below. The short `-w` is AMBIGUOUS (npm/pnpm use it as
  // `--workspace`, but prettier uses it as `--write`), so it is honored ONLY
  // before the command name — parsePmInvocation's positional walk (wsRaw)
  // records it there, while a TRAILING `-w` (`bun prettier -w .`) is left as a
  // tool write flag and never reaches this selector path. The value is NORMALIZED
  // (leading `./` stripped) to match collectAllScripts' directory-key form.
  //   STRICT selectors (--workspace/-w/--filter, yarn `workspace`) NAME a member;
  //   an unknown name means the PM ERRORS at runtime. DIRECTORY hints
  //   (--prefix/-C/--dir) only change WHERE the PM reads package.json; npm reads
  //   <dir>/package.json directly and does NOT error on an undeclared dir.
  //   (Codex P2 #3659471687 / #3660483494)
  const wsLong = wsRaw ? null : s.match(/(?:^|\s)(?:--workspace|--filter)[ =](\S+)/);
  const prefixLong = prefixRaw ? null : s.match(/(?:^|\s)(?:--prefix|-C|--dir)[ =](\S+)/);
  const wsName = wsRaw ? normalizeWorkspaceKey(wsRaw)
    : wsLong ? normalizeWorkspaceKey(wsLong[1]) : null;
  const prefixName = prefixRaw ? normalizeWorkspaceKey(prefixRaw)
    : prefixLong ? normalizeWorkspaceKey(prefixLong[1]) : null;
  // A STRICT selector that names an unknown package FAILS CLOSED: the PM errors
  // ("No workspaces found" / "No projects matched") and never runs. Do NOT fall
  // back to the flat map (which would resolve an UNRELATED package's same-named
  // script and false-PASS); return the definitive MISS sentinel ("") so the
  // caller classifies no-purpose -> MISS and SKIPS the opaque name-heuristic
  // trust. Only the UNSCOPED case legitimately uses the flat/root map.
  // (Codex P2 #3659471687)
  if (wsName && !(workspaceScripts && workspaceScripts[wsName])) return "";
  // A directory hint resolves ONLY when <dir> is a known workspace member (keyed
  // by directory). An UNKNOWN dir (--prefix <non-member>) is OPAQUE: npm reads
  // that dir's package.json, which vca cannot reach from the workspace map. Do
  // NOT fall back to the root map (would resolve an UNRELATED root script and
  // false-PASS) and do NOT fail-close (npm does not error on an undeclared dir,
  // unlike --workspace). Return null so the caller's name-heuristic trust applies
  // — the named script still expresses lint/format intent even when its body lives
  // where vca can't read it. (Codex P2 #3660483494)
  const prefixScope = prefixName
    ? (workspaceScripts && workspaceScripts[prefixName]) || (byDir && byDir[prefixName]) || null
    : null;
  if (!wsName && prefixName && !prefixScope) return null;
  const scope = wsName ? workspaceScripts[wsName] : (prefixScope || scripts);
  // Cycle guard keys on (workspace scope, name), NOT name alone: the same script
  // NAME under a DIFFERENT workspace (root `format` -> member a `format` via
  // `npm --workspace a run format`) is a legitimate cross-package resolution, not
  // a self-cycle. Keying on name only (Codex P2 #3656270108) blocked the nested
  // member lookup as soon as the root name was seen, leaving the body opaque and
  // false-PASSing the name heuristic. `__flat__` namespaces the no-selector case.
  const scopeKey = wsName || prefixName || "__flat__";
  if (seen.has(`${scopeKey}:${name}`)) return null;
  const body = scope ? scope[name] : undefined;
  // Absent from the selected manifest -> OPAQUE (null), NOT a hard MISS. The
  // caller's name-heuristic fallback (`LINT_CMD_RE`/`FORMAT_CMD_RE`) then trusts
  // `npm run lint`/`npm run format` by NAME. This opaque-trust is INTENTIONAL,
  // not a gap: a hook command that NAMES a lint/format script expresses the
  // user's intent to lint/format, and the body may live where vca cannot fully
  // resolve it (workspace member, generated script, custom runner). Erring toward
  // trust avoids false-MISS noise that would make init/evolve append redundant
  // racing hooks. A cycle (a -> b -> a) is also opaque: the seen-set terminates
  // recursion and a leftover PM keyword signals opaque so the caller falls back
  // rather than re-resolving infinitely. (Codex once proposed treating absent as
  // a hard MISS; rejected because it conflicts with this documented trust policy
  // — see the `npm run format` + scripts:{} PASS cases in cli.test.js.)
  if (typeof body !== "string" || body.trim() === "") return null;
  seen.add(`${scopeKey}:${name}`);
  if (!PM_SCRIPT_RE.test(body)) return forwarded ? `${body} ${forwarded}` : body;
  // Resolve nested PM invocations INLINE — substitute each `npm/pnpm/yarn/bun
  // [run] <name>` occurrence in the body with ITS resolved body — so SIBLING
  // commands are preserved for the caller (commandPurposes) to split on
  // &&/||/;/| and classify per-segment. Recursing on the WHOLE body (old
  // behavior) treated it as a single invocation: extractScriptName grabbed only
  // the FIRST script name, so `"format": "npm run prep && prettier --write ."`
  // followed `prep` and discarded `prettier --write .` — the valid format hook
  // false-MISSed and init/evolve appended a racing duplicate.
  //
  // Each sibling resolves on its OWN path copy of `seen` (new Set(seen)), so the
  // same script appearing in two conjunction branches (`npm run a && npm run b`
  // where both chain to a shared `c`) resolves in BOTH; the copy still includes
  // `name`, so a true cycle (`a -> b -> a`) is caught. If a PM invocation cannot
  // be resolved (cycle, or absent from the map), it is left in place; a leftover
  // PM keyword then signals opaque (return null) so the caller falls back rather
  // than re-resolving the same invocation infinitely.
  const resolved = body.replace(PM_SCRIPT_CALL_RE_G, (match) => {
    const sub = resolveScriptBody(match.trim(), scope, new Set(seen), workspaceScripts, byDir);
    return sub != null ? sub : match;
  });
  if (PM_SCRIPT_RE.test(resolved)) return null;
  // Append forwarded `--` args to the resolved body so they participate in
  // classification (e.g. `npm run format -- --write` -> `prettier . --write`).
  // Only when the body resolved to a concrete command; an opaque body returns
  // above and the caller's name heuristic does not consult forwarded args.
  return forwarded ? `${resolved} ${forwarded}` : resolved;
}

/** True when a NON-package-manager command segment EXECUTES a tool whose name
 *  matches `cmdRe` (a lint or format binary). The tool must be reached as the
 *  EXECUTED command — the first token, or the first command token after one or
 *  more pass-through runners and their option flags — NOT a bare word that
 *  appears as a filename or argument AFTER a terminal command. LINT_CMD_RE/
 *  FORMAT_CMD_RE scan the whole line, so `cat lint.log`, `cat lint`,
 *  `node tool.js eslint`, and `cat prettier --write` matched the tool name
 *  inside an argument and false-PASSed the check. Scanning left-to-right and
 *  stopping at the first terminal (non-runner, non-option) token keeps
 *  pipelines working too: `... | xargs ... npx eslint` still credits lint
 *  because xargs/npx are pass-throughs and eslint is reached as the command.
 *
 *  Pass-through runners (do NOT execute the tool themselves; the tool is a later
 *  token they dispatch to):
 *  - `npx`/`bunx`/`dlx` and a PM `exec`/the PM keyword (`npm`/`pnpm`/`yarn`/`bun`):
 *    resolve and run an npm package binary.
 *  - `xargs`: feeds piped input as args to a later command.
 *  - `sh`/`bash`/`dash`/`zsh`/`ksh`/`ash` with `-c`: EXECUTE a script argument, so
 *    tool tokens inside the (quote-stripped) script ARE executed. The scaffolded
 *    combined hook is `xargs -0 -I{} sh -c 'npx prettier --write ... && npx
 *    eslint ...' _ {}`: after quote-stripping, `sh` precedes the inner tool
 *    tokens, so a shell WITH -c MUST be a pass-through or format/lint false-MISS.
 *    WITHOUT -c the shell is TERMINAL: its first non-option token is a script
 *    FILE (GNU Bash `bash --help`: `[-c command_string | file]`), so `bash
 *    eslint` must NOT credit lint (Codex P2 #3657945044) — checked in the loop
 *    via shellHasC, not unconditionally here.
 *  - `env` (POSIX) / `cross-env` (npm): set environment variables then run the
 *    next command, so `cross-env FOO=1 prettier --write .` must still credit
 *    format (Codex P2 #3656270114). A `VAR=value` ASSIGNMENT that follows one of
 *    these runners (or stands alone as a leading prefix, e.g.
 *    `NODE_ENV=test npx prettier`) is an env setting, not a terminal command, so
 *    it is skipped via ENV_ASSIGN to reach the tool behind it.
 *
 *  Deliberately NOT pass-through: `node`/`cat`/`tee`/`git`/etc are TERMINAL —
 *  their following tokens are DATA (a script file's args, a file to read), so
 *  `node tool.js eslint` and `cat lint` correctly MISS. PM `[run] <script>`
 *  invocations are handled by the caller via resolveScriptBody and never reach
 *  here. */
function segmentExecutes(seg, cmdRe) {
  const tokens = String(seg || "").split(/\s+/).filter(Boolean);
  // env (POSIX) / cross-env (npm) set env vars, then run the following command.
  const PASS_THROUGH = /^(?:npx|bunx|xargs|exec|dlx|npm|pnpm|yarn|bun|env|cross-env)$/;
  // Shells are pass-through ONLY with -c (checked via shellHasC); without -c a
  // shell is TERMINAL (its first non-option token is a script FILE).
  const SHELL_RE = /^(?:sh|bash|dash|zsh|ksh|ash)$/;
  // A leading `VAR=value` assignment (NODE_ENV=test, FOO=1) prefixes the real
  // command; skip it so the formatter/linter behind it is reached. Bounded: the
  // name starts with a letter/underscore, so a `-` option flag (handled above)
  // never matches.
  const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (cmdRe.test(t)) return true;        // reached as the executed command
    // PM value-taking options (--workspace/-w/--filter/--prefix/-C/--dir) consume
    // the FOLLOWING token as their value (npm config: -C is shorthand for
    // --prefix). Skip flag AND value, else `npm --prefix packages/a exec
    // prettier` reads `packages/a` as the terminal command and never reaches the
    // formatter (false-MISS). The `=val` inline form is a single token already
    // skipped by the startsWith("-") branch below. (Codex P2 #3659471694)
    if (/^(?:--workspace|-w|--filter|--prefix|-C|--dir)$/.test(t)) { i++; continue; }
    if (t.startsWith("-")) continue;        // option flag consumed by a runner
    if (PASS_THROUGH.test(t)) continue;     // pass-through runner / PM exec / env setter
    if (SHELL_RE.test(t)) {
      if (shellHasC(tokens, i)) continue;   // `sh -c '<script>'` executes the script
      return false;                          // `bash eslint` (no -c): eslint is a script FILE
    }
    if (ENV_ASSIGN.test(t)) continue;       // VAR=value environment-prefix assignment
    return false;                           // terminal command: tool not executed
  }
  return false;
}

/** True when the shell at tokens[shellIdx] was invoked with -c, scanned across
 *  its OPTION cluster only (the flags immediately preceding the command string
 *  or script file). `sh -c '<script>'` EXECUTES the script, so tool tokens
 *  inside it ARE executed (pass-through); WITHOUT -c the first non-option token
 *  is a script FILE whose args are data, so `bash eslint` must NOT credit lint
 *  (Codex P2 #3657945044). Bash usage: `[-bc...] [-c command_string | file]`.
 *  A clustered short flag (-lc, -ic) carries -c; a long option (--login) does
 *  not, so the scan stops at the first non-option token (the string/file). */
function shellHasC(tokens, shellIdx) {
  for (let j = shellIdx + 1; j < tokens.length; j++) {
    if (/^-[^-]*c/.test(tokens[j])) return true;
    if (!tokens[j].startsWith("-")) break;
  }
  return false;
}

/** Replace the CONTENT of quoted strings that are DATA (not commands) with a
 *  placeholder token, so an operator (`&&`, `||`, `;`, `|`) that appears INSIDE
 *  quoted data cannot be exposed by the subsequent quote-strip and split into a
 *  phantom executable segment. Only a quoted region that is the SCRIPT ARGUMENT
 *  of a shell invoked with `-c` (`sh -c '...'`, `bash -lc "..."`) is a real
 *  command and keeps its quotes intact — the later quote-strip then exposes that
 *  content for scanning, exactly as before.
 *
 *  Why the preceding token matters: `node -e "...npm run lint..."` passes the
 *  quoted text as DATA to node (a terminal command), so any `&&` inside is
 *  inert; but `sh -c '... && ...'` EXECUTES the quoted text, so the operators
 *  are real. The two are distinguished by whether the token immediately before
 *  the opening quote is a short `-c` flag of a shell. A short-flag cluster like
 *  `-lc`/`-ic` carries -c; a long option (`--login`) or non-shell flag (`-e`)
 *  does not, so those quoted regions are treated as data. (Codex P2 #3659066971) */
function maskDataQuotes(cmd) {
  let out = "";
  let i = 0;
  const n = cmd.length;
  // Recognize `c` ANYWHERE in a short-option cluster (`-c`, `-cl`, `-lc`, `-ic`),
  // not just as the final char: Bash treats clustered short flags as
  // order-independent, so `bash -cl '...'` and `bash -lc '...'` both run the
  // quoted script. Anchoring at `c$` missed `-cl` (c not last), so maskDataQuotes
  // masked the real script to inert `quoteddata` and both purposes false-MISSed.
  // Aligned with shellHasC, which already matches `c` anywhere in the cluster.
  // (Codex P2 #3663963745)
  const isShortCFlag = (s) => /^-[^-\s]*c/.test(s);
  // A package-manager SELECTOR flag takes a single package-name/path token as its
  // value (`npm --workspace '@scope/app' run hooks`), never a shell script with
  // operators. Preserve that quoted value as a BARE token (drop the enclosing
  // quotes, keep the content) so the downstream workspace lookup sees the real
  // member name. Masking it to inert `quoteddata` (the data-branch default) made
  // the lookup fail closed, so scan reported a real lint/format hook MISSING and
  // init/evolve merged a duplicate that ran on every edit. (Codex P2 #3663506850)
  const isSelectorFlag = (s) => /^(?:--workspace|--filter|--prefix|--dir|-w|-C|workspace)$/.test(s);
  const lastToken = (s) => {
    const t = String(s).trim().split(/\s+/);
    return t[t.length - 1] || "";
  };
  while (i < n) {
    const ch = cmd[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (ch === '"' && cmd[j] === "\\") { j += 2; continue; }
        if (cmd[j] === ch) break;
        j += 1;
      }
      // A shell -c script: keep the quotes so the later quote-strip exposes the
      // real commands inside. A PM selector value: emit the BARE content (no
      // quotes) so the workspace lookup tokenizes it; the value is a single token
      // with no shell operators, so no phantom segment can be exposed. Everything
      // else is DATA: drop the content (and the enclosing quotes) for a placeholder
      // that holds no operators.
      if (isShortCFlag(lastToken(out))) out += cmd.slice(i, j + 1);
      else if (isSelectorFlag(lastToken(out))) out += " " + cmd.slice(i + 1, j) + " ";
      else out += " quoteddata ";
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

function commandPurposes(cmd, scripts, workspaceScripts, byDir) {
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
  // Mask the CONTENT of quoted DATA strings (anything that is NOT a shell -c
  // script) so an operator hidden inside the data — `node -e "... && npm run
  // lint"` — cannot be exposed by the quote-strip below and split into a phantom
  // `npm run lint` segment. A shell -c script keeps its quotes (then gets
  // quote-stripped to expose real commands). Must run BEFORE the quote-strip.
  // (Codex P2 #3659066971)
  c = maskDataQuotes(c);
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
  // Split on shell conjunctions ONCE; lint and format are both classified per
  // segment (and, for package-manager scripts, against the resolved body) rather
  // than against the joined blob.
  const segments = c.split(/\s*(?:&&|\|\||\||;)\s*/);
  // Lint mirrors the format path below: resolve a package-manager script body
  // before crediting lint. Otherwise `npm run lint` is credited purely because
  // the invocation contains the word "lint", so a placeholder body
  // (`"lint": "echo not configured"`) false-PASSes the Agent-hooks check and
  // skips eslint scaffolding. Classify the resolved body; fall back to the
  // invocation line only when the body is opaque (absent from every
  // package.json we saw), so a real lint script we cannot see is still credited.
  const lintSatisfied = segments.some((seg) => {
    if (PM_SCRIPT_RE.test(seg) && segmentExecutes(seg, PM_KEYWORD_RE)) {
      const body = resolveScriptBody(seg, scripts || {}, new Set(), workspaceScripts, byDir);
      if (body != null) return commandPurposes(body, scripts, workspaceScripts, byDir).includes("lint");
      return LINT_CMD_RE.test(seg);
    }
    // Direct binary call: lint/eslint must be the EXECUTED command, not a
    // filename/argument that merely contains the word (`cat lint.log`,
    // `cat lint`, `node tool.js eslint`), and a PM invocation must actually be
    // executed (not data after another command like `node -e "...'npm run lint'"`).
    return segmentExecutes(seg, COMMAND_IS_LINTER_RE);
  });
  if (lintSatisfied) purposes.push("lint");
  // Determine the format purpose from the FORMATTER segment(s) only. A combined
  // command such as `eslint --fix . && prettier --check .` attaches --fix to the
  // LINTER; testing FORMAT_WRITE_RE against the whole string saw eslint's --fix
  // and treated prettier --check as write-enabled, false-PASSing the Agent-hooks
  // check (Prettier never rewrote the file). Inspect each formatter segment's
  // OWN flags: format counts when at least one formatter segment is not
  // check-only.
  const formatSatisfied = segments.some((seg) => {
    if (PM_SCRIPT_RE.test(seg) && segmentExecutes(seg, PM_KEYWORD_RE)) {
      // Package-manager script invocation (`npm/pnpm/yarn/bun [run] <script>`).
      // Resolve the BODY and classify THAT before requiring the invocation name
      // to look like a formatter: an arbitrarily named script (`npm run style`
      // whose body is `prettier --write .`) must still credit format, or the
      // Agent-hooks check false-MISSes and init/evolve append a duplicate hook.
      // `npm run format` whose body is `prettier --check .` is check-only
      // (prettier --check reports drift but never rewrites), so it must NOT
      // credit format-on-save. The body is classified recursively so a script
      // that chains to prettier --write (or --check) is followed all the way down.
      const body = resolveScriptBody(seg, scripts || {}, new Set(), workspaceScripts, byDir);
      if (body != null) return commandPurposes(body, scripts, workspaceScripts, byDir).includes("format");
      // Opaque (body unresolvable). `yarn prettier .` / `bun prettier .` (no
      // `run`) resolve the dependency binary DIRECTLY (implicit binary mode) when
      // no script matches, so the flags on the line are the real prettier flags:
      // prettier writes to stdout by default, so require an explicit write flag,
      // symmetric to the direct-binary path. npm/pnpm cannot do implicit binary,
      // and an explicit `run` always targets a package script, so those keep
      // opaque-trust (the write flag lives in the unseen body). (Codex P2 #3659302760)
      const opName = extractScriptName(seg);
      if (
        opName && FORMATTER_BINARY_NAME_RE.test(opName)
        && /\b(?:yarn|bun)\b/.test(seg) && !/\brun\b/.test(seg)
      ) {
        return FORMAT_WRITE_RE.test(seg) || SHORT_WRITE_FLAG_RE.test(seg);
      }
      // Generic script name (format/fmt/style): trust only when the invocation
      // name itself looks like a formatter, and then credit write unless it
      // signals check-only by name (`format:check`) or flag.
      return FORMAT_CMD_RE.test(seg) && !(FORMAT_CHECK_RE.test(seg) && !FORMAT_WRITE_RE.test(seg));
    }
    // Direct binary call: a formatter must be the EXECUTED command (not a bare
    // word in an argument like `cat prettier --write` / `node tool.js format
    // --write`) AND carry a write flag. prettier writes to stdout by default, so a
    // flag-less `prettier {}` leaves the file untouched and must not satisfy the
    // format-on-save promise.
    if (!segmentExecutes(seg, COMMAND_IS_FORMATTER_RE)) return false;
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
function detectHooksConfig(roots, scripts, workspaceScripts, dirScripts) {
  const primary = roots?.[0];
  const settings = primary ? readJson(path.join(primary, ".claude", "settings.json")) : null;
  const local = primary ? readJson(path.join(primary, ".claude", "settings.local.json")) : null;
  // Track per-tool purpose coverage so SEPARATE PostToolUse entries — one
  // matcher=Edit, another matcher=Write, each running lint+format — aggregate
  // correctly: both tools end up covered, instead of each entry being discarded
  // because its matcher covers only one tool (Codex P2 #3656618931). A purpose
  // is satisfied only when BOTH Edit and Write carry it, preserving the old
  // single-entry "matcher covers Edit|Write" semantics for the combined case.
  let editLint = false, writeLint = false, editFormat = false, writeFormat = false;
  // PostToolUse hooks and permissions.deny may each live in the shared
  // settings.json OR the gitignored settings.local.json — both are supported
  // Claude settings locations. Inspect both for hooks (as we already do for
  // deny) so a project keeping its hooks in settings.local.json isn't falsely
  // reported as missing Agent hooks and handed redundant init/evolve output.
  for (const file of [settings, local]) {
    const postTool = file?.hooks?.PostToolUse;
    const entries = Array.isArray(postTool) ? postTool : postTool ? [postTool] : [];
    for (const entry of entries) {
      const firesEdit = matcherFiresOn(entry?.matcher, "Edit");
      const firesWrite = matcherFiresOn(entry?.matcher, "Write");
      // Skip a matcher that fires on NEITHER edit tool (e.g. WebFetch) — it
      // carries no edit-time coverage. An empty matcher is a catch-all (fires on
      // every tool), honoring a no-explicit-matcher lint+format setup.
      if (!firesEdit && !firesWrite) continue;
      // Classify each hook command individually (not the joined blob): a single
      // wide matcher entry may carry a lint hook AND a format hook, and a
      // quoted status echo inside one command must not flip the other purpose.
      const purposes = new Set();
      for (const h of entry.hooks || []) {
        for (const purpose of commandPurposes(h?.command, scripts, workspaceScripts, dirScripts)) {
          purposes.add(purpose);
        }
      }
      if (firesEdit) {
        if (purposes.has("lint")) editLint = true;
        if (purposes.has("format")) editFormat = true;
      }
      if (firesWrite) {
        if (purposes.has("lint")) writeLint = true;
        if (purposes.has("format")) writeFormat = true;
      }
    }
  }
  const postToolUseLint = editLint && writeLint;
  const postToolUseFormat = editFormat && writeFormat;
  // Collect which irreversible-command families the existing deny entries block,
  // surfaced as recognition metadata in the report (which families are
  // represented). This is NOT the guard's PASS/MISS signal anymore: family-level
  // coverage was too coarse — one entry per family "covered" it while dangerous
  // within-family variants (dd of=/dev/ vs mkfs) stayed allowed, and a project
  // that LATER adds Prisma kept the always-on families satisfied while the
  // conditional SQL denies were never merged. The PASS/MISS decision now lives in
  // denyGuardIsComplete (entry-level: every scaffolded default present). Kept
  // here because it reads the same settings files and reports useful detail.
  // (Codex P1 #3660296403 / #3660483486 / #3660483492)
  const coveredDenyFamilies = new Set();
  for (const denyList of [settings?.permissions?.deny, local?.permissions?.deny]) {
    if (!Array.isArray(denyList)) continue;
    for (const d of denyList) {
      const fam = denyEntryFamily(d);
      if (fam) coveredDenyFamilies.add(fam);
    }
  }
  return { postToolUseLint, postToolUseFormat, editLint, writeLint, editFormat, writeFormat, coveredDenyFamilies: [...coveredDenyFamilies] };
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

// The flat command files `vca init`/`evolve` scaffold. Counting them would make a
// freshly-evolved non-Claude baseline look like a Claude project (see the
// "commands-only dir must NOT count" test), so they are excluded below.
const GENERATED_COMMAND_TOPS = new Set(["analytics", "init", "evolve", "steer"]);

/** A user-authored Claude Code slash command (`.claude/commands/<name>.md`) — one
 *  NOT generated by `vca init`/`evolve`. A custom command such as
 *  `.claude/commands/review.md` is a real signal the project uses Claude Code, so
 *  a project whose ONLY Claude artifact is a custom command still gets the hooks +
 *  deny-list checks (otherwise it was reported N/A). Nested commands
 *  (`.claude/commands/team/x.md`) are always user-authored; a flat command is
 *  excluded only when its name is one vca generates. */
function isUserAuthoredCommandPath(f) {
  const m = f.match(/(?:^|\/)\.claude\/commands\/(.+)$/i);
  if (!m || !m[1].endsWith(".md")) return false;
  const top = m[1].slice(0, -3);
  if (top.includes("/")) return true;           // nested command -> user-authored
  return !GENERATED_COMMAND_TOPS.has(top);       // flat -> excluded only if generated
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
    if (isUserAuthoredCommandPath(f)) return true;
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

/** Expand brace alternatives in a workspace glob so `{packages,apps}/*` resolves
 *  to BOTH `packages/*` and `apps/*` instead of being treated as a literal
 *  directory named `{packages,apps}`. npm (via its glob library) performs brace
 *  expansion on workspace patterns; without it, members under each alternative
 *  are invisible to readWorkspaceMemberPackages, a member-only
 *  prettier/eslint dependency is missed, and Agent hooks are wrongly reported
 *  N/A. Handles nested/multiple braces via recursion (cartesian product). Only
 *  the common comma-list form is expanded — ranges (`{1..5}`) and escaping are
 *  not used in real workspace declarations. (Codex P2 #3657507789) */
function expandBraces(pattern) {
  const s = String(pattern ?? "");
  const start = s.indexOf("{");
  if (start === -1) return [s];
  const end = s.indexOf("}", start);
  if (end === -1) return [s]; // unmatched brace: leave literal, do not drop it
  const prefix = s.slice(0, start);
  const body = s.slice(start + 1, end);
  const suffix = s.slice(end + 1);
  const out = [];
  for (const opt of body.split(",")) {
    for (const expanded of expandBraces(`${prefix}${opt}${suffix}`)) out.push(expanded);
  }
  return out;
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
/** Read the `packages` workspace globs from a root-level `pnpm-workspace.yaml`.
 *  pnpm declares workspace members HERE (not in package.json#workspaces), so
 *  without parsing it a pnpm monorepo's members are invisible to
 *  readWorkspaceMemberPackages and a DB dependency declared only in a member is
 *  missed by isDbProject (the SQL deny guards are then omitted). Only the
 *  top-level `packages:` list of glob strings is needed, so we parse the two
 *  common YAML shapes (block list and inline `[...]`) without a YAML dependency. */
function pnpmWorkspacePatterns(root) {
  let text;
  try {
    text = fs.readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  } catch {
    return [];
  }
  const clean = (v) => v.replace(/#.*$/, "").trim().replace(/^["']|["']$/g, "");
  const patterns = [];
  // Inline form: `packages: ['a', 'b']` / `packages: [a, b]`.
  const inline = text.match(/^packages\s*:\s*\[([^\]]*)\]/m);
  if (inline) {
    for (const part of inline[1].split(",")) {
      const v = clean(part);
      if (v) patterns.push(v);
    }
    return patterns;
  }
  // Block form: `packages:` followed by indented `- glob` items.
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!inPackages) {
      if (/^packages\s*:\s*$/.test(line)) inPackages = true;
      continue;
    }
    const item = line.match(/^\s*-\s+(.+)$/);
    if (item) {
      const v = clean(item[1]);
      if (v) patterns.push(v);
    } else if (line.trim() !== "" && !line.trim().startsWith("#") && /^\S/.test(line)) {
      break; // a dedented key marks the end of the packages list
    }
  }
  return patterns;
}

/** Read the DECLARED workspace members under `root` as `{ dir, pkg }` pairs by
 *  resolving each workspace pattern (npm `workspaces` or pnpm-workspace.yaml,
 *  brace-expanded, literal/`*`/`**`/partial-wildcard) to its concrete directories.
 *  Members without a manifest are skipped. Shared by dependency detection and
 *  script-map population so BOTH honor the same declaration boundary.
 *
 *  `!`-prefixed patterns are NEGATIONS applied in declaration order: npm workspaces
 *  (via the `glob` library) and pnpm `--filter` process `!pattern` to REMOVE
 *  previously-included members, so `["packages/*", "!packages/b"]` yields packages/a
 *  but NOT packages/b. Without this, the excluded member stays indexed and a
 *  `npm --workspace b` selector resolves its script (false PASS) when npm itself
 *  errors "No workspaces found". The negation glob (after stripping `!`) is resolved
 *  the same way as an inclusion glob and DELETED from the accumulated set.
 *  (Codex P2 #3660108928) */
function readDeclaredWorkspaceMembers(root, pkg) {
  const patterns = [...workspacePatterns(pkg), ...pnpmWorkspacePatterns(root)];
  const included = new Set();
  for (const pat of patterns) {
    const raw = String(pat).trim();
    const isNeg = raw.startsWith("!");
    const glob = isNeg ? raw.slice(1).trim() : raw;
    if (!glob) continue;
    for (const p of expandBraces(glob)) {
      const t = p.trim();
      if (!t) continue;
      for (const dir of resolveWorkspacePattern(root, t)) {
        if (isNeg) included.delete(dir);
        else included.add(dir);
      }
    }
  }
  const members = [];
  for (const dir of included) {
    const memberPkg = readJson(path.join(dir, "package.json"));
    if (memberPkg) members.push({ dir, pkg: memberPkg });
  }
  return members;
}

function readWorkspaceMemberPackages(root, pkg) {
  return readDeclaredWorkspaceMembers(root, pkg).map((m) => m.pkg);
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
export function defaultDenyList(report) {
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
    // Git also accepts the force flag BETWEEN the repository and a later refspec
    // — e.g. `git push origin --force main` — which neither the prefix entries
    // above nor the trailing-flag entries catch (`* --force` requires the flag to
    // END the command, so a trailing refspec defeats it). A trailing `*` permits
    // the refspec that follows the flag, closing the bypass. (Codex P1 #3656425150)
    "Bash(git push * --force *)",
    "Bash(git push * -f *)",
    // Clustered short-flag force: Git accepts `git push -qf origin main`
    // (quiet+force) and `git push -fq origin main`, but Claude Code literal globs
    // need each spelling — `git push -f:*` does not start with `git push -qf`, and
    // `git push * -f` needs a standalone `-f` token. Cover the common quiet+force
    // cluster (`-qf`/`-fq`) in all three flag positions (first / after refspec /
    // between repo and refspec). Other clusters (`-vf`, 3+ flags) remain a
    // literal-matching limitation, same as the rm clusters above. (Codex P1 #3663668182)
    "Bash(git push -qf:*)",
    "Bash(git push -fq:*)",
    "Bash(git push * -qf)",
    "Bash(git push * -fq)",
    "Bash(git push * -qf *)",
    "Bash(git push * -fq *)",
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
    // sudo-wrapped device writes: Claude Code prefix-matches the LITERAL spelling,
    // so `Bash(mkfs:*)` does NOT block `sudo mkfs.ext4 /dev/sda` (it does not start
    // with `mkfs`). Only `sudo rm` had a sudo variant, so `sudo mkfs` / `sudo dd
    // of=/dev/` could destroy a disk while denyGuardIsComplete still reported the
    // guard complete. Emit sudo-wrapped variants so the scaffold blocks the
    // privileged form too; denyEntryFamily strips a leading `sudo`, so these still
    // classify as the device-write family. (Codex P1 #3663963739)
    "Bash(sudo mkfs:*)",
    "Bash(sudo dd of=/dev/:*)",
    "Bash(sudo dd * of=/dev/:*)",
    "Bash(> /dev/sd:*)",
    "Bash(:> *)",
    // Pipe-to-shell download-and-execute. Claude Code treats the space in a Bash
    // pattern as LITERAL, and `*` as the only wildcard — so `curl * | sh` requires
    // a space on BOTH sides of `|`. The compact `curl http://x|sh` (no spaces) and
    // `curl http://x |sh` (one space) bypass it, defeating the deny entry. The
    // detector regex (DANGEROUS_CMD_RE) is spacing-insensitive via `\s*`, but the
    // SCAFFOLDED deny list is what actually protects the user. Emit both forms per
    // source×shell: `*|sh` also covers `X |sh` (`*` eats the trailing space) and
    // `*| sh` also covers `X | sh` (same), so 8 entries close all four spacings.
    // (Codex P1 #3657507768)
    "Bash(curl *|sh)",
    "Bash(curl *| sh)",
    "Bash(curl *|bash)",
    "Bash(curl *| bash)",
    "Bash(wget *|sh)",
    "Bash(wget *| sh)",
    "Bash(wget *|bash)",
    "Bash(wget *| bash)",
  ];
  if (isDbProject(report)) {
    deny.push(
      // Destructive SQL reaches the DB through a CLIENT (`psql -c`, `mysql -e`),
      // never as a bare shell command. A literal-prefix `Bash(DROP TABLE:*)` only
      // blocks a nonexistent executable named DROP, so the real
      // `psql -c 'DROP TABLE users'` slipped past the deny into the weaker `ask`
      // rules and could be blind-approved into irreversible data loss. Match the
      // keyword INSIDE the client invocation instead: `*` is Claude Code's only
      // wildcard and spans arguments (same mechanism as `git push * --force` /
      // `dd * of=/dev/:*`), and there is no space between `*` and `-c` so a single
      // entry catches `-c` whether it is the first arg (`psql -c '…'`) or follows
      // connection options (`psql -d prod -c '…'` — `*` eats the intervening args).
      // deny takes precedence over ask, so a destructive `psql -c 'DROP TABLE x'`
      // is HARD-denied while a safe `psql -c 'SELECT 1'` (no keyword) still routes
      // through `ask` (defaultAskList). `-f` (file) can't be inspected and stays
      // ask-only. (Codex P1 #3660903603; ask routing is Codex P2 #3659221996 /
      // #3656905061; denyEntryFamily still classifies these via the psql/mysql
      // execute-flag regexes.)
      // SQL keywords are case-insensitive, but Claude Code deny patterns match
      // LITERALLY (case-sensitive), so an uppercase-only entry is bypassed by
      // `psql -c 'drop table users'`. Emit BOTH uppercase (the convention agents
      // follow) and lowercase (casual typing / generated SQL) for each keyword.
      // Exhaustive mixed-case coverage is impossible with static literal globs;
      // the `ask` routing remains the case-insensitive backstop prompting on ANY
      // psql -c / mysql -e. (Codex P1 #3663410485.)
      "Bash(psql *-c *DROP TABLE*)", "Bash(psql *-c *drop table*)",
      "Bash(psql *-c *DROP DATABASE*)", "Bash(psql *-c *drop database*)",
      "Bash(psql *-c *TRUNCATE*)", "Bash(psql *-c *truncate*)",
      "Bash(mysql *-e *DROP TABLE*)", "Bash(mysql *-e *drop table*)",
      "Bash(mysql *-e *DROP DATABASE*)", "Bash(mysql *-e *drop database*)",
      "Bash(mysql *-e *TRUNCATE*)", "Bash(mysql *-e *truncate*)",
      // prisma migrate reset drops & recreates the dev database irreversibly. It
      // runs through ANY package manager's runner, each prefixing the command
      // differently and so bypassing a single `prisma …` / `npx prisma …` pair.
      // A `*` between the runner and `prisma` spans the manager's subcommand
      // (`pnpm exec`, `pnpm dlx`, `yarn exec`, `yarn run`). (Codex P1 #3663410490.)
      "Bash(prisma migrate reset:*)",
      "Bash(npx prisma migrate reset:*)",
      "Bash(pnpm *prisma migrate reset:*)",
      "Bash(yarn *prisma migrate reset:*)",
      "Bash(bunx *prisma migrate reset:*)",
      "Bash(bun *prisma migrate reset:*)",
    );
  }
  return deny;
}

/** The dangerous-command guard is COMPLETE only when EVERY entry the scaffolder
 *  emits (defaultDenyList) is already present in settings.json ∪
 *  settings.local.json. Family-level coverage was too coarse: a list with one
 *  representative per family (e.g. only `Bash(mkfs:*)` for device-write) marked
 *  the family "covered" while `dd of=/dev/sda` stayed allowed, and a project that
 *  LATER adds Prisma/Drizzle kept the always-on families satisfied while the
 *  conditional SQL denies (DROP/TRUNCATE/prisma migrate reset) were never merged.
 *  Comparing against the exact scaffolded defaults closes both gaps, because the
 *  default set itself grows the moment isDbProject becomes true. (Codex P1
 *  #3660483486 / #3660483492) */
export function denyGuardIsComplete(report) {
  const defaults = defaultDenyList(report);
  const primary = report.roots?.[0];
  const settings = primary ? readJson(path.join(primary, ".claude", "settings.json")) : null;
  const local = primary ? readJson(path.join(primary, ".claude", "settings.local.json")) : null;
  const existing = new Set();
  for (const denyList of [settings?.permissions?.deny, local?.permissions?.deny]) {
    if (!Array.isArray(denyList)) continue;
    for (const entry of denyList) existing.add(String(entry).trim());
  }
  return defaults.every((entry) => existing.has(entry));
}

/** Broad SQL-CLIENT invocations (psql -c/-f, mysql -e) run ARBITRARY SQL — a safe
 *  `psql -c 'SELECT 1'` and a destructive `psql -c 'DROP TABLE users'` are
 *  indistinguishable to a prefix matcher — so hard-denying them (as vca
 *  previously did) blocked routine inspection and non-destructive scripts after
 *  init/evolve, contradicting the guard's "irreversible commands" framing. Route
 *  them through `ask` instead: Claude Code prompts before running them, so safe
 *  queries proceed (user approves) while destructive SQL surfaces for an explicit
 *  decision. Emitted ONLY for detected database projects, alongside the
 *  destructive-keyword denies. (Codex P2 #3659221996 / #3656905061) */
function defaultAskList(report) {
  if (!isDbProject(report)) return [];
  return [
    "Bash(psql -c:*)",
    "Bash(psql -f:*)",
    "Bash(mysql -e:*)",
    // An execute flag placed AFTER connection options — `psql -d prod -c '...'`,
    // `mysql -h host -e '...'` — is not caught by the prefix-only entries above
    // (Claude Code matches `Bash(psql -c:*)` as a literal prefix), so the
    // after-options form is emitted too. A lone `*` spans the preceding arguments
    // (same mechanism as `git push * --force`), prompting on the execute flag in
    // either position.
    "Bash(psql * -c:*)",
    "Bash(psql * -f:*)",
    "Bash(mysql * -e:*)",
  ];
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

/** Whether ESLint has a ROOT-APPLICABLE runnable config in this project. The
 *  scaffolded eslint hook runs `eslint <file>` from the PRIMARY ROOT on every
 *  edited file. ESLint flat config (eslint.config.*, ESLint 9+) resolves from
 *  CWD (the root), NOT recursively into subdirs, and legacy .eslintrc cascades
 *  DOWN from where it sits — so a config living ONLY in a workspace member does
 *  NOT apply to root files or sibling packages. With NO root-applicable config,
 *  `eslint <root-file>` errors ("couldn't find an eslint.config.(js|mjs|cjs)
 *  file"), exits 2, and the scaffolded PostToolUse `|| exit 2` promotes that
 *  config error into a BLOCKING hook on every non-member edit. Require a
 *  ROOT-LEVEL config file (no path separator) or the ROOT package.json
 *  `eslintConfig` field; do NOT credit configs or inline fields that live only in
 *  a workspace member. Prettier needs no gate: it ships sane defaults and runs
 *  without a config. (Codex P1 #3659665368; root-scope tightening #3660108918) */
function hasEslintConfig(report) {
  const ESLINT_CONFIG_RE = /(?:^|\/)(?:eslint\.config\.(?:js|mjs|cjs|ts|mts|cts)|\.eslintrc(?:\.js|\.cjs|\.mjs|\.json|\.ya?ml)?)$/i;
  // TS flat configs (eslint.config.ts/.mts/.cts) are NOT natively loadable by ESLint;
  // ESLint 9.10+ resolves them via jiti. Without jiti installed, `eslint <file>`
  // errors ("Cannot find module 'jiti'") and the scaffolded PostToolUse `|| exit 2`
  // would block every edit. Only credit a TS config when jiti is resolvable.
  // JS/legacy configs always run. (Codex P1 #3663668184)
  const ESLINT_TS_CONFIG_RE = /(?:^|\/)eslint\.config\.(?:ts|mts|cts)$/i;
  const jitiResolvable = canResolveJiti(report);
  if (report.files) {
    for (const f of report.files) {
      // Root-level only: a config under a workspace member does NOT apply to root
      // or sibling-package files, so a root-level scaffolded eslint hook would error
      // (exit 2 -> blocking) on every non-member edit. File paths are relative with
      // `/` separators, so a root-level file has no separator. (Codex P1 #3660108918)
      if (f.includes("/") || !ESLINT_CONFIG_RE.test(f)) continue;
      // TS flat config without jiti would error at runtime — skip it and keep
      // scanning for a JS/legacy config that actually runs. (Codex P1 #3663668184)
      if (ESLINT_TS_CONFIG_RE.test(f) && !jitiResolvable) continue;
      return true;
    }
  }
  // Root inline `eslintConfig` only — member inline configs are out of scope for the
  // same reason (a root hook cannot use them). (Codex P1 #3660108918)
  if (Boolean(report.packageJson?.eslintConfig)) return true;
  return false;
}

/** Whether ESLint can resolve jiti at runtime, which is required to load a TS flat
 *  config (eslint.config.ts/.mts/.cts). jiti is resolvable when it is declared as a
 *  dependency OR physically present in the root node_modules (npm/yarn hoist
 *  transitive jiti; pnpm without hoisting does not, which is the correct
 *  conservative answer). Failure-safe: when in doubt, returns false so a TS config
 *  is NOT credited and the lint hook is not scaffolded (no blocking hook). (Codex
 *  P1 #3663668184) */
function canResolveJiti(report) {
  const deps = report.packageJson?.dependencies || {};
  const devDeps = report.packageJson?.devDependencies || {};
  if (deps.jiti || devDeps.jiti) return true;
  if (report.cwd) {
    try {
      if (fs.existsSync(path.join(report.cwd, "node_modules", "jiti", "package.json"))) return true;
    } catch {
      // fs access errors are conservative: treat jiti as unresolvable.
    }
  }
  return false;
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
  const { postToolUseLint, postToolUseFormat, editLint, writeLint, editFormat, writeFormat } = detectHooksConfig(roots, report.scripts, report.workspaceScripts, report.dirScripts);
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
  // Each tool is emitted with ONLY the purpose(s) it is still missing, so a tool
  // already running a writer (prettier) never receives a SECOND writer in parallel
  // — two --write hooks matching the same tool race on the same file. The earlier
  // combined branch (#3656905057) scoped ONE matcher to every tool needing
  // *anything*, but that matcher still carried prettier into a tool that only
  // lacked eslint, racing two formatters on Edit (#3657032372). Splitting per
  // (tool, purpose) closes that gap: a tool needing BOTH still gets one combined
  // command (prettier THEN eslint, see below), while a tool needing one purpose
  // gets just that purpose, on its own matcher.
  const commandForGap = (needFormat, needLint) => {
    if (needFormat && needLint) {
      return `${HOOK_READ_PATH} | xargs -0 -I{} sh -c '${exec} prettier --write --ignore-unknown "$1" && ${exec} eslint --no-warn-ignored "$1" 1>&2' _ {} || exit 2`;
    }
    if (needFormat) {
      return `${HOOK_READ_PATH} | xargs -0 -I{} ${exec} prettier --write --ignore-unknown {}`;
    }
    if (needLint) {
      return `${HOOK_READ_PATH} | xargs -0 -I{} ${exec} eslint --no-warn-ignored {} 1>&2 || exit 2`;
    }
    return null;
  };
  // ESLint with no config errors (exit 2) and would block every edit, so the lint
  // half is gated on a runnable config — `eslintReady`. Prettier is ungated (it
  // runs on built-in defaults). When eslint is not ready, a combined gap degrades
  // to prettier-only and a lint-only gap emits nothing. (Codex P1 #3659665368)
  const eslintReady = hasEslintConfig(report);
  const editCmd = commandForGap(!editFormat, !editLint && eslintReady);
  const writeCmd = commandForGap(!writeFormat, !writeLint && eslintReady);
  const entries = [];
  if (editCmd && writeCmd && editCmd === writeCmd) {
    // Both tools share the IDENTICAL gap (common fresh setup, both missing both):
    // one Edit|Write entry avoids duplicating the same command in two entries.
    entries.push({ matcher: "Edit|Write", hooks: [{ type: "command", command: editCmd }] });
  } else {
    if (editCmd) entries.push({ matcher: "Edit", hooks: [{ type: "command", command: editCmd }] });
    if (writeCmd) entries.push({ matcher: "Write", hooks: [{ type: "command", command: writeCmd }] });
  }
  // At least one tool must have a gap (the early return above guarantees at least
  // one postToolUse flag is false), so entries is non-empty. Guard regardless: an
  // empty matcher is a CATCH-ALL in Claude Code (fires after Read/Bash/etc., whose
  // payload carries no file_path).
  if (!entries.length) return null;
  const config = { hooks: { PostToolUse: entries } };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Claude Code settings.local.json with a deny list of irreversible commands and
 *  an `ask` list of broad invocations that MIGHT be destructive (prompt rather
 *  than hard-block). */
function claudePermissionsLocal(report) {
  const config = { permissions: { allow: [], ask: defaultAskList(report), deny: defaultDenyList(report) } };
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
  // package manager declared by the workspace root. The cwd manifest was already
  // checked via the packageJson argument above; for ANCESTOR directories also
  // consult their package.json `packageManager` field — a Yarn Berry/PnP root may
  // declare it without a lockfile at every level, and without this lookup the
  // member falls back to npm and generates `npx` hooks that cannot resolve PnP
  // dependencies. (Codex P2 #3656618937)
  let dir = cwd;
  while (true) {
    if (dir !== cwd) {
      const ancestorPkg = readJson(path.join(dir, "package.json"));
      if (ancestorPkg && ancestorPkg.packageManager) {
        const pm = String(ancestorPkg.packageManager).split("@")[0].trim();
        if (pm === "npm" || pm === "pnpm" || pm === "yarn" || pm === "bun") return pm;
      }
    }
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
  // is tool-agnostic and valuable for any Claude project — but it is SKIPPED only
  // when a COMPLETE dangerous-command guard (every always-on family) is already
  // detected in either settings file. A PARTIAL list (e.g. only `Bash(mkfs:*)`)
  // does NOT skip: mergePermissionsLocal unions the missing default families in,
  // so rm -rf / force-push / hard-reset / git-clean / pipe-to-shell get blocked.
  // (Codex P1 #3660296403)
  if (isClaudeCodeProject(report.files)) {
    if (!denyGuardIsComplete(report)) {
      files.push(file(".claude/settings.local.json", claudePermissionsLocal(report), mergePermissionsLocal));
    }
    const hooksContent = claudeHooksSettings(report);
    if (hooksContent) files.push(file(".claude/settings.json", hooksContent, (existing, incoming) => mergeHooksSettings(existing, incoming, report.scripts, report.workspaceScripts, report.dirScripts)));
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
  // deny list is skipped only when a COMPLETE guard (every always-on family) is
  // already present; a partial list is unioned with the missing defaults instead
  // of being treated as sufficient. (Codex P1 #3660296403)
  if (isClaudeCodeProject(report.files)) {
    if (!denyGuardIsComplete(report)) {
      files.push(file(".claude/settings.local.json", claudePermissionsLocal(report), mergePermissionsLocal));
    }
    const hooksContent = claudeHooksSettings(report);
    if (hooksContent) files.push(file(".claude/settings.json", hooksContent, (existing, incoming) => mergeHooksSettings(existing, incoming, report.scripts, report.workspaceScripts, report.dirScripts)));
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
function mergeHooksSettings(existingContent, incomingContent, scripts, workspaceScripts, dirScripts) {
  const existing = JSON.parse(existingContent);
  const incoming = JSON.parse(incomingContent);
  existing.hooks ??= {};
  existing.hooks.PostToolUse ??= [];
  for (const entry of incoming.hooks?.PostToolUse || []) {
    // Merge into an existing entry only when the scopes are COMPATIBLE. The
    // scaffold can emit a NARROWER matcher (e.g. "Write" alone) when one tool
    // already has a purpose; merging that into a broader Edit|Write entry would
    // broaden the scope so the OTHER tool (Edit) runs the new hook too — e.g. an
    // existing Edit-only formatter + an Edit|Write linter, with the scaffold
    // backfilling a Write formatter, would have it merged into Edit|Write and
    // Edit would then run two formatters in parallel. A broad Edit|Write incoming
    // entry still merges into a matching Edit|Write existing entry (dedup); a
    // narrower incoming entry merges only into an existing entry of the SAME
    // scope, else is appended untouched. (Codex P2 #3657507781)
    const incomingEditWrite = matcherIsEditWriteEntry(entry.matcher);
    const idx = existing.hooks.PostToolUse.findIndex((e) =>
      incomingEditWrite ? matcherIsEditWriteEntry(e.matcher) : (e.matcher || "") === (entry.matcher || ""),
    );
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
        for (const purpose of commandPurposes(h?.command, scripts, workspaceScripts, dirScripts)) coveredPurposes.add(purpose);
      }
      for (const h of entry.hooks || []) {
        if (!h?.command || knownCmds.has(h.command)) continue;
        // A combined command (e.g. `npm run lint && npm run format`) carries
        // multiple purposes; only skip it when EVERY purpose it serves is
        // already covered, otherwise an uncovered purpose would go unscaffolded.
        const purposes = commandPurposes(h.command, scripts, workspaceScripts, dirScripts);
        if (purposes.length && purposes.every((p) => coveredPurposes.has(p))) continue;
        existingEntry.hooks.push(h);
        knownCmds.add(h.command);
        for (const p of purposes) coveredPurposes.add(p);
      }
    }
  }
  return `${JSON.stringify(existing, null, 2)}\n`;
}

/** Merge the deny/ask lists into an existing settings.local.json without
 *  clobbering existing allow entries. Unions the deny AND ask arrays (preserving
 *  any user-authored rules in both), dedupes entries. */
function mergePermissionsLocal(existingContent, incomingContent) {
  const existing = JSON.parse(existingContent);
  const incoming = JSON.parse(incomingContent);
  existing.permissions ??= {};
  existing.permissions.deny ??= [];
  const set = new Set(existing.permissions.deny);
  for (const d of incoming.permissions?.deny || []) set.add(d);
  existing.permissions.deny = [...set];
  // Union `ask` entries (broad SQL-client prompts) the same way, so evolve keeps
  // them alongside the deny list without dropping user-authored ask rules.
  // (Codex P2 #3659221996)
  existing.permissions.ask ??= [];
  const askSet = new Set(existing.permissions.ask);
  for (const a of incoming.permissions?.ask || []) askSet.add(a);
  existing.permissions.ask = [...askSet];
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
