# vibe-coding-analytics

[![npm version][npm-version-img]][npm-link]
[![npm downloads][npm-downloads-img]][npm-link]
[![CI][ci-img]][ci-link]
[![License: MIT][license-img]][license-link]
[![Node][node-img]][npm-link]
[![GitHub stars][stars-img]][repo-link]

> Initialize, audit, and evolve project harnesses for modern AI coding agents.

`vibe-coding-analytics` treats vibe coding as an engineering loop — clear
instructions, scoped memory, repeatable checks, reviewer roles, reusable
skills, and recurring improvement. It ships as a single npm package with a
zero-config CLI and first-class templates for Claude Code and Codex.

## ✨ Features

- **Audit** a project for AI coding readiness across agents, memory, skills,
  tests, CI, and deploy hooks.
- **Scaffold** baseline harness files (`AGENTS.md`, `.ai/workflows`,
  `.ai/reviewers`, knowledge base, ADR decision log, CI, validator script, and
  native adapters for Codex, Claude Code, Cursor, Kiro, and Copilot).
- **Evolve** a concrete improvement plan: maps detected analytics gaps to
  promotion targets (tests, validators, CI, skills, rules) and surfaces recent
  git fix hotspots as regression-test candidates.
- **Monorepo-aware** — git submodules, npm workspaces, polyglot stacks, and
  fractal per-directory docs are detected automatically.
- **Read-only by default** — every command is safe to dry-run; pass `--write`
  to materialize changes.

## 📦 Installation

Run without installing:

```bash
npx vibe-coding-analytics analytics
```

Or install globally:

```bash
npm install -g vibe-coding-analytics
```

Requires Node.js `>= 18`.

## 🚀 Usage

```bash
# One-off, no install
npx vibe-coding-analytics scan            # audit (alias: analytics)
npx vibe-coding-analytics init --write    # scaffold missing harness files
npx vibe-coding-analytics evolve --write  # evolve harness from recent fixes
```

`vca` is also exposed as a CLI alias. With `npx`, use `--package` so npm
installs the `vibe-coding-analytics` package and then runs its `vca` binary:

```bash
npx --package vibe-coding-analytics vca scan
```

With a global install:

```bash
vibe-coding-analytics scan
vibe-coding-analytics init --write
vibe-coding-analytics evolve --write

# or the short alias
vca scan
vca init --write
vca evolve --write
```

Commands are read-only by default. Add `--write` to create missing harness
files.

> The npm package and CLI are the same package — there is no separate CLI
> package to publish or install.

## Commands

| Command | Purpose |
| --- | --- |
| `scan` | Audit the current project for AI coding readiness (`analytics` is an alias). |
| `init` | Propose or create a minimum viable harness: `AGENTS.md`, `.ai/workflows`, `.ai/reviewers`, knowledge base, ADR decision log, CI, validator script, plus native adapters for Codex, Claude Code, Cursor, Kiro, and Copilot. |
| `evolve` | Propose or create self-evolution loop files for repeated improvements; also backfills hooks + deny list when missing. |

## Integrations

### Claude Code Slash Commands

The generated project templates support:

```text
/analytics
/init
/evolve
/steer
```

The `evolve` and `steer` commands are designed to pair with local loops:

```text
/loop 30m /evolve
/loop 30m /steer   # after each bug fix: add the smallest sensor that would have caught it
```

Use it to extract repeated user corrections, failed checks, review feedback,
and repeated command sequences into durable tests, validators, rules,
commands, skills, or reviewer agents.

### Codex Skill

This repository includes a distributable skill at:

```text
skills/vibe-coding-analytics/SKILL.md
```

The skill triggers when initializing a new project, auditing an existing
repository for AI coding readiness, adding agent rules, or improving a
project's vibe coding harness.

### Codex Plugin

The repository includes a Codex plugin manifest:

```text
.codex-plugin/plugin.json
```

It points Codex at the included skills directory and can be used as the base
for marketplace submission.

## What It Checks

- `AGENTS.md`, `CLAUDE.md`, Cursor rules, Kiro steering, and Copilot instructions
- Project memory such as PRDs, constraints, patterns, known issues, or fractal
  per-directory `CLAUDE.md`
