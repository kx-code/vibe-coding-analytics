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


// ---- PR A: detection accuracy ----

test("detects each npm workspace package as a project root", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-wsroots-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
  );
  for (const name of ["a", "b"]) {
    fs.mkdirSync(path.join(dir, "packages", name), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "packages", name, "package.json"),
      JSON.stringify({ name, scripts: { test: "node --test" } }),
    );
  }
  fs.writeFileSync(path.join(dir, "packages", "b", "CLAUDE.md"), "# b");
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# root");
  const report = analyzeForTest(dir);
  // root + 2 workspace packages
  assert.ok(
    report.roots.length >= 3,
    `expected >=3 roots (root + 2 workspaces), got ${report.roots.length}`,
  );
});

test("does not flag typecheck for a plain-JS project", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-plainjs-"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "plain", scripts: { test: "node --test" } }),
  );
  fs.writeFileSync(path.join(dir, "index.js"), "console.log(1);\n");
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# plain");
  const report = analyzeForTest(dir);
  const tc = report.checks.find((c) => c.area === "Typecheck");
  assert.ok(tc && tc.ok, "plain-JS project should not be flagged for typecheck");
});

test("detects pnpm-workspace and cargo workspace shapes", () => {
  const pnpm = fs.mkdtempSync(path.join(os.tmpdir(), "vca-pnpm-"));
  fs.writeFileSync(path.join(dir_for(pnpm), "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  fs.writeFileSync(path.join(pnpm, "package.json"), JSON.stringify({ name: "p" }));
  fs.writeFileSync(path.join(pnpm, "CLAUDE.md"), "# pnpm");
  let report = analyzeForTest(pnpm);
  assert.equal(report.shape, "pnpm workspace monorepo");

  const cargo = fs.mkdtempSync(path.join(os.tmpdir(), "vca-cargo-"));
  fs.mkdirSync(path.join(cargo, "crates", "lib"), { recursive: true });
  fs.writeFileSync(path.join(cargo, "Cargo.toml"), "[workspace]\nmembers = [\"crates/lib\"]\n");
  fs.writeFileSync(path.join(cargo, "CLAUDE.md"), "# cargo");
  report = analyzeForTest(cargo);
  assert.equal(report.shape, "cargo workspace monorepo");
});

// tiny helper so the pnpm assertion line reads cleanly
function dir_for(d) { return d; }
