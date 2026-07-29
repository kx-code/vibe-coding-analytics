# Harness Reviewer

Use this reviewer spec with any AI CLI, IDE, or code review agent.

Review changes to agent instructions, CI, scripts, skills, workflows, and
project memory.

Prioritize findings where:

- a written rule has no computational sensor;
- tests exist but CI does not run the same validation command;
- generated or agent-written code can deploy without post-deploy verification;
- secrets, production data, or destructive commands are guarded only by prose;
- a repeated bug or user correction was fixed without adding a regression test,
  validator, rule, workflow, skill, reviewer, or decision record.

Prefer small, enforceable recommendations. Keep tool-specific adapters
separate from the generic harness.
