import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execSync } from "node:child_process";
import assert from "node:assert/strict";
import { analyzeForTest, runCli, buildEvolutionPlan, printEvolution, printReport } from "../src/cli.js";

test("analyzes an empty project with missing harness areas", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-empty-"));
  const report = analyzeForTest(dir);
  assert.equal(report.score < 50, true);
  assert.equal(report.checks.some((item) => !item.ok && item.area === "Agent instructions"), true);
});

test("init --write creates baseline harness files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-init-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "sample", scripts: {} }));
  await runCli(["init", "--cwd", dir, "--write"]);
  assert.equal(fs.existsSync(path.join(dir, "AGENTS.md")), true);
  assert.equal(fs.existsSync(path.join(dir, ".claude/commands/evolve.md")), true);
  assert.equal(fs.existsSync(path.join(dir, "docs/knowledge-base/constraints.md")), true);
});

test("detects harness across git submodules and fractal CLAUDE.md", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-mono-"));
  fs.mkdirSync(path.join(dir, "backend", "tests", "unit"), { recursive: true });
  fs.writeFileSync(path.join(dir, "backend", "tests", "unit", "auth_test.go"), "package unit");
  fs.writeFileSync(path.join(dir, "backend", "Makefile"), "test:\n\tgo test ./...\n");
  fs.writeFileSync(path.join(dir, "backend", "go.mod"), "module backend\n");
  fs.writeFileSync(path.join(dir, "backend", "CLAUDE.md"), "# backend");
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# root");
  fs.writeFileSync(
    path.join(dir, ".gitmodules"),
    '[submodule "backend"]\n\tpath = backend\n\turl = https://example.com/b.git\n',
  );
  fs.mkdirSync(path.join(dir, ".claude", "skills", "review"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "skills", "review", "SKILL.md"), "reviewer skill");
  fs.mkdirSync(path.join(dir, "flutter", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "flutter", "scripts", "verify_16kb.ps1"), "# verify");

  const report = analyzeForTest(dir);
  assert.equal(report.shape, "git submodule monorepo");
  const pass = new Set(report.checks.filter((c) => c.ok).map((c) => c.area));
  assert.ok(pass.has("Project facts"), "facts via CLAUDE.md");
  assert.ok(pass.has("Agent instructions"), "agent instructions via CLAUDE.md");
  assert.ok(pass.has("Tests"), "tests via backend tests/");
  assert.ok(pass.has("Typecheck"), "typecheck via go.mod");
  assert.ok(pass.has("Project memory"), "memory via fractal CLAUDE.md");
  assert.ok(pass.has("Reusable skills"), "skills via .claude/skills/");
  assert.ok(pass.has("Specialist reviewers"), "reviewers via review skill");
  assert.ok(pass.has("Architecture sensors"), "sensors via flutter/scripts/verify_16kb.ps1");
  assert.ok(report.score >= 50, `score ${report.score} should be >= 50`);
});

test("detects typecheck config in npm workspace subpackages", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-ws-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "ws-root", workspaces: ["packages/*"] }),
  );
  fs.mkdirSync(path.join(dir, "packages", "app"), { recursive: true });
  // Workspace package has a tsconfig but no typecheck/lint script — previously
  // missed because workspace dirs are never added to `roots`, so the per-root
  // exact-basename lookup never sees packages/app/tsconfig.json.
  fs.writeFileSync(
    path.join(dir, "packages", "app", "package.json"),
    JSON.stringify({ name: "app", scripts: {} }),
  );
  fs.writeFileSync(path.join(dir, "packages", "app", "tsconfig.json"), "{}\n");
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# ws");

  const report = analyzeForTest(dir);
  assert.equal(report.shape, "npm workspaces monorepo");
  const typecheck = report.checks.find((c) => c.area === "Typecheck");
  assert.ok(typecheck && typecheck.ok, "typecheck via packages/app/tsconfig.json");
});

test("detects root-level plugin agents as specialist reviewers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-plugin-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "p" }));
  fs.mkdirSync(path.join(dir, ".claude", "plugins", "security", "agents"), { recursive: true });
  // Root-level plugin layout: listFiles yields a relative path with no leading
  // slash, so the old `file.includes("/.claude/plugins/")` never matched it.
  fs.writeFileSync(
    path.join(dir, ".claude", "plugins", "security", "agents", "reviewer.md"),
    "# security reviewer",
  );
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# p");

  const report = analyzeForTest(dir);
  const reviewers = report.checks.find((c) => c.area === "Specialist reviewers");
  assert.ok(reviewers && reviewers.ok, "reviewers via root-level .claude/plugins/.../agents/");
});

