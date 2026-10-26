# wordking coding-agent instructions

This repository includes a project-local Agent Skill for photo-to-vocabulary imports:

- **`.agents/skills/wordking-vocab-import/SKILL.md`** — Activate when the request concerns handwritten English vocabulary photos, Chinese meanings, parts of speech, lesson creation, or importing/editing the public word catalog (`data/words.json`).
- The user's required transcription confidence threshold is **90% for each uncertain English/Chinese/POS element**. Never substitute dictionary guesses for unreadable handwriting; ask the user and do not publish unresolved entries.
- Preserve public IDs, existing meanings/memberships, frozen migration history, and per-user data. Use the skill's checklist before committing to main.
- Other development tasks may proceed normally; this skill is not a blanket instruction to edit vocabulary files.
