---
name: vibe-coding-analytics
description: Use when initializing a new software project, auditing an existing repository for AI coding readiness, adding agent rules, project memory, validation checks, CI, subagents, skills, slash commands, automatic evolution, loop-compatible workflows, or modern vibe coding harnesses across Codex, Claude Code, Cursor, GitHub Copilot, and similar coding agents.
---

# Vibe Coding Analytics

## Overview

Build or audit the project harness that lets AI coding agents work safely: clear instructions, scoped memory, repeatable checks, review roles, reusable workflows, and self-improving feedback loops.

Treat vibe coding as an engineering system, not a prompting style.

## Modes

Choose one mode from the user request:

| Mode | Use When | Output |
| --- | --- | --- |
| `analytics` | User wants a repo audit or readiness score | Gap report and prioritized roadmap |
| `init` | User wants to initialize or write baseline harness files | File plan, then edits if approved or requested |
| `evolve` | User wants automatic improvement, loop support, or repeated-work extraction | Durable sensors, commands, skills, rules, or reviewer agents |

## Core Loop

Use this loop for both new projects and existing repositories:

1. **Understand**: read README, package files, build config, tests, CI, docs, agent instruction files, and recent git status.
2. **Plan**: identify the smallest harness changes that improve agent reliability.
3. **Implement or recommend**: create missing files only when asked to modify the repo; otherwise provide a prioritized gap report.
4. **Verify**: run available checks, or state exactly which checks are missing.
5. **Steer**: for every repeated failure, add a sensor: test, lint rule, architecture validator, CI check, skill, slash command, reviewer, or project rule.

## What to Inspect

| Area | Look For |
| --- | --- |
| Project facts | `README`, package scripts, framework config, deployment model, env examples |
| Agent instructions | `AGENTS.md`, `CLAUDE.md`, `.cursor/rules`, `.github/copilot-instructions.md` |
| Memory | `docs/PRD`, `docs/knowledge-base`, decisions, constraints, known issues |
| Skills and commands | `.claude/skills`, `.claude/commands`, reusable workflows |
| Review roles | `.claude/agents`, security/database/pipeline/release reviewers |
| Sensors | typecheck, lint, tests, Playwright, architecture validation, pre-commit hooks |
| CI and release | GitHub Actions, PR template, deploy workflow, post-deploy checks |
| Feedback loops | bug-to-test practice, issue/PR review loops, recurring health checks |

Prefer `rg --files` and package manifests over guessing. Read mature sibling projects only as pattern sources; do not copy domain-specific rules.

## Minimum Viable Harness

For a new or weakly instrumented project, start with:

1. `AGENTS.md` with architecture, commands, env rules, and project-specific traps.
2. One complete validation command such as `npm run ci`.
3. Typecheck, lint, unit test, and build scripts.
4. CI that runs the same validation command.
5. `docs/knowledge-base/patterns.md`, `constraints.md`, and `known-issues.md`.
6. One reviewer agent for the highest-risk domain.
7. One architecture validator for rules that should not rely on memory.

Do not overbuild. Add more harness only when the project has repeated operations or recurring failure modes.

## Automatic Evolution

Use `evolve` when the user mentions auto-improvement, loop, repeated capabilities, skill extraction, session mining, memory updates, or keeping the project configuration fresh.

Promotion rules:

| Signal | Promote To |
| --- | --- |
| Repeated bug | Regression test or architecture validator |
| Repeated command sequence | package script or slash command |
| Repeated domain workflow | project skill |
| Repeated review concern | specialist reviewer agent |
| Repeated user correction | AGENTS/CLAUDE/Cursor/Copilot rule plus a sensor when possible |
| Repeated deployment check | post-deploy command or scheduled automation |
| Repeated missing context | docs/knowledge-base entry |

When paired with `/loop`, keep each pass small:

1. Read recent diffs, notes, issues, review comments, and known failures.
2. Pick at most three harness improvements.
3. Prefer computational sensors over prose-only rules.
4. Verify.
5. Record what changed and why.

Example loop prompt:

```text
/loop 30m /evolve
```

## Output Format

For an audit:

1. Current harness maturity in one paragraph.
2. Gap table with `Area`, `Current`, `Missing`, `Recommended action`.
3. Priority roadmap: now / next / later.
4. User cooperation needed: credentials, decisions, sample flows, approval gates.

For implementation:

1. State which files will be created or changed before editing.
2. Keep changes minimal and project-specific.
3. Run available validation.
4. Report created harness assets and remaining gaps.

## Red Flags

Stop and tighten the harness when:

- No single command proves the repo is healthy.
- Agent rules exist but no tests or CI enforce them.
- Secrets, production APIs, or databases are handled by memory only.
- Repeated bugs are fixed without adding tests, validators, or rules.
- Long instruction files mix stable facts, temporary notes, and domain-specific bugs.
- Generated code can deploy without post-deploy verification.