test("detects typecheck config in a deeply-nested git submodule", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-deep-"));
  // Submodule nested deeper than the listFiles(cwd, 7) full-tree walk can reach,
  // so a pure countBasename(allFiles) scan misses it. The per-root hasAt walk
  // (listFiles(submoduleRoot, 5)) is the only thing that reaches the submodule's
  // own go.mod — so both scans must be kept.
  const deep = path.join(dir, "a", "b", "c", "d", "e", "f", "g", "h", "dep");
  fs.mkdirSync(deep, { recursive: true });
  fs.writeFileSync(path.join(deep, "go.mod"), "module dep\n");
  fs.writeFileSync(
    path.join(dir, ".gitmodules"),
    '[submodule "dep"]\n\tpath = a/b/c/d/e/f/g/h/dep\n\turl = https://example.com/dep.git\n',
  );
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# deep");

  const report = analyzeForTest(dir);
  assert.equal(report.shape, "git submodule monorepo");
  const typecheck = report.checks.find((c) => c.area === "Typecheck");
  assert.ok(typecheck && typecheck.ok, "typecheck via deeply-nested submodule go.mod");
});

test("deploy hooks detected via scripts, workflows, and skills", () => {
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-deploy-script-"));
  fs.writeFileSync(
    path.join(scriptDir, "package.json"),
    JSON.stringify({ name: "a", scripts: { deploy: "wrangler pages deploy" } }),
  );
  fs.writeFileSync(path.join(scriptDir, "CLAUDE.md"), "# a");
  let r = analyzeForTest(scriptDir);
  assert.ok(r.checks.find((c) => c.area === "Deploy hooks")?.ok, "deploy via package script");

  const wfDir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-deploy-wf-"));
  fs.mkdirSync(path.join(wfDir, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(wfDir, ".github", "workflows", "deploy.yml"), "on: push\n");
  fs.writeFileSync(path.join(wfDir, "CLAUDE.md"), "# b");
  r = analyzeForTest(wfDir);
  assert.ok(r.checks.find((c) => c.area === "Deploy hooks")?.ok, "deploy via workflow file");

  const skillDir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-deploy-skill-"));
  fs.mkdirSync(path.join(skillDir, ".claude", "skills", "deploy-production"), { recursive: true });
  fs.writeFileSync(path.join(skillDir, ".claude", "skills", "deploy-production", "SKILL.md"), "deploy");
  fs.writeFileSync(path.join(skillDir, "CLAUDE.md"), "# c");
  r = analyzeForTest(skillDir);
  assert.ok(r.checks.find((c) => c.area === "Deploy hooks")?.ok, "deploy via skill");
});

test("rule sensors require computational enforcement when prose rules exist", () => {
  const proseOnly = fs.mkdtempSync(path.join(os.tmpdir(), "vca-prose-only-"));
  fs.writeFileSync(path.join(proseOnly, "package.json"), JSON.stringify({ name: "only", scripts: {} }));
  fs.writeFileSync(path.join(proseOnly, "CLAUDE.md"), "# only\n## Rules\n- do good things\n");
  let r = analyzeForTest(proseOnly);
  const miss = r.checks.find((c) => c.area === "Rule sensors");
  assert.ok(miss && !miss.ok, "prose-only rules with no tests/lint/validators should MISS");

  const withTests = fs.mkdtempSync(path.join(os.tmpdir(), "vca-prose-tests-"));
  fs.writeFileSync(path.join(withTests, "package.json"), JSON.stringify({ name: "wt", scripts: {} }));
  fs.writeFileSync(path.join(withTests, "CLAUDE.md"), "# wt");
  fs.writeFileSync(path.join(withTests, "app.test.js"), "test('x', () => {})");
  r = analyzeForTest(withTests);
  assert.ok(r.checks.find((c) => c.area === "Rule sensors")?.ok, "rules + tests should PASS");

  const withLint = fs.mkdtempSync(path.join(os.tmpdir(), "vca-prose-lint-"));
  fs.writeFileSync(
    path.join(withLint, "package.json"),
    JSON.stringify({ name: "wl", scripts: { lint: "eslint ." } }),
  );
  fs.writeFileSync(path.join(withLint, "CLAUDE.md"), "# wl");
  r = analyzeForTest(withLint);
  assert.ok(r.checks.find((c) => c.area === "Rule sensors")?.ok, "rules + lint script should PASS");
});

test("failure observability detected via monitor/alert/health files", () => {
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-obs-script-"));
  fs.writeFileSync(path.join(scriptDir, "package.json"), JSON.stringify({ name: "a" }));
  fs.mkdirSync(path.join(scriptDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(scriptDir, "scripts", "monitor-payments.js"), "monitor");
  fs.writeFileSync(path.join(scriptDir, "CLAUDE.md"), "# a");
  let r = analyzeForTest(scriptDir);
  assert.ok(
    r.checks.find((c) => c.area === "Failure observability")?.ok,
    "observability via monitor script",
  );

  const wfDir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-obs-wf-"));
  fs.mkdirSync(path.join(wfDir, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(wfDir, ".github", "workflows", "health-check.yml"), "on: schedule\n");
  fs.writeFileSync(path.join(wfDir, "CLAUDE.md"), "# b");
  r = analyzeForTest(wfDir);
  assert.ok(
    r.checks.find((c) => c.area === "Failure observability")?.ok,
    "observability via health workflow",
  );
});

test("cross-session memory detected via decisions, ADR, or agent memory", () => {
  const adrDir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-mem-adr-"));
  fs.writeFileSync(path.join(adrDir, "package.json"), JSON.stringify({ name: "a" }));
  fs.mkdirSync(path.join(adrDir, "docs", "decisions"), { recursive: true });
  fs.writeFileSync(path.join(adrDir, "docs", "decisions", "0001-use-x.md"), "# ADR 1");
  fs.writeFileSync(path.join(adrDir, "CLAUDE.md"), "# a");
  let r = analyzeForTest(adrDir);
  assert.ok(
    r.checks.find((c) => c.area === "Cross-session memory")?.ok,
    "memory via docs/decisions ADR",
  );

  const agentMemDir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-mem-agent-"));
  fs.mkdirSync(path.join(agentMemDir, ".claude", "memory"), { recursive: true });
  fs.writeFileSync(path.join(agentMemDir, ".claude", "memory", "context.md"), "memory");
  fs.writeFileSync(path.join(agentMemDir, "CLAUDE.md"), "# b");
  r = analyzeForTest(agentMemDir);
  assert.ok(
    r.checks.find((c) => c.area === "Cross-session memory")?.ok,
    "memory via .claude/memory",
  );
});

// ---- PR #6 codex P2: namespaced deploy, validate/ci as rule sensor, submodule deploy + decisions ----

test("deploy hooks pass for namespaced deploy:prod / release:canary scripts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-depns-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "x", scripts: { "deploy:prod": "wrangler pages deploy", "release:canary": "tb" } }),
  );
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# x");
  const report = analyzeForTest(dir);
  const deploy = report.checks.find((c) => c.area === "Deploy hooks");
  assert.ok(deploy && deploy.ok, "namespaced deploy:prod / release:canary must satisfy Deploy hooks");
});

test("rule sensors pass for a validate/ci script backing prose rules", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-ruleval-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "x", scripts: { validate: "node --test", ci: "node --test" } }),
  );
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# x rules");
  // No test files, no lint/typecheck script -- the only sensor is `validate`/`ci`.
  const report = analyzeForTest(dir);
  const sensors = report.checks.find((c) => c.area === "Rule sensors");
  assert.ok(sensors && sensors.ok, "scripts.validate / scripts.ci must count as a rule sensor");
});

