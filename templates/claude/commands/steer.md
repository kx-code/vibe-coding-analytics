Steer the harness after a bug fix or a repeated failure.

For the issue just fixed, run the steering loop:

1. **Root-cause the harness gap** — ask "Why did the harness (tests, lint, validators, rules) NOT catch this?" Name the specific missing sensor.
2. **Add the smallest durable sensor** that would have caught it, in order of preference:
   - a regression test that reproduces the bug (preferred — computational and self-verifying)
   - a lint rule or a `scripts/` architecture validator
   - a numbered rule (Rule N) in `CLAUDE.md` / `AGENTS.md`
   - a slash command or a specialist reviewer agent
3. **Verify the sensor fires** — confirm it fails on the pre-fix code and passes after the fix.
4. **Record it** — append a numbered rule and note which sensor now enforces it.

A rule without a sensor is documentation that decays; a sensor without a rule is silent enforcement. Add both when it matters.

This command is designed for loop usage:

```text
/loop 30m /steer
```