- Reusable skills, slash commands, specialist reviewers (`.claude/agents/`,
  reviewer skills, or plugin agents)
- Tests, typecheck, lint, architecture validators, and CI
- Rule-to-sensor coverage: prose rules in `CLAUDE.md`/`AGENTS.md` backed by
  computational sensors (tests, lint, validators), not prose-only
- Steering loop: numbered rules (`Rule N`) in `CLAUDE.md`/`AGENTS.md`
  that grow after each bug fix — the rising count is the feedback-loop heartbeat
- Failure observability: monitoring, alerting, or error counters so critical-path
  failures surface instead of failing silently
- Deploy and post-deploy verification hooks
- Agent hooks: `PostToolUse` on `Edit|Write` running eslint + prettier
  (format-on-save + lint-on-edit at edit time), plus a `permissions.deny`
  list blocking irreversible commands (`rm -rf`, `git push -f`, `git reset --hard`,
  `curl | sh`, `psql -c 'DROP TABLE …'`, …). `vca init --write` scaffolds both for Claude Code projects;
  the deny list gains destructive-SQL entries (`psql *-c *DROP TABLE*`,
  `mysql *-e *TRUNCATE*`, …) on database projects — matched inside the client
  invocation, since the real command never starts with the bare keyword
- Cross-session memory: ADR decisions, agent memory, or a decisions log
- Self-evolution loops that promote repeated work into durable harness assets
- Minimum viable harness generation: project facts, validation command, CI,
  `.ai/workflows`, `.ai/reviewers`, knowledge base, decision memory,
  architecture validator, and native AI tool adapters
- Depth hints on passing checks (test-file / instruction-line / skill counts) so a stub is distinguishable from a mature project at the same score
- False-safety warnings when checks are partially present (tests without CI, agent rules without enforcement, no single validation command)

## Monorepo & Non-Standard Conventions

The analyzer is aware of common repository shapes and does not assume a flat
single-package Node project:

- **Git submodules** — when `.gitmodules` is present, every check runs against
  the root plus each submodule root, so tests, scripts, and harness files
  living one level down are still detected.
- **npm workspaces** — detected from the root `package.json` `workspaces`
  field.
- **Polyglot stacks** — `package.json` scripts are merged from every
  subpackage; Go (`go.mod`), Flutter (`pubspec.yaml`), and TypeScript
  (`tsconfig.json`) are recognized as typecheck signals; test files are
  detected by convention (`*_test.go`, `*_test.dart`, `*.test.{js,ts}`,
  `test_*.py`, …).
- **Fractal docs** — two or more `CLAUDE.md`/`AGENTS.md` files count as
  project memory, matching the per-directory documentation pattern.
- **Architecture sensors** — any `scripts/*validate*`, `*verify*`, `*check*`,
  or `*lint*` file counts, not just `scripts/validate-architecture`.

The report prints the detected `Project shape` and how many roots were
scanned.

## 🤝 Contributing

Contributions are welcome! Please open an
[issue](https://github.com/kx-code/vibe-coding-analytics/issues) or submit a
[pull request](https://github.com/kx-code/vibe-coding-analytics/pulls).

## 📄 License

[MIT](./LICENSE) © 2026 [kx-code](https://github.com/kx-code)

<!-- badge references -->
[npm-version-img]: https://img.shields.io/npm/v/vibe-coding-analytics.svg
[npm-downloads-img]: https://img.shields.io/npm/dm/vibe-coding-analytics.svg
[ci-img]: https://github.com/kx-code/vibe-coding-analytics/actions/workflows/release.yml/badge.svg
[license-img]: https://img.shields.io/badge/license-MIT-blue.svg
[node-img]: https://img.shields.io/node/v/vibe-coding-analytics.svg
[stars-img]: https://img.shields.io/github/stars/kx-code/vibe-coding-analytics.svg
[npm-link]: https://www.npmjs.com/package/vibe-coding-analytics
[ci-link]: https://github.com/kx-code/vibe-coding-analytics/actions/workflows/release.yml
[license-link]: ./LICENSE
[repo-link]: https://github.com/kx-code/vibe-coding-analytics
