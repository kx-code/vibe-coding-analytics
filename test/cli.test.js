import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { analyzeForTest, runCli, printReport } from "../src/cli.js";

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


// ---- false-safety warnings (Tests without CI, rules without enforcement, no single command) ----

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
  const stub = mock.method(console, "log", (...a) => logs.push(a.join(" ")));
  try {
    printReport(report);
    const blob = logs.join("\n");
    assert.ok(/Warnings:/.test(blob), "prints a Warnings header");
    assert.ok(/rules exist but no tests or CI/.test(blob), "prints the rules-without-enforcement message");
  } finally {
    stub.mock.restore();
  }
});
