# Technical Design: Review Hub

## 1. Overview

Review Hub is a directory-based pi extension that provides an interactive review workflow for PRDs and design documents. It has three layers:

1. **Generators** — Transform markdown into consumable formats (podcast audio, cinematic HTML)
2. **Review Server** — Ephemeral local HTTP server hosting the review web app with commenting
3. **Applicator** — Maps comments back to source sections and applies changes via LLM

The extension registers both `/review` commands (user-driven) and `review_document`/`review_apply` tools (LLM-callable). A **review manifest** is the central data structure that ties together source sections, script segments, audio timestamps, and comments.

## 2. Codebase Analysis

### Existing Extension Patterns

| Pattern | Source | How we'll use it |
|---------|--------|-----------------|
| Tool + command registration | `extensions/file-opener.ts` | Register `/review`, `/review-apply`, `/review-list` commands and corresponding tools |
| Sub-agent spawning | `extensions/subagent/index.ts` | Script generation sub-agent for podcast dialogue |
| Shell execution | `pi.exec()` via ExtensionAPI | Python subprocess for TTS, ffmpeg for audio conversion |
| Session shutdown cleanup | `pi.on("session_shutdown")` | Stop review server, kill TTS processes |
| Status/progress UI | `ctx.ui.setStatus()`, `ctx.ui.notify()` | Show generation progress |
| Shared utilities in `lib/` | `extensions/lib/worktree.ts` | Model for shared utilities (manifest, server, TTS interface) |

### Available System Dependencies

| Dependency | Status | Path |
|------------|--------|------|
| Python 3.11 | ✅ Installed | `/usr/local/bin/python3` |
| pip3 | ✅ Installed | `/usr/local/bin/pip3` |
| ffmpeg | ✅ Installed | `/opt/homebrew/bin/ffmpeg` |
| Node.js | ✅ (pi runtime) | Built-in |

### No Existing Reuse

This is a new capability — no existing extensions serve HTTP, generate audio, or host web apps. Everything is new code, but follows established registration and lifecycle patterns.

## 3. Extension Structure

```
~/.pi/agent/extensions/review-hub/
├── package.json                 # Extension metadata + dependencies
├── index.ts                     # Entry point: registers commands, tools, lifecycle
├── lib/
│   ├── manifest.ts              # Review manifest creation, section parsing, ID generation
│   ├── server.ts                # HTTP server lifecycle (start, stop, routing)
│   ├── script-generator.ts      # Sub-agent orchestration for podcast script
│   ├── tts/
│   │   ├── provider.ts          # TTSProvider interface
│   │   ├── dia.ts               # Dia provider (English)
│   │   ├── bark.ts              # Bark provider (Spanish)
│   │   └── installer.ts         # Auto-install logic: venv, pip, platform checks
│   ├── visual-generator.ts      # Markdown → cinematic HTML transformation
│   └── applicator.ts            # Comment → source document application
├── web/
│   ├── index.html               # Review web app (single page)
│   ├── styles.css               # Cinematic dark theme, animations
│   ├── app.js                   # Main app logic: player, comments, visual
│   └── vendor/
│       └── wavesurfer.min.js    # Vendored wavesurfer.js (no CDN dependency)
└── python/
    ├── generate_dia.py          # Dia TTS generation script
    └── generate_bark.py         # Bark TTS generation script
```

## 4. Data Model

### Review Manifest (source of truth)

The manifest is the **central mapping contract** between all layers. It is generated once from the source markdown and referenced by the script generator, TTS, visual presentation, and comment system.

