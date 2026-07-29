# ADR 0001: Establish AI Coding Harness

## Status

Accepted

## Context

vibe-coding-analytics needs stable project facts, repeatable validation, shared memory, review
roles, and feedback loops so AI coding agents can work safely across sessions.

## Decision

Keep a minimal harness in version control:

- AGENTS.md for stable commands and rules.
- CLAUDE.md, .cursor/rules/, .kiro/steering/, .github/copilot-instructions.md,
  and .claude/commands/ as native adapters for mainstream AI tools.
- docs/knowledge-base/ for patterns, constraints, and known issues.
- docs/decisions/ for cross-session architectural decisions.
- .ai/workflows/ for reusable workflows that any AI CLI or IDE can read.
- .ai/reviewers/harness-reviewer.md for harness-focused review guidance.
- scripts/validate-harness.js and CI as executable sensors.

## Consequences

When a bug, review comment, or repeated manual step appears, promote it into a
test, validator, rule, command, skill, reviewer, or decision record rather than
leaving it as session-only memory.
