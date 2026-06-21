Improve this project's AI coding harness from recent work.

Look for:
- repeated user corrections
- repeated commands
- failed tests or CI
- review comments
- production or deployment incidents
- missing project context

Promote each repeated pattern into one of:
- test
- lint or architecture validator
- AGENTS.md / CLAUDE.md / Cursor / Copilot rule
- slash command
- reusable skill
- specialist reviewer agent
- post-deploy or scheduled check

This command is designed for loop usage:

```text
/loop 30m /evolve
```