```typescript
interface ReviewManifest {
  id: string;                          // "review-001"
  source: string;                      // ".features/auth/prd.md"
  sourceHash: string;                  // SHA-256 of source file at generation time
  reviewType: "prd" | "design";
  language: "en" | "es";
  createdAt: string;                   // ISO timestamp
  completedAt: string | null;
  status: "generating" | "ready" | "in-progress" | "reviewed" | "applied";

  sections: ReviewSection[];
  comments: ReviewComment[];

  audio?: {
    file: string;                      // "review-001.mp3"
    durationSeconds: number;
    scriptFile: string;                // "review-001.script.md"
  };

  visual?: {
    file: string;                      // Embedded in web app, not a separate file
  };
}

interface ReviewSection {
  id: string;                          // Stable ID: "s-introduction", "s-user-stories--us-003"
  headingPath: string[];               // ["User Stories", "US-003: Filter by Priority"]
  headingLevel: number;                // 2, 3, etc.
  occurrenceIndex: number;             // 0 for first, 1 for duplicate headings
  sourceLineStart: number;
  sourceLineEnd: number;
  sourceTextHash: string;              // Hash of section content for drift detection

  // Populated after audio generation
  audioStartTime?: number;
  audioEndTime?: number;
}

interface ReviewComment {
  id: string;                          // UUID
  sectionId: string;                   // References ReviewSection.id
  audioTimestamp?: number;             // Seconds into audio (if commenting from waveform)
  type: "change" | "question" | "approval" | "concern";
  priority: "high" | "medium" | "low";
  text: string;
  createdAt: string;
}
```

### Section ID Generation

Section IDs must be **stable and unambiguous** — heading slugs alone fail with duplicates.

```typescript
function generateSectionId(headingPath: string[], occurrenceIndex: number): string {
  const slug = headingPath
    .map(h => h.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""))
    .join("--");
  const id = `s-${slug}`;
  return occurrenceIndex > 0 ? `${id}-${occurrenceIndex}` : id;
}
```

Duplicate headings are disambiguated with an occurrence index. The source text hash detects when a section has been modified after review generation, enabling drift warnings.

### File Layout

```
.features/{feature}/
├── prd.md
├── design.md
└── reviews/
    ├── review-001.manifest.json      # Central manifest (sections + comments)
    ├── review-001.script.md          # Podcast dialogue script
    ├── review-001.mp3                # Generated audio
    └── review-002.manifest.json      # Subsequent review (after doc changes)
```

## 5. Component Architecture

### 5.1 Entry Point (`index.ts`)

Registers everything and manages lifecycle:

```typescript
export default function (pi: ExtensionAPI) {
  let server: ReviewServer | null = null;

  // Cleanup on shutdown
  pi.on("session_shutdown", async () => {
    await server?.stop();
  });

  // Recover from crashed sessions on startup
  pi.on("session_start", async (_event, ctx) => {
    await cleanupOrphanServers();
  });

  // Commands
  pi.registerCommand("review", { ... });        // /review <path> [--audio-only] [--visual-only] [--lang en|es]
  pi.registerCommand("review-apply", { ... });   // /review-apply <path-to-manifest>
  pi.registerCommand("review-list", { ... });    // /review-list [feature]

  // Tools (LLM-callable)
  pi.registerTool({ name: "review_document", ... });
  pi.registerTool({ name: "review_apply", ... });
}
```

### 5.2 Manifest Generator (`lib/manifest.ts`)

Parses markdown into sections with stable IDs:

```typescript
interface ManifestGenerator {
  // Parse markdown → sections with line ranges and hashes
  createManifest(
    sourcePath: string,
    reviewType: "prd" | "design",
    language: "en" | "es"
  ): Promise<ReviewManifest>;

  // Load existing manifest from disk
  loadManifest(manifestPath: string): Promise<ReviewManifest>;

  // Save manifest (atomic write via temp + rename)
  saveManifest(manifest: ReviewManifest, dir: string): Promise<string>;

  // Check if source has drifted since manifest was created
  detectDrift(manifest: ReviewManifest): Promise<DriftResult>;
}
```

**Markdown parsing strategy:** Split on heading lines (`# `, `## `, etc.). Track heading hierarchy to build `headingPath`. Count occurrences of identical headings for disambiguation. Record line ranges and content hashes.

### 5.3 Podcast Script Generator (`lib/script-generator.ts`)

Uses a sub-agent to generate the dialogue script:

```typescript
interface ScriptGenerator {
  generateScript(
    manifest: ReviewManifest,
    sourceContent: string,
    language: "en" | "es",
    onProgress: (msg: string) => void
  ): Promise<DialogueScript>;
}

interface DialogueScript {
  segments: ScriptSegment[];
  rawScript: string;
}

interface ScriptSegment {
  sectionId: string;        // Maps to manifest section
  speaker: "S1" | "S2";
  text: string;             // The dialogue line
  direction?: string;       // "(laughs)", "(pauses)", etc.
}
```

