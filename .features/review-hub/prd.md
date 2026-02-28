# PRD: Review Hub

## Introduction

Reading PRDs and design documents in raw markdown is tedious and not fun. Review Hub is a pi extension that provides **alternative ways to review** these documents — it does not replace the existing PRD and design generation workflow. PRDs and design documents are still generated as markdown files via the existing skills (`prd`, `design-solution`). Review Hub sits on top of that workflow, transforming those generated documents into two interactive review experiences: a **podcast-style audio discussion** and a **cinematic scroll-driven web presentation**.

Both are served in a local web app with an integrated **commenting system** that maps feedback back to source document sections. When the review is done, comments are applied to update the PRD or design via LLM-assisted editing.

The commenting/review system is the **core primitive** — audio and visual are renderers that feed into it. This architecture allows future expansion to other document types (task previews, changelogs, etc).

**What stays the same:** PRD generation, design generation, task creation, implementation loop.
**What this replaces:** The manual approval step. Instead of reading raw markdown and saying "approved" or giving ad-hoc feedback, Review Hub becomes **the place where approbation and feedback are collected**. Every PRD and design goes through Review Hub for structured review — approval, concerns, change requests, and questions are all captured as typed, section-anchored comments that feed back into the document automatically.

## Goals

- Eliminate the need to read raw markdown PRDs and design documents
- Provide a podcast experience with expressive, alive-sounding multi-voice dialogue (not monotone)
- Provide a cinematic scroll-driven visual presentation of documents
- Enable inline commenting on both audio (timestamped) and visual (section-anchored) reviews
- Close the feedback loop: comments get applied back to source documents automatically
- Run entirely locally — no cloud services required for core functionality
- Support English and Spanish
- Auto-install TTS dependencies on first use to minimize setup friction

## User Stories

### US-001: Review Server Infrastructure

**Description:** As a user, I want a local web server that hosts my review sessions so that I can interact with reviews in the browser with auto-saving comments.

**BDD Spec:**
- Given: A review session has been generated for a document
- When: The review server starts
- Then: A local web app opens in my browser serving the review

**Acceptance Criteria:**

- [ ] Local Node.js server starts on an available port
- [ ] Serves review web app with audio player, visual presentation, and comment panel
- [ ] Auto-saves comments to `.features/{feature}/reviews/` as JSON
- [ ] Server shuts down cleanly when pi session ends or user closes the review
- [ ] Multiple review sessions can exist for the same document (versioned)
- [ ] npm run typecheck passes

### US-002: Comment System Core

**Description:** As a reviewer, I want to leave comments anchored to specific sections of my document so that my feedback maps back to the source precisely.

**BDD Spec:**
- Given: A review web app is open
- When: I click on a section and type a comment
- Then: The comment is saved with its section reference, type, and priority

**Acceptance Criteria:**

- [ ] Comments have: id, sectionId, sectionTitle, text, type (change | question | approval | concern), priority (high | medium | low)
- [ ] Audio comments additionally have an audioTimestamp field
- [ ] Comments auto-save to the server (no manual save button)
- [ ] Comments persist across browser refreshes
- [ ] Comment panel shows all comments, filterable by type and priority
- [ ] "Done Reviewing" button marks the review as complete and notifies pi
- [ ] Review JSON schema is documented and stable
- [ ] npm run typecheck passes

### US-003: Podcast Script Generation

**Description:** As a user, I want my PRD or design document turned into an engaging dialogue script so that the podcast sounds like two hosts having a real conversation.

**BDD Spec:**
- Given: A markdown document (PRD or design)
- When: A review is generated
- Then: A sub-agent creates a two-host dialogue script with natural conversation, questions, reactions, and expressions

**Acceptance Criteria:**

- [ ] Sub-agent generates script with [S1] and [S2] speaker tags
- [ ] Script includes conversational elements: reactions, emphasis, pauses, laughter where natural
- [ ] Script covers all sections of the source document
- [ ] Script maps dialogue segments back to source sections (for comment anchoring)
- [ ] Script is generated in the user's chosen language (English or Spanish)
- [ ] Script saved to `.features/{feature}/reviews/review-{n}.script.md`
- [ ] npm run typecheck passes

