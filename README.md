# vibe-coding-analytics

Initialize, audit, and evolve project harnesses for modern AI coding agents.

This project treats vibe coding as an engineering loop: clear instructions, scoped memory, repeatable checks, reviewer roles, reusable skills, and recurring improvement.

## Usage

Run without installing:

```bash
npx vibe-coding-analytics analytics
npx vibe-coding-analytics init --write
npx vibe-coding-analytics evolve --write
```

`vca` is also exposed as a CLI alias. With `npx`, use `--package` so npm installs
the `vibe-coding-analytics` package and then runs its `vca` binary:

```bash
npx --package vibe-coding-analytics vca analytics
```

Or install the CLI globally:

```bash
npm install -g vibe-coding-analytics
vibe-coding-analytics analytics
vibe-coding-analytics init --write
vibe-coding-analytics evolve --write

vca analytics
vca init --write
vca evolve --write
```

Commands are read-only by default. Add `--write` to create missing harness files.

The npm package and CLI are the same package. There is no separate CLI package to
publish or install.

## Commands

| Command | Purpose |
| --- | --- |
| `analytics` | Audit the current project for AI coding readiness. |
| `init` | Propose or create baseline harness files. |
| `evolve` | Propose or create self-evolution loop files for repeated improvements. |

## Claude Code Slash Commands

The generated project templates support:

```text
/analytics
/init
/evolve
```

The `evolve` command is designed to pair with local loops:

```text
/loop 30m /evolve
```

Use it to extract repeated user corrections, failed checks, review feedback, and repeated command sequences into durable tests, validators, rules, commands, skills, or reviewer agents.

## Codex Skill

This repository includes a distributable skill at:

```text
skills/vibe-coding-analytics/SKILL.md
```

The skill triggers when initializing a new project, auditing an existing repository for AI coding readiness, adding agent rules, or improving a project's vibe coding harness.

## Codex Plugin

The repository includes a Codex plugin manifest:

```text
.codex-plugin/plugin.json
```

It points Codex at the included skills directory and can be used as the base for marketplace submission.

## What It Checks

- `AGENTS.md`, `CLAUDE.md`, Cursor rules, and Copilot instructions
- project memory such as PRDs, constraints, patterns, and known issues
- reusable skills, slash commands, and specialist reviewers
- tests, typecheck, lint, architecture validators, and CI
- deploy and post-deploy verification hooks
- self-evolution loops that promote repeated work into durable harness assets

## License

MIT
