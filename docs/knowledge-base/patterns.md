# Patterns

## Read-Only By Default

All CLI commands inspect and report unless `--write` is present. This keeps `npx` usage safe in unknown repositories.

## Harness Assets

Generate minimal, editable files first:

- `AGENTS.md`
- `.github/copilot-instructions.md`
- `docs/knowledge-base/*`
- `.claude/commands/*`
- `.claude/skills/project-evolution/SKILL.md`

Avoid writing tool-specific files when they are not useful for the target project.
