import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { analyzeForTest, runCli, buildInitFiles } from "../src/cli.js";

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


// ---- git-tracked sensor: harness files must be committed, not gitignored ----

test("flags harness files that exist on disk but are not git-tracked", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-tracked-"));
  execSync('git init -q && git config user.email t@t.t && git config user.name t', { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# root");
  // A broad .d.ts rule (exactly the SiteGroup class of bug) silently excludes env.d.ts.
  fs.writeFileSync(path.join(dir, ".gitignore"), "*.d.ts\n");
  fs.writeFileSync(path.join(dir, "env.d.ts"), "declare global {}\n");
  execSync("git add -A && git commit -qm init", { cwd: dir, stdio: "pipe" });
  // env.d.ts is gitignored -> never staged -> exists on disk but NOT tracked.

  const report = analyzeForTest(dir);
  const tracked = report.checks.find((c) => c.area === "Harness files committed");
  assert.ok(tracked, "expected a 'Harness files committed' check");
  assert.equal(tracked.ok, false, "env.d.ts on disk but gitignored should be flagged");
  assert.ok(/env\.d\.ts/.test(tracked.action), "action should name the offending file");
});

test("does not flag harness files when the tree is not a git repo", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-nogit-"));
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# root");
  fs.writeFileSync(path.join(dir, "env.d.ts"), "declare global {}\n");
  const report = analyzeForTest(dir);
  const tracked = report.checks.find((c) => c.area === "Harness files committed");
  assert.ok(tracked && tracked.ok, "non-git tree should not be flagged");
});


test("git-tracked sensor ignores files inside a nested worktree/repo interior", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-nested-"));
  execSync('git init -q && git config user.email t@t.t && git config user.name t', { cwd: dir, stdio: "pipe" });
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# root");
  fs.writeFileSync(path.join(dir, ".gitignore"), "*.d.ts\n");
  // An anchor file at the REAL repo root that IS gitignored -> must be flagged.
  fs.writeFileSync(path.join(dir, "env.d.ts"), "declare global {}\n");
  // A nested "worktree": an ancestor dir carrying its own .git. Files here are
  // tracked by that nested index, not the cwd repo -- must NOT be flagged.
  fs.mkdirSync(path.join(dir, "sub", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sub", ".git"), "gitdir: ../../.git/worktrees/sub\n");
  fs.writeFileSync(path.join(dir, "sub", "pkg", "tsconfig.json"), "{}\n");
  execSync("git add -A && git commit -qm init", { cwd: dir, stdio: "pipe" });

  const report = analyzeForTest(dir);
  const tracked = report.checks.find((c) => c.area === "Harness files committed");
  assert.equal(tracked.ok, false, "root env.d.ts gitignored should still be flagged");
  assert.ok(/env\.d\.ts/.test(tracked.action), "action should name env.d.ts");
  assert.ok(!/sub\/pkg\/tsconfig\.json/.test(tracked.action), "nested-worktree tsconfig must NOT be flagged");
});


// ---- CLI: --version, --format json, init script pre-fill ----

test("--version prints the package version and skips analysis", async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"));
  const logs = [];
  const stub = mock.method(console, "log", (...a) => logs.push(a.join(" ")));
  // sandbox with no package.json at all -- version must NOT depend on cwd.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-ver-"));
  try {
    await runCli(["--version", "--cwd", dir]);
    assert.ok(logs.some((l) => l.includes(pkg.version)), `expected version ${pkg.version} in output: ${logs.join("|")}`);
    assert.ok(!logs.some((l) => /Harness score/.test(l)), "must not run analytics");
  } finally {
    stub.mock.restore();
  }
});

test("analytics --format json emits parseable JSON with score and checks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-json-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.0.0" }));
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# x");
  const logs = [];
  const stub = mock.method(console, "log", (...a) => logs.push(a.join(" ")));
  try {
    await runCli(["analytics", "--format", "json", "--cwd", dir]);
    const blob = logs.join("\n");
    const parsed = JSON.parse(blob);
    assert.equal(typeof parsed.score, "number");
    assert.ok(Array.isArray(parsed.checks) && parsed.checks.length > 0);
    assert.ok(parsed.checks.every((c) => "area" in c && "ok" in c));
    // files must be a JSON array, not a serialized Set (which stringifies to {})
    assert.ok(Array.isArray(parsed.files), "files must serialize as an array");
  } finally {
    stub.mock.restore();
  }
});

test("init pre-fills detected package.json scripts into AGENTS.md", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-init-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "demo",
    scripts: { dev: "astro dev", build: "astro build", verify: "node --test", test: "node --test" },
  }));
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# demo");
  const report = analyzeForTest(dir);
  const files = buildInitFiles(report);
  const agents = files.find((f) => f.relativePath === "AGENTS.md").content;
  assert.ok(/astro dev/.test(agents), "Dev line must show the detected dev command");
  assert.ok(/node --test/.test(agents), "Validate/Test must show the detected verify/test command");
});

test("init leaves command lines blank when no scripts are detected", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vca-init-empty-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "bare" }));
  const report = analyzeForTest(dir);
  const files = buildInitFiles(report);
  const agents = files.find((f) => f.relativePath === "AGENTS.md").content;
  // Install is always filled (npm install); the others stay as prompts.
  assert.ok(/Install:/.test(agents));
  assert.ok(!/astro dev/.test(agents), "must not invent commands that are not in package.json");
});