test("deploy hooks pass when a deploy workflow lives in a deep git submodule", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-deepdep-"));
  // Submodule nested deeper than listFiles(cwd, 7) reaches, so allFiles misses it;
  // only the per-root filesByRoot scan sees the submodule's deploy workflow.
  const sub = path.join(dir, "a", "b", "c", "d", "e", "f", "g", "h", "svc");
  fs.mkdirSync(path.join(sub, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(sub, ".github", "workflows", "deploy.yml"), "on: push\n");
  fs.writeFileSync(
    path.join(dir, ".gitmodules"),
    '[submodule "svc"]\n\tpath = a/b/c/d/e/f/g/h/svc\n\turl = https://example.com/s.git\n',
  );
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# deep");
  const report = analyzeForTest(dir);
  const deploy = report.checks.find((c) => c.area === "Deploy hooks");
  assert.ok(deploy && deploy.ok, "deploy workflow in a deep submodule must be detected");
});

test("cross-session memory detected for decisions under a submodule root", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-submem-"));
  fs.mkdirSync(path.join(dir, "backend", "docs", "decisions"), { recursive: true });
  fs.writeFileSync(path.join(dir, "backend", "docs", "decisions", "0001-use-x.md"), "# adr\n");
  fs.writeFileSync(path.join(dir, "backend", "go.mod"), "module backend\n");
  fs.writeFileSync(
    path.join(dir, ".gitmodules"),
    '[submodule "backend"]\n\tpath = backend\n\turl = https://example.com/b.git\n',
  );
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# root");
  const report = analyzeForTest(dir);
  const mem = report.checks.find((c) => c.area === "Cross-session memory");
  assert.ok(mem && mem.ok, "backend/docs/decisions/ under a submodule must count as memory");
});