**Sub-agent prompt strategy:** The script generator spawns a sub-agent with a dedicated system prompt that:
1. Receives the full document content with section IDs annotated
2. Generates a two-host dialogue covering every section
3. Outputs structured segments with `[S1]`/`[S2]` tags and section markers
4. Must reference section IDs exactly as provided (no invention)
5. Must include conversational elements: reactions, questions between hosts, emphasis, pauses

The sub-agent output is parsed to extract structured `ScriptSegment[]` with section anchoring.

**Script format:**

```markdown
<!-- SECTION: s-introduction -->
[S1] So today we're diving into this new auth feature. Pretty interesting approach.
[S2] Yeah, what caught my eye is the decision to support both OAuth and magic links from day one.
[S1] Right, and if you think about the user experience... (pauses) it's actually quite elegant.

<!-- SECTION: s-user-stories--us-001 -->
[S2] Let's talk about the first user story. Database priority field.
[S1] This one's straightforward — add a column, set a default. But there's a subtlety here...
```

### 5.4 TTS Providers (`lib/tts/`)

#### Provider Interface

```typescript
interface TTSProvider {
  name: string;
  supportedLanguages: string[];

  isAvailable(): Promise<boolean>;
  install(
    onProgress: (msg: string) => void,
    onConfirm: (msg: string) => Promise<boolean>
  ): Promise<void>;

  generateAudio(
    script: DialogueScript,
    onProgress: (phase: string, progress: number) => void,
    signal?: AbortSignal
  ): Promise<TTSResult>;
}

interface TTSResult {
  audioBuffer: Buffer;
  format: "wav" | "mp3";
  sectionTimestamps: SectionTimestamp[];   // Per-section start/end times
}

interface SectionTimestamp {
  sectionId: string;
  startTime: number;      // Seconds
  endTime: number;
}
```

#### Dia Provider (`lib/tts/dia.ts`)

**Generation strategy:** Dia processes dialogue natively with `[S1]`/`[S2]` tags. We feed it the full script (or large chunks) and it generates audio for both speakers in a single pass, producing natural back-and-forth rhythm.

```typescript
class DiaProvider implements TTSProvider {
  name = "dia";
  supportedLanguages = ["en"];

  private venvPath = path.join(os.homedir(), ".pi", "review-hub", "venv-dia");
  private pythonScript = path.join(__dirname, "..", "python", "generate_dia.py");

  async isAvailable(): Promise<boolean> {
    // Check venv exists + dia package installed
  }

  async install(onProgress, onConfirm): Promise<void> {
    // 1. Platform check (Python 3.10+, Apple Silicon OK)
    // 2. Confirm with user (~2GB download)
    // 3. Create venv: python3 -m venv <venvPath>
    // 4. Install: pip install dia-tts torch --index-url ...
    // 5. Verify installation
  }

  async generateAudio(script, onProgress, signal): Promise<TTSResult> {
    // 1. Write script to temp file as JSON
    // 2. Spawn: <venv>/bin/python generate_dia.py --script <path> --output <path>
    // 3. Python script:
    //    a. Loads Dia model (cached after first load)
    //    b. Processes dialogue chunks
    //    c. Writes WAV + timestamp JSON
    // 4. Read WAV, convert to MP3 via ffmpeg
    // 5. Parse timestamp JSON for section mapping
    // 6. Report progress per section
  }
}
```

**Python script (`generate_dia.py`):**

```python
import json, sys, argparse
import numpy as np
from dia.model import Dia

def generate(script_path, output_path):
    model = Dia("nari-labs/Dia-1.6B")  # or latest version
    script = json.load(open(script_path))

    all_audio = []
    timestamps = []
    current_time = 0.0
    sample_rate = 44100

    for segment in script["segments"]:
        section_id = segment["sectionId"]
        text = segment["text"]  # Already has [S1]/[S2] tags

        # Generate audio for this segment
        audio = model.generate(text)

        duration = len(audio) / sample_rate
        timestamps.append({
            "sectionId": section_id,
            "startTime": current_time,
            "endTime": current_time + duration
        })

        all_audio.append(audio)
        current_time += duration

        # Progress to stdout
        print(json.dumps({"progress": section_id}), flush=True)

    # Write WAV
    combined = np.concatenate(all_audio)
    # ... write to output_path

    # Write timestamps
    with open(output_path + ".timestamps.json", "w") as f:
        json.dump(timestamps, f)

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--script", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    generate(args.script, args.output)
```

