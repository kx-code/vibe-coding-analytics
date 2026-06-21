# vibe-coding-analytics

## Purpose

This repository packages a reusable vibe coding harness analyzer as:

- an npm CLI: `vibe-coding-analytics` / `vca`
- a Codex plugin manifest under `.codex-plugin/`
- a Codex-compatible skill under `skills/vibe-coding-analytics/`
- Claude Code slash command templates under `templates/claude/commands/`

## Commands

- `npm run analytics` - audit the current repository
- `npm run init` - preview baseline harness files
- `npm run evolve` - preview self-evolution files
- `npm test` - run Node tests
- `npm run validate` - run tests and repository structure validation
- `npm run ci` - CI entrypoint

## Design Rules

- CLI commands are read-only by default. Only `--write` creates files.
- Keep the package dependency-free unless a dependency has clear user value.
- Keep generated project files conservative and easy to edit.
- Promote repeated workflow needs into templates, skills, or validators.
- Do not add project-specific business rules to the generic skill.

## Release Notes

Before release:

1. Run `npm run ci`.
2. Run `npm pack --dry-run`.
3. Confirm `.codex-plugin/plugin.json` and `skills/vibe-coding-analytics/SKILL.md` are included.