// ---- evolve: analytics gaps -> concrete promotion plan + git fix hotspots ----

test("evolve maps each missing harness area to a concrete promotion target", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-evolve-gap-"));
  // No CLAUDE.md, no tests, no CI => many gaps; and not a git repo.
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo" }));
  const report = analyzeForTest(dir);
  const plan = buildEvolutionPlan(report);
  assert.ok(plan.recommendations.length > 0, "should recommend promotions for gaps");
  const areas = plan.recommendations.map((r) => r.area);
  assert.ok(areas.includes("Tests"), "Tests gap -> regression test");
  assert.ok(areas.includes("CI"), "CI gap -> workflow");
  for (const r of plan.recommendations) {
    assert.ok(r.promoteTo && r.action, `recommendation has promoteTo + action for ${r.area}`);
  }
  // Non-git fixture must not throw and must report no fix patterns.
  assert.equal(plan.fixPatterns.hotFiles.length, 0);
  assert.equal(plan.fixPatterns.fixCommits, 0);
});

test("evolve surfaces recent fix hotspots from git history", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-evolve-fix-"));
  execSync('git init -q && git config user.email t@t.t && git config user.name t', { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "auth.ts"), "a\n");
  execSync('git add -A && git commit -qm "fix: refresh token race"', { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "auth.ts"), "b\n");
  execSync('git add -A && git commit -qm "fix(auth): redirect loop"', { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "other.ts"), "c\n");
  execSync('git add -A && git commit -qm "feat: add thing"', { cwd: dir, stdio: "pipe" });

  const report = analyzeForTest(dir);
  const plan = buildEvolutionPlan(report);
  assert.ok(plan.fixPatterns.fixCommits >= 2, `counted >=2 fix commits, got ${plan.fixPatterns.fixCommits}`);
  const auth = plan.fixPatterns.hotFiles.find((h) => h.file === "auth.ts");
  assert.ok(auth && auth.count >= 2, `auth.ts should be a hotspot (changed 2x), got ${JSON.stringify(plan.fixPatterns.hotFiles)}`);
});

test("printEvolution prints concrete gap -> promotion lines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-evolve-print-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "demo" }));
  const report = analyzeForTest(dir);
  const plan = buildEvolutionPlan(report);
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    printEvolution(report, plan);
  } finally {
    console.log = orig;
  }
  const blob = logs.join("\n");
  assert.ok(/Promote these current gaps/.test(blob), "prints promotion header");
  assert.ok(/Tests/.test(blob), "names the Tests gap");
  assert.ok(/regression test/.test(blob), "shows the Tests promotion target");
});