### US-004: Audio Generation with Local TTS

**Description:** As a user, I want the podcast script synthesized into audio using local TTS so that I hear expressive, natural-sounding voices without cloud dependencies.

**BDD Spec:**
- Given: A dialogue script with [S1]/[S2] speaker tags exists
- When: Audio generation is triggered
- Then: An audio file is produced with two distinct voices and natural expressiveness

**Acceptance Criteria:**

- [ ] Uses Dia (Nari Labs) as primary TTS for English
- [ ] Uses Bark as fallback for Spanish
- [ ] TTS provider is pluggable via a provider interface
- [ ] Audio output is WAV or MP3 format
- [ ] Audio segments are timestamped and mapped to script sections (for comment anchoring)
- [ ] Audio file saved to `.features/{feature}/reviews/review-{n}.mp3`
- [ ] Timestamp map saved alongside for waveform comment positioning
- [ ] npm run typecheck passes

### US-005: TTS Auto-Installation

**Description:** As a user, I want TTS dependencies installed automatically on first use so that I don't need to manually configure Python environments.

**BDD Spec:**
- Given: No TTS provider is installed
- When: I trigger my first review with audio
- Then: The extension detects missing dependencies and installs them with my confirmation

**Acceptance Criteria:**

- [ ] On first audio generation, detect if Dia/Bark Python packages are available
- [ ] Show confirmation dialog before installing ("This will install Dia TTS via pip. ~2GB download. Continue?")
- [ ] Install into a dedicated virtual environment (not system Python)
- [ ] Cache installation status to avoid re-checking every time
- [ ] If installation fails, show clear error and suggest manual steps
- [ ] Support skipping audio and using visual-only review if TTS unavailable
- [ ] npm run typecheck passes

### US-006: Audio Player with Waveform and Comments

**Description:** As a reviewer, I want to see the podcast as a waveform I can interact with so that I can leave timestamped comments on specific parts of the discussion.

**BDD Spec:**
- Given: An audio review is loaded in the web app
- When: I click on a point in the waveform
- Then: I can add a comment anchored to that timestamp and its corresponding document section

**Acceptance Criteria:**

- [ ] Audio player with waveform visualization (wavesurfer.js)
- [ ] Play/pause, seek, speed control (1x, 1.25x, 1.5x, 2x)
- [ ] Current section highlighted as audio plays (synced to script section map)
- [ ] Click on waveform to add a comment at that timestamp
- [ ] Existing comments shown as markers on the waveform
- [ ] Click a marker to jump to that timestamp and see the comment
- [ ] npm run typecheck passes

### US-007: Cinematic Visual Presentation

**Description:** As a reviewer, I want to see my PRD/design as a scroll-driven cinematic narrative so that I can review it visually with animations and clear structure.

**BDD Spec:**
- Given: A markdown document exists
- When: A visual review is generated
- Then: An animated scroll-driven HTML presentation is created with section-by-section reveal

**Acceptance Criteria:**

- [ ] Markdown transformed into structured HTML with cinematic styling
- [ ] Scroll-driven animations: sections fade/slide in as you scroll
- [ ] Dark theme, clean typography, generous whitespace
- [ ] Code blocks syntax-highlighted
- [ ] Diagrams and lists animated on scroll entry
- [ ] Section-level comment buttons (click to add comment anchored to that section)
- [ ] Active section highlighted in a navigation sidebar/progress indicator
- [ ] Responsive — works on different screen sizes
- [ ] npm run typecheck passes

### US-008: Apply Review Comments

**Description:** As a user, I want my review comments applied back to the source document so that the PRD/design evolves based on my feedback.

**BDD Spec:**
- Given: A completed review with comments exists
- When: I tell pi to apply the review
- Then: The LLM reads the comments, modifies the source document, and shows me a diff for approval

**Acceptance Criteria:**

