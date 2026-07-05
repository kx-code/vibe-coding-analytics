import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeForTest, runCli } from "../src/cli.js";

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
  // 5 lines, no trailing newline => split("\n").length === 5
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# line1\n# line2\n# line3\n# line4\n# line5");
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