test("evolve does not flag feature-commit churn as fix hotspots", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-evolve-feat-"));
  execSync('git init -q && git config user.email t@t.t && git config user.name t', { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "feature.ts"), "a\n");
  execSync('git add -A && git commit -qm "feat: add feature"', { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "feature.ts"), "b\n");
  execSync('git add -A && git commit -qm "refactor: expand feature"', { cwd: dir, stdio: "pipe" });
  const report = analyzeForTest(dir);
  const plan = buildEvolutionPlan(report);
  assert.equal(plan.fixPatterns.fixCommits, 0, "no fix commits in history");
  assert.equal(plan.fixPatterns.hotFiles.length, 0, "feature/refactor churn must not be flagged as a fix hotspot");
});
test("evolve scopes fix hotspots to the analyzed cwd, not the ancestor repo", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vca-scope-root-"));
  execSync('git init -q && git config user.email t@t.t && git config user.name t', { cwd: root, stdio: "pipe" });
  // Ancestor-repo fixes OUTSIDE the analyzed subdir, touching root-bug.ts twice.
  // Each reaches the count>=2 hotspot threshold, so without `-- .` path scoping
  // they would leak into the subdir's hotspot list as a false regression candidate.
  fs.writeFileSync(path.join(root, "root-bug.ts"), "a\n");
  execSync('git add -A && git commit -qm "fix: root ancestor bug 1"', { cwd: root, stdio: "pipe" });
  fs.writeFileSync(path.join(root, "root-bug.ts"), "b\n");
  execSync('git add -A && git commit -qm "fix: root ancestor bug 2"', { cwd: root, stdio: "pipe" });
  // The analyzed subdir + two fixes touching auth.ts (reaches count>=2 threshold).
  const sub = path.join(root, "pkg");
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, "auth.ts"), "a\n");
  execSync('git add -A && git commit -qm "fix(auth): token race"', { cwd: root, stdio: "pipe" });
  fs.writeFileSync(path.join(sub, "auth.ts"), "b\n");
  execSync('git add -A && git commit -qm "fix(auth): refresh loop"', { cwd: root, stdio: "pipe" });

  const report = analyzeForTest(sub);
  const plan = buildEvolutionPlan(report);
  const leaked = plan.fixPatterns.hotFiles.find((h) => h.file.endsWith("root-bug.ts"));
  assert.equal(leaked, undefined, "fix outside the analyzed cwd must not leak into hotspots");
  const auth = plan.fixPatterns.hotFiles.find((h) => h.file.endsWith("auth.ts"));
  assert.ok(auth && auth.count >= 2, "fix inside the analyzed cwd should be reported as a hotspot");
});

test("evolve does not count prefix/fixture/dispatch substrings as fix commits", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-fixterms-"));
  execSync('git init -q && git config user.email t@t.t && git config user.name t', { cwd: dir, stdio: "pipe" });
  // Each subject contains a "fix"/"patch" substring inside another word.
  // The old unanchored regex matched them and counted these as fix commits.
  fs.writeFileSync(path.join(dir, "a.ts"), "1\n");
  execSync('git add -A && git commit -qm "feat: add prefix helper"', { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "a.ts"), "2\n");
  execSync('git add -A && git commit -qm "chore: update test fixture"', { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "a.ts"), "3\n");
  execSync('git add -A && git commit -qm "refactor: dispatch handler"', { cwd: dir, stdio: "pipe" });
  const report = analyzeForTest(dir);
  const plan = buildEvolutionPlan(report);
  assert.equal(plan.fixPatterns.fixCommits, 0, "prefix/fixture/dispatch substrings must not count as fix commits");
  assert.equal(plan.fixPatterns.hotFiles.length, 0, "non-fix commits must not produce hotspots");
});

// ---- false-safety warnings for partially-present checks (PR #8) ----
test("warns when tests exist but no CI runs them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-w-tci-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { test: "node --test", ci: "node --test" } }));
  fs.writeFileSync(path.join(dir, "app.test.js"), "test('x', () => {});\n");
  // no .github/workflows => CI missing
  const report = analyzeForTest(dir);
  const codes = report.warnings.map((w) => w.code);
  assert.ok(codes.includes("tests-without-ci"), `expected tests-without-ci, got ${codes.join(",")}`);
  // validation command is satisfied (scripts.ci) so no-single-command must NOT also fire
  assert.ok(!codes.includes("no-single-command"), "ci script present => no-single-command should not fire");
});

test("warns when agent rules exist but nothing enforces them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-w-rwe-"));
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# rules\n");
  // no tests, no CI, no validation command
  const report = analyzeForTest(dir);
  const codes = report.warnings.map((w) => w.code);
  assert.ok(codes.includes("rules-without-enforcement"), `expected rules-without-enforcement, got ${codes.join(",")}`);
});