- [ ] `/review-apply` command reads review JSON
- [ ] Maps comments back to source sections using sectionId
- [ ] LLM generates updated document incorporating change and concern comments
- [ ] Question comments are listed as items to address (may become open questions)
- [ ] Approval comments are noted (no changes needed for those sections)
- [ ] Shows diff of proposed changes before applying
- [ ] User can approve, reject, or modify the diff
- [ ] Updates source `.md` file after approval
- [ ] Review status updated to "applied"
- [ ] npm run typecheck passes

### US-009: Pi Extension Integration

**Description:** As a user, I want to trigger reviews via both `/review` commands and LLM tool calls so that reviews fit naturally into my workflow.

**BDD Spec:**
- Given: A PRD or design document exists
- When: I type `/review` or the LLM decides a review is needed
- Then: A review session is generated and opened in the browser

**Acceptance Criteria:**

- [ ] `/review <path>` command triggers review generation
- [ ] `review_document` tool available for LLM to call as part of workflow
- [ ] Both accept options: `--audio-only`, `--visual-only`, `--lang en|es`
- [ ] Progress shown in pi via `ctx.ui.setStatus` during generation
- [ ] Notification when review is ready and browser opens
- [ ] `/review-apply <path>` command and `review_apply` tool to apply comments
- [ ] `/review-list` to see all reviews for a feature
- [ ] npm run typecheck passes

### US-010: Language Support

**Description:** As a user, I want to generate reviews in English or Spanish so that I can review in my preferred language.

**BDD Spec:**
- Given: A document in any language
- When: I specify `--lang es` on the review command
- Then: The podcast script is generated in Spanish and TTS uses a Spanish-capable provider

**Acceptance Criteria:**

- [ ] `--lang` flag accepts `en` or `es` (default: `en`)
- [ ] Podcast script sub-agent generates dialogue in the specified language
- [ ] English uses Dia TTS, Spanish uses Bark TTS (automatic provider selection)
- [ ] Visual presentation UI labels adapt to language
- [ ] Comment system works in any language (no restrictions on comment text)
- [ ] npm run typecheck passes

## Functional Requirements

- FR-1: Register `/review`, `/review-apply`, and `/review-list` commands in pi
- FR-2: Register `review_document` and `review_apply` tools callable by the LLM
- FR-3: Start a local Node.js HTTP server to host the review web app
- FR-4: Generate podcast dialogue scripts via a dedicated sub-agent with a screenwriter-quality system prompt
- FR-5: Synthesize audio using local TTS (Dia for English, Bark for Spanish) with a pluggable provider interface
- FR-6: Auto-detect and install TTS dependencies on first use into an isolated virtual environment
- FR-7: Generate cinematic scroll-driven HTML presentation from markdown
- FR-8: Serve a review web app combining audio player (wavesurfer.js), visual presentation, and comment panel
- FR-9: Auto-save comments to `.features/{feature}/reviews/review-{n}.json` via the local server
- FR-10: Map comments back to source document sections via sectionId anchoring
- FR-11: Apply review comments to source documents via LLM with diff preview and approval
- FR-12: Support English and Spanish for script generation and TTS
- FR-13: Show generation progress in pi TUI via status updates and notifications
- FR-14: Clean up server on session shutdown

## Non-Goals

- No cloud TTS services (ElevenLabs, OpenAI TTS) in the initial version — pluggable interface allows adding later
- No real-time collaboration — single reviewer at a time
- No video generation or screen recordings
- No mobile-optimized review app (desktop browser only for v1)
- No voice-input for comments (text only)
- No automatic review triggering — user or LLM must explicitly request
- No support for languages beyond English and Spanish in v1
- No PDF or other non-markdown input formats

## Design Considerations

### Review Web App Layout

