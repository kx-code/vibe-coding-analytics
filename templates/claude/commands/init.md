Initialize a minimum viable AI coding harness for this repository.

Run:

```bash
npx vibe-coding-analytics init --write
```

Then adapt generated files to the project, run available validation, and report remaining gaps.

Compatibility target:
- Codex reads `AGENTS.md`.
- Claude Code reads `CLAUDE.md`, `.claude/commands/`, and `.claude/settings*.json`.
- Cursor reads `.cursor/rules/*.mdc`.
- Kiro reads `.kiro/steering/*.md`.
- GitHub Copilot reads `.github/copilot-instructions.md`.

Initialization rule:
- Treat `.ai/` as the portable source layer for reusable workflows and reviewer specs.
- Keep `AGENTS.md` as the canonical durable-rule file.
- Keep tool-native files as thin adapters that point to `AGENTS.md` and `.ai/`.
- Do not assume `.ai/` is auto-discovered by AI CLIs or IDEs unless that tool explicitly supports it.

Expected generic baseline:
- AGENTS.md with project facts and commands
- .ai/workflows reusable workflows
- .ai/reviewers reviewer specs
- docs/knowledge-base patterns, constraints, and known issues
- docs/decisions ADR memory
- scripts/validate-harness.js
- CI workflow
- Codex AGENTS.md
- Claude Code CLAUDE.md and .claude/commands
- Cursor .cursor/rules/*.mdc
- Kiro .kiro/steering/*.md
- Copilot .github/copilot-instructions.md

Before finishing, verify every compatibility target above has a native adapter file.