**Section timestamp strategy:** Dia processes dialogue in section-sized chunks. Each chunk's audio length is measured to produce accurate timestamps. Chunks are concatenated with small silence gaps between sections for natural pacing.

#### Bark Provider (`lib/tts/bark.ts`)

Same interface, different internals:
- Multi-speaker via `speaker_id` parameter (different voice presets)
- Alternates speakers per `ScriptSegment`
- Supports Spanish via Bark's multilingual capability
- Slower — progress reporting is critical

#### Auto-Installer (`lib/tts/installer.ts`)

```typescript
interface InstallerConfig {
  venvPath: string;
  requirements: Record<string, string>;   // Pinned: { "dia-tts": "1.0.0", "torch": "2.5.1" }
  pythonMinVersion: string;               // "3.10"
  platformChecks: PlatformCheck[];
}

async function ensureTTSAvailable(
  provider: TTSProvider,
  ui: ExtensionContext["ui"]
): Promise<boolean> {
  if (await provider.isAvailable()) return true;

  const confirmed = await ui.confirm(
    "TTS Setup Required",
    `${provider.name} is not installed. This will:\n` +
    `• Create a Python virtual environment (~50MB)\n` +
    `• Install ${provider.name} and dependencies (~2GB download)\n` +
    `• Location: ~/.pi/review-hub/venv-${provider.name}/\n\n` +
    `Continue?`
  );

  if (!confirmed) return false;

  // Pre-flight checks
  await checkPythonVersion();
  await checkPlatformCompatibility();

  await provider.install(
    (msg) => ui.setStatus("review-hub", msg),
    (msg) => ui.confirm("Installation", msg)
  );

  return true;
}
```

**Installation hardening:**
- Pinned requirements in a lockfile (no `pip install --upgrade`)
- Python version check (≥3.10)
- Platform detection (Apple Silicon → appropriate torch wheel)
- Venv keyed by provider name (separate for Dia and Bark)
- No silent upgrades — user must re-run setup explicitly
- Clear error messages with manual fallback instructions

### 5.5 Review Server (`lib/server.ts`)

Ephemeral Node.js HTTP server, started per review session.

```typescript
interface ReviewServer {
  start(manifest: ReviewManifest, reviewDir: string): Promise<{ port: number; url: string }>;
  stop(): Promise<void>;
}
```

**Implementation:**

