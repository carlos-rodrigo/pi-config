---
id: 006
status: open
depends: [001]
created: 2026-02-27
---

# Podcast script generator (sub-agent)

Generate engaging two-host podcast dialogue scripts from PRD/design documents using a dedicated sub-agent.

## What to do

### Script generator (`lib/script-generator.ts`)

- Implement `generateScript(manifest, sourceContent, language, onProgress): Promise<DialogueScript>`
- Export types: `DialogueScript`, `ScriptSegment`

### Sub-agent orchestration

- Spawn a sub-agent using `pi.exec()` with pi in JSON mode (following the pattern from `extensions/subagent/index.ts`)
- Pass a specialized system prompt for screenwriter-quality dialogue generation
- Send the source document content with section IDs annotated inline

### System prompt for the script sub-agent

The prompt must instruct the LLM to:
1. Read the document with annotated section markers
2. Generate a natural, engaging two-host conversation covering every section
3. Use `[S1]` and `[S2]` speaker tags (S1 = lead host, S2 = analyst/questioner)
4. Include conversational elements:
   - Natural reactions ("Right, and what's interesting here is...")
   - Genuine questions between hosts
   - Emphasis with pauses: `(pauses)`
   - Occasional laughter where natural: `(laughs)`
   - Summary transitions between sections
5. Mark section boundaries with `<!-- SECTION: {sectionId} -->` comments
6. Every section from the manifest must be covered
7. Adapt to the specified language (English or Spanish)
8. S1 explains concepts, S2 challenges, questions, highlights trade-offs
9. Keep each section's dialogue proportional to the section's content size
10. Open with a brief intro, close with a summary/recap

### Input format

Annotate the source document with section markers before sending to sub-agent:

```
<!-- SECTION: s-introduction -->
## Introduction
[section content...]

<!-- SECTION: s-user-stories--us-001 -->
### US-001: Setup database schema
[section content...]
```

### Output parsing

- Parse the sub-agent's output to extract structured `ScriptSegment[]`
- Split on `<!-- SECTION: ... -->` markers
- Within each section, split on `[S1]` / `[S2]` tags
- Extract direction annotations `(laughs)`, `(pauses)`, etc.
- Validate: every manifest section ID must appear in the script
- Save raw script to `review-{n}.script.md`

### Error handling

- If sub-agent fails → retry once with a simplified prompt
- If section is missing from script → log warning, don't fail
- Report progress per section during generation

## Acceptance criteria

- [ ] `generateScript()` produces a `DialogueScript` with segments covering all sections
- [ ] Script uses `[S1]`/`[S2]` speaker tags correctly
- [ ] Section markers `<!-- SECTION: ... -->` are present and match manifest section IDs
- [ ] Script includes conversational elements (reactions, questions, pauses)
- [ ] Script sounds natural when read aloud (not robotic or list-like)
- [ ] English script works for English documents
- [ ] Spanish script works when `language: "es"` is specified
- [ ] Raw script saved to `.features/{feature}/reviews/review-{n}.script.md`
- [ ] Missing sections are logged as warnings
- [ ] Progress callback fires during generation

## Files

- `~/.pi/agent/extensions/review-hub/lib/script-generator.ts`

## Verify

```bash
# Generate a script from the review-hub PRD
# Check that all section IDs from the manifest appear in the script
# Read the script — it should sound like a natural conversation
```