```
┌─────────────────────────────────────────────────────────┐
│  Review Hub — auth-feature/prd.md         [EN] [Done]   │
├────────────────────────────────┬────────────────────────┤
│                                │                        │
│  ┌──────────────────────────┐  │   Comments (4)         │
│  │  🎙️ Podcast Player       │  │                        │
│  │  ▁▂▃▅▇▅▃▂▁▂▃▅▇▅▃▁▂▃▅▇  │  │   ● [change] high     │
│  │  ◄◄  ▶  ►►  1.5x  03:45│  │   Section: User Stories│
│  │  📍markers on waveform   │  │   "Missing 2FA edge   │
│  └──────────────────────────┘  │    case..."            │
│                                │                        │
│  ┌──────────────────────────┐  │   ○ [approval] med     │
│  │  📖 Visual Presentation  │  │   Section: Tech Reqs   │
│  │                          │  │   "Agree with JWT..."  │
│  │  [scroll-driven content  │  │                        │
│  │   with animations,       │  │   ● [question] med     │
│  │   section highlights,    │  │   Section: Non-Goals   │
│  │   inline comment btns]   │  │   "Should we include   │
│  │                          │  │    rate limiting?"      │
│  │                          │  │                        │
│  └──────────────────────────┘  │   [+ Add Comment]      │
│                                │                        │
├────────────────────────────────┴────────────────────────┤
│  Section: User Stories ▸ US-003: Filter by Priority     │
└─────────────────────────────────────────────────────────┘
```

### File Structure

```
.features/{feature}/
├── prd.md                          # Source document
├── design.md                       # Source document
└── reviews/
    ├── review-001.json             # Comments + metadata
    ├── review-001.script.md        # Podcast dialogue script
    ├── review-001.mp3              # Generated audio
    └── review-001.sections.json    # Section → timestamp mapping
```

### Review JSON Schema

```json
{
  "id": "review-001",
  "source": ".features/auth/prd.md",
  "reviewType": "prd",
  "language": "en",
  "createdAt": "2026-02-27T22:00:00Z",
  "completedAt": null,
  "status": "in-progress",
  "sections": [
    {
      "id": "introduction",
      "title": "Introduction",
      "sourceLineStart": 5,
      "sourceLineEnd": 12,
      "audioStartTime": 0,
      "audioEndTime": 45.2
    }
  ],
  "comments": [
    {
      "id": "c1",
      "sectionId": "user-stories-us003",
      "sectionTitle": "US-003: Filter by Priority",
      "audioTimestamp": 125.3,
      "type": "change",
      "priority": "high",
      "text": "Missing edge case: what if user has 2FA enabled?",
      "createdAt": "2026-02-27T22:05:00Z"
    }
  ]
}
```

### TTS Provider Interface

```typescript
interface TTSProvider {
  name: string;
  supportedLanguages: string[];
  isAvailable(): Promise<boolean>;
  install(onProgress: (msg: string) => void): Promise<void>;
  generateDialogue(script: DialogueScript): Promise<{
    audio: Buffer;
    format: "mp3" | "wav";
    sectionTimestamps: SectionTimestamp[];
  }>;
}
```

## Technical Considerations

- **Extension type:** Directory-based extension with `package.json` for npm dependencies (wavesurfer.js assets, etc.)
- **Server:** Minimal Node.js HTTP server using built-in `node:http` — no Express needed
- **TTS isolation:** Python virtual environment in `~/.pi/review-hub/venv/` to avoid polluting system Python
- **Audio format:** Generate WAV from TTS, then convert to MP3 for smaller files (use ffmpeg or lame if available, otherwise serve WAV)
- **Web app:** Single-page app with vanilla JS + CSS — no build step, no React. Keep it self-contained.
- **wavesurfer.js:** Bundle from CDN or vendor into the extension
- **Section mapping:** Parse markdown headings to create section IDs. Script generator must use the same section IDs to enable comment anchoring across audio and visual.
- **Sub-agent model:** Use a capable model for script generation — the dialogue quality depends heavily on prompt quality
- **Cleanup:** Register `session_shutdown` handler to stop the server

## Success Metrics

- User can go from PRD to podcast + visual review in < 2 minutes (excluding TTS generation time)
- Comments map correctly back to source sections 100% of the time
- Applied comments produce meaningful, accurate document updates
- TTS auto-installation succeeds on first try for macOS with Apple Silicon
- Review web app loads and plays audio without errors

## Open Questions

- Should the review web app support a "notes" mode for free-form notes not anchored to sections?
- Should we persist review server port between sessions or use a random available port each time?
- For task preview expansion: should tasks render as a Kanban board or as a sequential list?
- Should the podcast script include a summary/recap section at the end?
- When applying comments, should we keep a history of previous versions of the document?
