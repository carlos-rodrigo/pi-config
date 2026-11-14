# Feature Docs

`docs/features/` keeps durable notes for older features: what they are for and how they work now. Read them before changing those features.

New feature work does not start here:

- Plan it in `.features/<slug>/plan.md` (ignored) with the `plan` skill.
- Split it into `.features/<slug>/tasks/` briefs with `simple-tasks`; each brief has a feedback loop and records its `## Result`.
- Move decisions with lasting value into an ADR. The plan and tasks are working material.

Add or update a note here only when it records how a feature works now and would otherwise be rediscovered. Move notes for removed features to `archive/`.

Current notes:

- `context-engineering/` — documentation structure and progressive disclosure for agent docs.
- `pr-review-comments/` — PR-native document review comments.