test("warns when tests/CI exist but no single validation command", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-w-nsc-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { dev: "node ." } }));
  fs.writeFileSync(path.join(dir, "app.test.js"), "test('x', () => {});\n");
  fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".github", "workflows", "ci.yml"), "on: push\n");
  // no ci/validate script and no Makefile => Single validation command MISS while Tests+CI pass
  const report = analyzeForTest(dir);
  const codes = report.warnings.map((w) => w.code);
  assert.ok(codes.includes("no-single-command"), `expected no-single-command, got ${codes.join(",")}`);
});

test("a project with tests + CI + validation command has no false-safety warnings", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-w-clean-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", scripts: { ci: "node --test" } }));
  fs.writeFileSync(path.join(dir, "app.test.js"), "test('x', () => {});\n");
  fs.mkdirSync(path.join(dir, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".github", "workflows", "ci.yml"), "on: push\n");
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# rules\n");
  const report = analyzeForTest(dir);
  assert.equal(report.warnings.length, 0, `expected no warnings, got ${JSON.stringify(report.warnings)}`);
});

test("printReport surfaces warnings in its output", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-w-print-"));
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# rules\n");
  const report = analyzeForTest(dir);
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(" "));
  try {
    printReport(report);
  } finally {
    console.log = orig;
  }
  const blob = logs.join("\n");
  assert.ok(/Warnings:/.test(blob), "prints a Warnings header");
  assert.ok(/rules exist but no tests or CI/.test(blob), "prints the rules-without-enforcement message");
});

// ---- depth signals: distinguish stub (1 test) from mature (many) ----

test("Tests depth reports test file count", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-d-tests-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
  for (const name of ["a.test.js", "b.test.js", "c.test.ts"]) {
    fs.writeFileSync(path.join(dir, name), "export {};\n");
  }
  const report = analyzeForTest(dir);
  const tests = report.checks.find((c) => c.area === "Tests");
  assert.ok(tests && tests.ok, "Tests should pass");
  assert.match(tests.depth, /3 test file/, `depth should report 3 test files, got ${tests.depth}`);
});

test("Agent instructions depth reports instruction line count", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-d-lines-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
  // 5 lines WITH a trailing newline (normal Markdown convention) — must still
  // report 5, not 6: the trailing \n must not add an empty counted segment.
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# line1\n# line2\n# line3\n# line4\n# line5\n");
  const report = analyzeForTest(dir);
  const ai = report.checks.find((c) => c.area === "Agent instructions");
  assert.ok(ai && ai.ok);
  assert.match(ai.depth, /5 instruction line/, `depth should report 5 lines, got ${ai.depth}`);
});

test("Reusable skills depth reports skill count", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-d-skills-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# x\n");
  fs.mkdirSync(path.join(dir, ".claude", "skills", "deploy"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "skills", "deploy", "SKILL.md"), "deploy\n");
  fs.mkdirSync(path.join(dir, ".claude", "skills", "release"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".claude", "skills", "release", "SKILL.md"), "release\n");
  const report = analyzeForTest(dir);
  const skills = report.checks.find((c) => c.area === "Reusable skills");
  assert.ok(skills && skills.ok);
  assert.match(skills.depth, /2 skill/, `depth should report 2 skills, got ${skills.depth}`);
});

test("MISS-ing checks carry no depth hint", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-d-miss-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
  const report = analyzeForTest(dir);
  const tests = report.checks.find((c) => c.area === "Tests");
  assert.ok(tests && !tests.ok, "Tests should MISS on empty project");
  assert.equal(tests.depth, undefined, "MISS-ing check must not carry a depth hint");
});

test("Tests depth counts jsx/spec test files accepted by the Tests check", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-d-jsx-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x" }));
  fs.writeFileSync(path.join(dir, "App.test.jsx"), "export {};\n");
  fs.writeFileSync(path.join(dir, "utils.spec.jsx"), "export {};\n");
  const report = analyzeForTest(dir);
  const tests = report.checks.find((c) => c.area === "Tests");
  assert.ok(tests && tests.ok, "Tests should pass via .test.jsx");
  assert.match(tests.depth, /2 test file/, `depth should count jsx test files, got ${tests.depth}`);
});