```typescript
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

class ReviewServerImpl implements ReviewServer {
  private httpServer: http.Server | null = null;
  private sessionToken: string = "";      // Random token for POST auth

  async start(manifest: ReviewManifest, reviewDir: string) {
    this.sessionToken = crypto.randomUUID();
    const port = await findAvailablePort(3847, 3947);

    this.httpServer = http.createServer((req, res) => {
      // CORS: only allow same origin
      res.setHeader("Access-Control-Allow-Origin", `http://127.0.0.1:${port}`);

      // Static files: web app assets
      if (req.method === "GET") {
        return this.handleGet(req, res, manifest, reviewDir);
      }

      // Comment API: requires session token
      if (req.method === "POST") {
        return this.handlePost(req, res, manifest, reviewDir);
      }
    });

    this.httpServer.listen(port, "127.0.0.1");  // Bind to localhost only
    return { port, url: `http://127.0.0.1:${port}?token=${this.sessionToken}` };
  }

  private handleGet(req, res, manifest, reviewDir) {
    const routes = {
      "/":             () => serveFile("web/index.html", "text/html"),
      "/styles.css":   () => serveFile("web/styles.css", "text/css"),
      "/app.js":       () => serveFile("web/app.js", "application/javascript"),
      "/wavesurfer.js":() => serveFile("web/vendor/wavesurfer.min.js", "application/javascript"),
      "/manifest.json":() => serveJSON(manifest),
      "/audio":        () => serveFile(path.join(reviewDir, manifest.audio!.file), "audio/mpeg"),
      "/source":       () => serveFile(manifest.source, "text/markdown"),
    };
    // ... route matching and serving
  }

  private handlePost(req, res, manifest, reviewDir) {
    // Validate session token from query param or header
    // POST /comments — add/update comment
    // POST /complete — mark review as done
    // Atomic write: write to .tmp, rename to final
  }

  async stop() {
    this.httpServer?.close();
    this.httpServer = null;
  }
}
```

**Security baseline:**
- Bind to `127.0.0.1` only (no network exposure)
- Random session token required for all POST requests
- Strict path allowlist (only serves known files, no arbitrary filesystem access)
- Atomic JSON writes (temp file + rename)
- No user-provided paths in filesystem operations

**Orphan cleanup on startup:**
- Write PID + port to `~/.pi/review-hub/server.lock` on start
- On `session_start`, check lock file. If PID is dead, remove lock and free port
- If PID is alive but stale (different pi session), warn user

### 5.6 Visual Generator (`lib/visual-generator.ts`)

Transforms markdown into cinematic scroll-driven HTML. This does NOT use an LLM — it's a deterministic transformation with CSS animations.

```typescript
interface VisualGenerator {
  generateVisual(
    manifest: ReviewManifest,
    sourceContent: string
  ): string;   // Returns HTML string embedded in the review app
}
```

**Transformation strategy:**

1. Parse markdown into sections using the manifest's section map
2. Each section becomes a `<section data-section-id="...">` with scroll-triggered animations
3. Headings → large animated typography
4. Bullet lists → staggered fade-in items
5. Code blocks → syntax-highlighted with typewriter reveal
6. User stories → card-style layout with status indicators
7. Tables → animated row reveals
8. A floating progress indicator shows current section

**CSS Animation approach:**

```css
/* Intersection Observer triggers these classes */
.section { opacity: 0; transform: translateY(40px); }
.section.visible {
  opacity: 1; transform: translateY(0);
  transition: opacity 0.6s ease, transform 0.6s ease;
}
.section.visible .list-item:nth-child(n) {
  transition-delay: calc(n * 0.1s);    /* Stagger list items */
}
```

**Comment integration:** Each section has a floating comment button (💬) that opens the comment form pre-anchored to that section.

### 5.7 Review Web App (`web/`)

Single-page vanilla HTML/JS/CSS app. No build step.

**Module structure within `app.js`:**

```javascript
// Strict module boundaries to manage state
const ReviewApp = {
  state: {
    manifest: null,
    comments: [],
    currentSection: null,
    audioPlaying: false,
  },

  // Sub-modules
  audio: AudioPlayer,       // wavesurfer.js wrapper
  visual: VisualPresenter,  // Scroll-driven presentation
  comments: CommentPanel,   // Comment CRUD + display
  sync: SyncManager,        // Section sync between audio + visual + comments

  async init(token) { ... },
  async loadManifest() { ... },
  async saveComment(comment) { ... },
  async completeReview() { ... },
};
```

**Audio Player (wavesurfer.js):**

```javascript
const AudioPlayer = {
  ws: null,

  async init(audioUrl, sectionTimestamps) {
    this.ws = WaveSurfer.create({
      container: "#waveform",
      waveColor: "#4a5568",
      progressColor: "#805ad5",
      cursorColor: "#e2e8f0",
      height: 80,
      barWidth: 2,
      barGap: 1,
    });

    await this.ws.load(audioUrl);

    // Add section regions
    const regions = this.ws.registerPlugin(RegionsPlugin.create());
    for (const section of sectionTimestamps) {
      regions.addRegion({
        start: section.startTime,
        end: section.endTime,
        color: "rgba(128, 90, 213, 0.1)",
        id: section.sectionId,
      });
    }

    // Comment markers
    for (const comment of ReviewApp.state.comments) {
      if (comment.audioTimestamp != null) {
        regions.addRegion({
          start: comment.audioTimestamp,
          end: comment.audioTimestamp + 0.5,
          color: commentTypeColor(comment.type),
          id: `comment-${comment.id}`,
        });
      }
    }

    // Click to add comment
    this.ws.on("click", (relativeX) => {
      const time = relativeX * this.ws.getDuration();
      const section = findSectionAtTime(time, sectionTimestamps);
      CommentPanel.openNew({ sectionId: section.id, audioTimestamp: time });
    });

    // Sync visual scroll to audio playback
    this.ws.on("timeupdate", (time) => {
      SyncManager.onAudioTime(time);
    });
  },

  setSpeed(rate) { this.ws.setPlaybackRate(rate); },
};
```

**Comment Panel:**

```javascript
const CommentPanel = {
  async openNew({ sectionId, audioTimestamp }) {
    // Show comment form with:
    // - Type selector: change | question | approval | concern
    // - Priority: high | medium | low
    // - Text input
    // - Section auto-filled from sectionId
    // - Timestamp auto-filled if from audio click
  },

  async save(comment) {
    // POST to server with session token
    const response = await fetch("/comments", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Session-Token": ReviewApp.token,
      },
      body: JSON.stringify(comment),
    });
    // Update local state
    ReviewApp.state.comments.push(await response.json());
    this.render();
  },

  render() {
    // Render comment list with filters
    // Each comment shows: type icon, priority badge, section title, text, timestamp
    // Click comment → jump to section (visual) or timestamp (audio)
  },
};
```

**Sync Manager:** Keeps audio position, visual scroll, and comment panel in sync:

```javascript
const SyncManager = {
  onAudioTime(seconds) {
    const section = findSectionAtTime(seconds, manifest.sections);
    if (section && section.id !== ReviewApp.state.currentSection) {
      ReviewApp.state.currentSection = section.id;
      VisualPresenter.scrollToSection(section.id);
      CommentPanel.highlightSection(section.id);
    }
  },

  onVisualScroll(sectionId) {
    ReviewApp.state.currentSection = sectionId;
    CommentPanel.highlightSection(sectionId);
    // Don't seek audio — visual browsing is independent
  },
};
```

**"Done Reviewing" flow:**

```javascript
async completeReview() {
  await fetch("/complete", {
    method: "POST",
    headers: { "X-Session-Token": ReviewApp.token },
  });
  // Show summary: N comments (X changes, Y questions, Z approvals)
  // Close tab or show "return to terminal" message
}
```

### 5.8 Comment Applicator (`lib/applicator.ts`)

Reads completed review comments and applies them to the source document via LLM.

```typescript
interface Applicator {
  applyReview(
    manifest: ReviewManifest,
    ctx: ExtensionContext
  ): Promise<ApplyResult>;
}

