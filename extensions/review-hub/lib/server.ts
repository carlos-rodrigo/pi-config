/**
 * Review Hub HTTP server — ephemeral local server for the review web app.
 *
 * Serves static web files, the review manifest, audio, and source markdown.
 * Handles comment CRUD via POST endpoints authenticated with a session token.
 * Binds to 127.0.0.1 only for security.
 */

import * as http from "node:http";
import * as net from "node:net";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { ReviewManifest, ReviewComment } from "./manifest.js";
import { saveManifest, loadManifest } from "./manifest.js";
import { generateVisual, generateVisualStyles } from "./visual-generator.js";

// ── Types ──────────────────────────────────────────────────────────────────

export interface ReviewServer {
  start(manifest: ReviewManifest, reviewDir: string): Promise<{ port: number; url: string }>;
  stop(): Promise<void>;
  isRunning(): boolean;
}

interface ServerState {
  httpServer: http.Server;
  port: number;
  sessionToken: string;
  manifest: ReviewManifest;
  reviewDir: string;
}

// ── Lock File ──────────────────────────────────────────────────────────────

const LOCK_DIR = path.join(os.homedir(), ".pi", "review-hub");
const LOCK_FILE = path.join(LOCK_DIR, "server.lock");

interface LockInfo {
  pid: number;
  port: number;
  startedAt: string;
}

function writeLockFile(pid: number, port: number): void {
  fs.mkdirSync(LOCK_DIR, { recursive: true });
  const lock: LockInfo = { pid, port, startedAt: new Date().toISOString() };
  fs.writeFileSync(LOCK_FILE, JSON.stringify(lock, null, 2), "utf-8");
}

function removeLockFile(): void {
  try {
    fs.unlinkSync(LOCK_FILE);
  } catch {
    // Ignore — file may already be gone
  }
}

function readLockFile(): LockInfo | null {
  try {
    const content = fs.readFileSync(LOCK_FILE, "utf-8");
    return JSON.parse(content) as LockInfo;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = check existence
    return true;
  } catch {
    return false;
  }
}

/**
 * Clean up orphan server lock files from crashed sessions.
 * Call on session_start to recover from previous crashes.
 */
export function cleanupOrphanServers(): { cleaned: boolean; warning?: string } {
  const lock = readLockFile();
  if (!lock) {
    return { cleaned: false };
  }

  if (!isProcessAlive(lock.pid)) {
    // Process is dead — remove stale lock
    removeLockFile();
    return { cleaned: true };
  }

  // Process is alive but might be from a different session
  if (lock.pid !== process.pid) {
    return {
      cleaned: false,
      warning: `Review server may already be running (PID ${lock.pid} on port ${lock.port}, started ${lock.startedAt})`,
    };
  }

  return { cleaned: false };
}

// ── Port Selection ─────────────────────────────────────────────────────────

const PORT_RANGE_START = 3847;
const PORT_RANGE_END = 3947;

/**
 * Find an available port in the range 3847–3947.
 * Tests by attempting to bind a temporary server.
 */
async function findAvailablePort(): Promise<number> {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    const available = await testPort(port);
    if (available) return port;
  }
  throw new Error(`No available port found in range ${PORT_RANGE_START}–${PORT_RANGE_END}`);
}

function testPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

// ── Content Types ──────────────────────────────────────────────────────────

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".md": "text/markdown; charset=utf-8",
};

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// ── Server Implementation ──────────────────────────────────────────────────