test("Architecture sensors depth counts validators grouped under a validate/ dir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-valdir-"));
  // scripts/validate/architecture.js -- hasValidateScript matches the full path
  // (PASS), but the old basename counter only saw "architecture.js" and reported 0.
  fs.mkdirSync(path.join(dir, "scripts", "validate"), { recursive: true });
  fs.writeFileSync(path.join(dir, "scripts", "validate", "architecture.js"), "module.exports = {};\n");
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# x");
  const report = analyzeForTest(dir);
  const sensors = report.checks.find((c) => c.area === "Architecture sensors");
  assert.ok(sensors && sensors.ok, "hasValidateScript matches the full path -> PASS");
  assert.match(sensors.depth, /1 validator script/, `depth should count the validate-dir script, got ${sensors.depth}`);
});

test("Tests depth counts plain filenames inside a recognized test/ directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-testdir-"));
  // Mocha-style layout: test/api.js has no .test/.spec suffix, so the Tests check
  // passes via hasPrefixAt("test/") but the old suffix-only counter reported 0.
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  fs.writeFileSync(path.join(dir, "test", "api.js"), "const assert = require('assert');\n");
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# x");
  const report = analyzeForTest(dir);
  const tests = report.checks.find((c) => c.area === "Tests");
  assert.ok(tests && tests.ok, "hasPrefixAt('test/') -> PASS");
  assert.match(tests.depth, /1 test file/, `depth should count test/api.js, got ${tests.depth}`);
});

test("depth counters scan submodule roots beyond the top-level walk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-depthsub-"));
  // Submodule nested deeper than listFiles(cwd, 7), so its test file is only in
  // filesByRoot[submoduleRoot], not allFiles. The Tests check still passes via
  // hasPrefixAt("tests/") (per-root), but the old counter only saw allFiles.
  const sub = path.join(dir, "a", "b", "c", "d", "e", "f", "g", "h", "svc");
  fs.mkdirSync(path.join(sub, "tests"), { recursive: true });
  fs.writeFileSync(path.join(sub, "tests", "api_test.go"), "package tests\n");
  fs.writeFileSync(path.join(sub, "go.mod"), "module svc\n");
  fs.writeFileSync(
    path.join(dir, ".gitmodules"),
    '[submodule "svc"]\n\tpath = a/b/c/d/e/f/g/h/svc\n\turl = https://example.com/s.git\n',
  );
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# root");
  const report = analyzeForTest(dir);
  const tests = report.checks.find((c) => c.area === "Tests");
  assert.ok(tests && tests.ok, "submodule test file -> Tests PASS via per-root scan");
  assert.match(tests.depth, /1 test file/, `deep-submodule test should be counted, got ${tests.depth}`);
});

test("Tests depth excludes placeholder and fixture files in test directories", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-testph-"));
  fs.mkdirSync(path.join(dir, "test"), { recursive: true });
  // Placeholders / binary fixtures under test/ must NOT inflate the depth count.
  fs.writeFileSync(path.join(dir, "test", ".gitkeep"), "");
  fs.writeFileSync(path.join(dir, "test", "fixture.bin"), "\0");
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# x");
  const report = analyzeForTest(dir);
  const tests = report.checks.find((c) => c.area === "Tests");
  assert.ok(tests && tests.ok, "hasPrefixAt('test/') still PASS");
  assert.match(tests.depth, /0 test file/, `placeholder/fixture must not count, got ${tests.depth}`);
});

test("--version prints the package version and skips analysis", async () => {
  const orig = console.log;
  let captured = "";
  console.log = (s) => {
    captured = String(s);
  };
  try {
    await runCli(["--version"]);
  } finally {
    console.log = orig;
  }
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(captured, pkg.version, `expected ${pkg.version}, got ${captured}`);
});

test("analytics --format json emits parseable JSON with score and checks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-json-"));
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# x\n");
  const orig = console.log;
  let captured = "";
  console.log = (s) => { captured = String(s); };
  try {
    await runCli(["analytics", "--cwd", dir, "--format", "json"]);
  } finally {
    console.log = orig;
  }
  const obj = JSON.parse(captured);
  assert.equal(typeof obj.score, "number", "score is a number");
  assert.ok(Array.isArray(obj.checks), "checks is an array");
  assert.ok(Array.isArray(obj.files), "files is an array (Set serialized)");
});