interface ApplyResult {
  updatedContent: string;
  diff: string;
  changeSummary: string;
}
```

**Application strategy:**

1. Load manifest with comments
2. Group comments by section
3. Check for source drift (compare current file hash vs manifest's `sourceHash`)
   - If drifted: warn user, show which sections changed, ask to proceed
4. Build a prompt for the LLM with:
   - The current source document
   - Each comment annotated with its section, type, and priority
   - Instructions:
     - `change` → modify the section content as requested
     - `concern` → address the concern, add context or modify
     - `question` → add to Open Questions section or address inline
     - `approval` → leave section unchanged
5. LLM generates the updated document
6. Show diff to user via `open_file` in diff mode or `ctx.ui.editor()`
7. User approves → write updated file, mark review as "applied"

**Prompt template:**

```
You are editing a {reviewType} document based on review feedback.

## Source Document
{sourceContent}

## Review Comments
{comments grouped by section, with type and priority}

## Instructions
- Apply "change" comments by modifying the relevant section
- Address "concern" comments by adding context or adjusting the section
- Add "question" comments to the Open Questions section
- Leave "approval" sections unchanged
- Preserve the document structure and formatting
- Do not add or remove sections unless a comment explicitly requests it

Output the complete updated document.
```

## 6. Generation Pipeline

The full generation flow when `/review` is triggered:

```
/review .features/auth/prd.md --lang en
         │
         ▼
    ┌─── Phase 1: Manifest ───┐
    │ Parse markdown           │
    │ Generate section IDs     │
    │ Save manifest (draft)    │   ~instant
    └──────────┬───────────────┘
               │
    ┌──── Phase 2: Parallel ────────────────────┐
    │                                            │
    │  ┌─── Script Generation ───┐  ┌─── Visual ──────┐
    │  │ Sub-agent generates     │  │ MD → HTML        │
    │  │ podcast dialogue        │  │ CSS animations   │
    │  │ ~30-60s                 │  │ ~instant         │
    │  └──────────┬──────────────┘  └─────┬────────────┘
    │             │                       │
    └─────────────┼───────────────────────┘
                  │
    ┌──── Phase 3: TTS ────────────┐
    │ Ensure TTS installed         │
    │ Generate audio from script   │
    │ Record section timestamps    │
    │ Convert WAV → MP3 (ffmpeg)   │   ~2-10 min
    │ Progress: "Section N/M..."   │
    └──────────┬───────────────────┘
               │
    ┌──── Phase 4: Serve ──────────┐
    │ Update manifest with audio   │
    │ Start HTTP server            │
    │ Open browser                 │   ~instant
    │ Notify user                  │
    └──────────────────────────────┘