export function createReviewServer(): ReviewServer {
  let state: ServerState | null = null;

  // Visual cache: HTML + CSS generated from source markdown
  let visualCache: { html: string; css: string; sourceHash: string } | null = null;

  // Resolve the extension's web directory (relative to this file)
  const extensionDir = path.resolve(path.dirname(import.meta.url.replace("file://", "")), "..");
  const webDir = path.join(extensionDir, "web");

  async function start(
    manifest: ReviewManifest,
    reviewDir: string,
  ): Promise<{ port: number; url: string }> {
    if (state) {
      throw new Error("Server is already running. Call stop() first.");
    }

    const port = await findAvailablePort();
    const sessionToken = crypto.randomUUID();
    const resolvedReviewDir = path.resolve(reviewDir);

    const httpServer = http.createServer((req, res) => {
      // CORS: restrict to same origin
      res.setHeader("Access-Control-Allow-Origin", `http://127.0.0.1:${port}`);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Session-Token");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "GET") {
        handleGet(req, res, sessionToken, resolvedReviewDir, webDir);
        return;
      }

      if (req.method === "POST" || req.method === "DELETE") {
        handleMutation(req, res, sessionToken, resolvedReviewDir);
        return;
      }

      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
    });

    // Store state for mutation handlers
    state = { httpServer, port, sessionToken, manifest, reviewDir: resolvedReviewDir };

    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, "127.0.0.1", () => resolve());
    });

    writeLockFile(process.pid, port);

    const url = `http://127.0.0.1:${port}?token=${sessionToken}`;
    return { port, url };
  }

  async function stop(): Promise<void> {
    if (!state) return;

    const { httpServer } = state;
    state = null;

    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });

    removeLockFile();
  }

  function isRunning(): boolean {
    return state !== null;
  }

  // ── GET handler ────────────────────────────────────────────────────────

  function handleGet(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    _token: string,
    reviewDir: string,
    webDir: string,
  ): void {
    const url = new URL(req.url ?? "/", `http://127.0.0.1`);
    const pathname = url.pathname;

    // Static web files — strict allowlist, no path traversal
    const staticRoutes: Record<string, { file: string; dir: string }> = {
      "/": { file: "index.html", dir: webDir },
      "/styles.css": { file: "styles.css", dir: webDir },
      "/app.js": { file: "app.js", dir: webDir },
      "/wavesurfer.js": { file: path.join("vendor", "wavesurfer.min.js"), dir: webDir },
    };

    const staticRoute = staticRoutes[pathname];
    if (staticRoute) {
      const filePath = path.join(staticRoute.dir, staticRoute.file);
      return serveFile(res, filePath);
    }

    // Manifest
    if (pathname === "/manifest.json") {
      if (!state) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("Server not ready");
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(state.manifest, null, 2));
      return;
    }

    // Audio file
    if (pathname === "/audio") {
      if (!state?.manifest.audio?.file) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("No audio available");
        return;
      }
      const audioPath = path.join(reviewDir, state.manifest.audio.file);
      return serveFile(res, audioPath);
    }

    // Source markdown
    if (pathname === "/source") {
      if (!state) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("Server not ready");
        return;
      }
      const sourcePath = path.resolve(state.manifest.source);
      return serveFile(res, sourcePath);
    }

    // Visual HTML (generated from markdown, cached)
    if (pathname === "/visual") {
      if (!state) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("Server not ready");
        return;
      }
      try {
        const visual = getVisualHtml(state.manifest);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(visual.html);
      } catch (err) {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Failed to generate visual");
      }
      return;
    }

    // Visual CSS
    if (pathname === "/visual-styles") {
      if (!state) {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("Server not ready");
        return;
      }
      const visual = getVisualHtml(state.manifest);
      res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
      res.end(visual.css);
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not Found");
  }

  function getVisualHtml(manifest: ReviewManifest): { html: string; css: string } {
    // Check cache
    if (visualCache && visualCache.sourceHash === manifest.sourceHash) {
      return { html: visualCache.html, css: visualCache.css };
    }

    // Read source and generate
    const sourcePath = path.resolve(manifest.source);
    const sourceContent = fs.readFileSync(sourcePath, "utf-8");
    const html = generateVisual(manifest, sourceContent);
    const css = generateVisualStyles();

    // Cache it
    visualCache = { html, css, sourceHash: manifest.sourceHash };
    return { html, css };
  }

  function serveFile(res: http.ServerResponse, filePath: string): void {
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("File not found");
      return;
    }

    try {
      const content = fs.readFileSync(filePath);
      const contentType = getContentType(filePath);
      res.writeHead(200, { "Content-Type": contentType });
      res.end(content);
    } catch {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal Server Error");
    }
  }

  // ── Mutation handler (POST/DELETE) ─────────────────────────────────────

  function handleMutation(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    sessionToken: string,
    reviewDir: string,
  ): void {
    // Validate session token
    const providedToken = req.headers["x-session-token"];
    if (providedToken !== sessionToken) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid or missing session token" }));
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1`);
    const pathname = url.pathname;

    // Collect body
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      // Limit body size to 1MB
      if (body.length > 1_000_000) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request body too large" }));
        req.destroy();
      }
    });

    req.on("end", async () => {
      try {
        if (req.method === "POST" && pathname === "/comments") {
          await handleAddComment(body, res, reviewDir);
        } else if (req.method === "POST" && pathname === "/complete") {
          await handleComplete(res, reviewDir);
        } else if (req.method === "DELETE" && pathname.startsWith("/comments/")) {
          const commentId = pathname.slice("/comments/".length);
          await handleDeleteComment(commentId, res, reviewDir);
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not Found" }));
        }
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal Server Error" }));
      }
    });
  }

  async function handleAddComment(
    body: string,
    res: http.ServerResponse,
    reviewDir: string,
  ): Promise<void> {
    if (!state) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server not ready" }));
      return;
    }

    let commentData: Partial<ReviewComment>;
    try {
      commentData = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    // Validate required fields
    if (!commentData.sectionId || !commentData.type || !commentData.priority || !commentData.text) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: "Missing required fields: sectionId, type, priority, text" }),
      );
      return;
    }

    // Validate comment type
    const validTypes = ["change", "question", "approval", "concern"];
    if (!validTypes.includes(commentData.type!)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Invalid comment type. Must be one of: ${validTypes.join(", ")}` }));
      return;
    }

    // Validate priority
    const validPriorities = ["high", "medium", "low"];
    if (!validPriorities.includes(commentData.priority!)) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Invalid priority. Must be one of: ${validPriorities.join(", ")}` }));
      return;
    }

    // Validate sectionId exists in manifest
    const sectionExists = state.manifest.sections.some((s) => s.id === commentData.sectionId);
    if (!sectionExists) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Unknown section: ${commentData.sectionId}` }));
      return;
    }

    // Build comment
    const comment: ReviewComment = {
      id: commentData.id ?? crypto.randomUUID(),
      sectionId: commentData.sectionId!,
      audioTimestamp: commentData.audioTimestamp,
      type: commentData.type as ReviewComment["type"],
      priority: commentData.priority as ReviewComment["priority"],
      text: commentData.text!,
      createdAt: commentData.createdAt ?? new Date().toISOString(),
    };

    // Check if updating existing comment
    const existingIdx = state.manifest.comments.findIndex((c) => c.id === comment.id);
    if (existingIdx >= 0) {
      state.manifest.comments[existingIdx] = comment;
    } else {
      state.manifest.comments.push(comment);
    }

    // Update status to in-progress if first comment
    if (state.manifest.status === "ready" || state.manifest.status === "generating") {
      state.manifest.status = "in-progress";
    }

    await saveManifest(state.manifest, reviewDir);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(comment));
  }

  async function handleComplete(
    res: http.ServerResponse,
    reviewDir: string,
  ): Promise<void> {
    if (!state) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server not ready" }));
      return;
    }

    state.manifest.status = "reviewed";
    state.manifest.completedAt = new Date().toISOString();

    await saveManifest(state.manifest, reviewDir);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "reviewed",
        completedAt: state.manifest.completedAt,
        commentCount: state.manifest.comments.length,
      }),
    );
  }

  async function handleDeleteComment(
    commentId: string,
    res: http.ServerResponse,
    reviewDir: string,
  ): Promise<void> {
    if (!state) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server not ready" }));
      return;
    }

    const idx = state.manifest.comments.findIndex((c) => c.id === commentId);
    if (idx < 0) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Comment not found: ${commentId}` }));
      return;
    }

    state.manifest.comments.splice(idx, 1);
    await saveManifest(state.manifest, reviewDir);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ deleted: commentId }));
  }

  return { start, stop, isRunning };
}