test("flags harness files that exist on disk but are not git-tracked", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-untracked-"));
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# root\n");
  fs.writeFileSync(path.join(dir, "env.d.ts"), "declare namespace {}\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), "*.d.ts\n");
  execSync('git init -q && git config user.email t@t.t && git config user.name t', { cwd: dir, stdio: "pipe" });
  const report = analyzeForTest(dir);
  const tracked = report.checks.find((c) => c.area === "Harness files committed");
  assert.ok(tracked, "has a Harness files committed check");
  assert.equal(tracked.ok, false, "check fails when env.d.ts is gitignored");
  assert.ok(/env\.d\.ts/.test(tracked.action), "action names the untracked file");
});

test("does not flag harness files when they are git-tracked", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-tracked-"));
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# root\n");
  fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}\n");
  execSync('git init -q && git config user.email t@t.t && git config user.name t', { cwd: dir, stdio: "pipe" });
  execSync("git add -A", { cwd: dir, stdio: "pipe" });
  const report = analyzeForTest(dir);
  const tracked = report.checks.find((c) => c.area === "Harness files committed");
  assert.ok(tracked && tracked.ok, "check passes when harness files are tracked");
});

test("does not flag harness files when the tree is not a git repo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-nogit-"));
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# root\n");
  fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}\n");
  const report = analyzeForTest(dir);
  const tracked = report.checks.find((c) => c.area === "Harness files committed");
  assert.ok(tracked && tracked.ok, "N/A outside a git repo");
});

test("init pre-fills detected package.json scripts into AGENTS.md", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-prefill-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "demo", scripts: { dev: "vite", build: "vite build", test: "node --test" } }),
  );
  await runCli(["init", "--cwd", dir, "--write"]);
  const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.ok(/- Dev: npm run dev$/m.test(agents), "Dev pre-filled as `npm run` invocation");
  assert.ok(/- Build: npm run build$/m.test(agents), "Build pre-filled as `npm run` invocation");
  assert.ok(/- Test: npm run test$/m.test(agents), "Test pre-filled as `npm run` invocation");
});

test("init leaves command lines blank when no scripts are detected", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-noscripts-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "bare", scripts: {} }));
  await runCli(["init", "--cwd", dir, "--write"]);
  const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.ok(/- Build:\s*$/m.test(agents), "Build line stays blank when no scripts detected");
  assert.ok(/- Dev:\s*$/m.test(agents), "Dev line stays blank when no scripts detected");
});

test("init leaves Install blank for non-Node projects", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-nonde-"));
  fs.writeFileSync(path.join(dir, "go.mod"), "module demo\n");
  await runCli(["init", "--cwd", dir, "--write"]);
  const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.ok(/- Install:\s*$/m.test(agents), "Install blank for non-Node project (no bogus npm install)");
});

test("flags untracked harness files when cwd is a repo subdirectory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vca-subdir-"));
  fs.mkdirSync(path.join(root, "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "pkg", "env.d.ts"), "declare namespace {}\n");
  fs.writeFileSync(path.join(root, ".gitignore"), "*.d.ts\n");
  execSync('git init -q && git config user.email t@t.t && git config user.name t', { cwd: root, stdio: "pipe" });
  const report = analyzeForTest(path.join(root, "pkg"));
  const tracked = report.checks.find((c) => c.area === "Harness files committed");
  assert.ok(tracked, "check exists");
  assert.equal(tracked.ok, false, "flags gitignored env.d.ts even when cwd is a repo subdir");
});

test("init pre-fills Validate from ci script when no verify/validate", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-ci-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "demo", scripts: { ci: "node --test" } }),
  );
  await runCli(["init", "--cwd", dir, "--write"]);
  const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.ok(/- Validate: npm run ci$/m.test(agents), "Validate falls back to npm run ci");
});

test("init pre-fills only root scripts in monorepo (no child pkg leak)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-mono-"));
  // root: has build but NO dev
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "monorepo-root",
      scripts: { build: "npm run build --workspaces" },
      workspaces: ["packages/*"],
    }),
  );
  // child pkg: has dev (must NOT leak into root AGENTS.md)
  fs.mkdirSync(path.join(dir, "packages", "foo"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "packages", "foo", "package.json"),
    JSON.stringify({ name: "foo", scripts: { dev: "vite" } }),
  );
  await runCli(["init", "--cwd", dir, "--write"]);
  const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.ok(/- Build: npm run build/m.test(agents), "root Build pre-filled from root script");
  // child-only "dev" must not leak: Dev line should be blank or absent
  assert.ok(!/- Dev: npm run dev/.test(agents), "child dev script does not leak to root Dev");
});