```

**Progress reporting:**

```typescript
async function generateReview(sourcePath, options, ctx) {
  ctx.ui.setStatus("review-hub", "📋 Parsing document...");

  const manifest = await createManifest(sourcePath, options);
  ctx.ui.setStatus("review-hub", "✍️ Generating podcast script...");

  // Phase 2: parallel
  const [script, _visual] = await Promise.all([
    generateScript(manifest, sourceContent, options.language, (msg) => {
      ctx.ui.setStatus("review-hub", `✍️ Script: ${msg}`);
    }),
    // Visual is generated at serve time from manifest + source
  ]);

  // Phase 3: TTS (only if audio requested)
  if (!options.visualOnly) {
    const provider = selectProvider(options.language);
    if (!await ensureTTSAvailable(provider, ctx.ui)) {
      ctx.ui.notify("TTS not available — generating visual-only review", "warning");
      options.visualOnly = true;
    } else {
      ctx.ui.setStatus("review-hub", "🎙️ Generating audio...");
      const ttsResult = await provider.generateAudio(script, (phase, pct) => {
        ctx.ui.setStatus("review-hub", `🎙️ ${phase} (${Math.round(pct * 100)}%)`);
      });
      // Update manifest with audio timestamps
      manifest.audio = { ... };
    }
  }

  // Phase 4: Serve
  ctx.ui.setStatus("review-hub", "🚀 Starting review server...");
  const { url } = await server.start(manifest, reviewDir);
  await openBrowser(url);
  ctx.ui.setStatus("review-hub", `📝 Review live at ${url}`);
  ctx.ui.notify("Review Hub is ready! Open your browser to start reviewing.", "success");
}
```

## 7. Command & Tool Definitions

### Commands

```typescript
// /review <path> [--audio-only] [--visual-only] [--lang en|es]
pi.registerCommand("review", {
  description: "Generate an interactive review for a PRD or design document",
  handler: async (args, ctx) => {
    const parsed = parseReviewArgs(args);
    await generateReview(parsed.path, parsed.options, ctx);
  },
});

// /review-apply <manifest-path>
pi.registerCommand("review-apply", {
  description: "Apply review comments back to the source document",
  handler: async (args, ctx) => {
    const manifest = await loadManifest(args.trim());
    const result = await applyReview(manifest, ctx);
    // Show diff for approval
  },
});

// /review-list [feature]
pi.registerCommand("review-list", {
  description: "List all reviews for a feature",
  handler: async (args, ctx) => {
    const reviews = await findReviews(args.trim() || ctx.cwd);
    // Display as formatted list
  },
});
```

### Tools

```typescript
pi.registerTool({
  name: "review_document",
  label: "Review Document",
  description: "Generate an interactive review (podcast + visual) for a PRD or design document. Opens a browser with the review web app.",
  parameters: Type.Object({
    path: Type.String({ description: "Path to the markdown file to review" }),
    audioOnly: Type.Optional(Type.Boolean({ description: "Generate audio review only" })),
    visualOnly: Type.Optional(Type.Boolean({ description: "Generate visual review only" })),
    language: Type.Optional(StringEnum(["en", "es"] as const, { description: "Language for podcast" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    await generateReview(params.path, params, ctx);
    return {
      content: [{ type: "text", text: `Review generated and opened in browser.` }],
      details: { manifestPath: "..." },
    };
  },
});

pi.registerTool({
  name: "review_apply",
  label: "Apply Review",
  description: "Apply review comments from a completed review back to the source document.",
  parameters: Type.Object({
    manifestPath: Type.String({ description: "Path to the review manifest JSON" }),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    const manifest = await loadManifest(params.manifestPath);
    const result = await applyReview(manifest, ctx);
    return {
      content: [{ type: "text", text: result.changeSummary }],
      details: { diff: result.diff },
    };
  },
});
```

## 8. Integration Points

| System | Integration | How |
|--------|------------|-----|
| pi extension lifecycle | `session_start`, `session_shutdown` | Server cleanup, orphan recovery |
| pi UI | `ctx.ui.setStatus`, `ctx.ui.notify`, `ctx.ui.confirm` | Progress, notifications, TTS install consent |
| Sub-agent system | `pi.exec()` spawning `pi` in JSON mode | Script generation via dedicated agent |
| Python ecosystem | `pi.exec()` spawning venv Python | TTS audio generation |
| ffmpeg | `pi.exec("ffmpeg", [...])` | WAV → MP3 conversion |
| Browser | `pi.exec("open", [url])` on macOS | Open review web app |
| Filesystem | `node:fs` | Manifest, audio, reviews read/write |
| Existing PRD/design skills | None — reads their output files | Fully decoupled |

## 9. Trade-offs & Alternatives

### Decision: Ephemeral server vs persistent daemon
- **Chosen:** Ephemeral (lives within pi session)
- **Alternative:** Persistent background daemon surviving restarts
- **Why:** Much simpler lifecycle. Reviews and comments persist to disk, so restarting just means re-serving existing artifacts. No auth/versioning/orphan complexity.

### Decision: Vanilla web app vs React/Vue
- **Chosen:** Vanilla HTML/JS/CSS
- **Alternative:** Bundled React/Preact with a build step
- **Why:** No build toolchain needed, simpler extension packaging, total code is manageable (~500-800 lines JS). State is constrained to manifest + comments array. If complexity grows, we can migrate later.

### Decision: Worker process for TTS vs spawn-per-section
- **Chosen:** Single Python worker per generation job (processes all sections sequentially)
- **Alternative:** Spawn a new Python process per section
- **Why:** Model loading dominates cost (~30-60s). Loading once and processing all sections sequentially is far faster than reloading per section. Worker reports progress per section via stdout JSON lines.

### Decision: Section-sized TTS chunks vs full-document pass
- **Chosen:** Section-sized chunks with gaps between them
- **Alternative:** Full document in one Dia generation pass
- **Why:** Section chunks give us accurate per-section timestamps for the waveform mapping. Full-document pass would require word-level alignment to map back to sections. Small silence gaps (200-500ms) between sections sound natural and create clear boundaries.

### Decision: Vendored wavesurfer.js vs CDN
- **Chosen:** Vendored in extension
- **Alternative:** Load from CDN at runtime
- **Why:** Works offline. No version drift. CDN failure can't break the extension.

### Decision: Sub-agent for script vs main LLM session
- **Chosen:** Dedicated sub-agent
- **Alternative:** Generate script in the main pi session
- **Why:** Script generation needs a specialized system prompt (~screenwriter quality). Using the main session would pollute context and conflict with the general-purpose agent prompt. Isolated sub-agent gets a focused prompt and doesn't consume main session tokens.

## 10. Open Questions

- [ ] **Dia model version** — Dia-1.6B is the current best. Should we support a model selection flag for future versions?
- [ ] **Audio caching** — If the source document hasn't changed, should we skip audio regeneration and reuse the previous review's audio?
- [ ] **Concurrent reviews** — Can we serve multiple review sessions simultaneously (different features)? Would need per-review ports or path-based routing.
- [ ] **Comment threading** — Should comments support replies/threads, or keep it flat for v1?
- [ ] **Visual-only reviews** — When TTS is unavailable, the visual review works standalone. Should we make visual-only the default and audio opt-in to reduce first-run friction?
- [ ] **Script editing** — Should users be able to edit the generated podcast script before TTS synthesis, to fix hallucinations or adjust emphasis?
