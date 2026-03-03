/**
 * CommentService — validates, normalizes, and persists review comments.
 *
 * Extracts comment CRUD logic from the monolithic server handler into a
 * focused service boundary. Handles anchor validation, status management,
 * and manifest persistence.
 */

import type { ReviewManifest, ReviewComment, ReviewCommentAnchor } from "../manifest.js";
import { saveManifest } from "../manifest.js";
import * as crypto from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────────────

export interface CommentInput {
  id?: string;
  sectionId: string;
  type: ReviewComment["type"];
  priority: ReviewComment["priority"];
  text: string;
  status?: ReviewComment["status"];
  audioTimestamp?: number;
  anchor?: ReviewCommentAnchor;
}

export type CommentServiceResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string; status: number };

// ── Service ────────────────────────────────────────────────────────────────

export class CommentService {
  constructor(
    private getManifest: () => ReviewManifest | null,
    private getReviewDir: () => string,
  ) {}

  async upsert(input: CommentInput): Promise<CommentServiceResult<ReviewComment>> {
    const manifest = this.getManifest();
    if (!manifest) {
      return { ok: false, error: "Server not ready", status: 503 };
    }

    // Validate required fields
    if (!input.sectionId || !input.type || !input.priority || !input.text) {
      return {
        ok: false,
        error: "Missing required fields: sectionId, type, priority, text",
        status: 400,
      };
    }

    // Validate comment type
    const validTypes: ReviewComment["type"][] = ["change", "question", "approval", "concern"];
    if (!validTypes.includes(input.type)) {
      return {
        ok: false,
        error: `Invalid comment type. Must be one of: ${validTypes.join(", ")}`,
        status: 400,
      };
    }

    // Validate priority
    const validPriorities: ReviewComment["priority"][] = ["high", "medium", "low"];
    if (!validPriorities.includes(input.priority)) {
      return {
        ok: false,
        error: `Invalid priority. Must be one of: ${validPriorities.join(", ")}`,
        status: 400,
      };
    }

    // Validate status
    const validStatuses: NonNullable<ReviewComment["status"]>[] = ["open", "resolved"];
    if (input.status != null && !validStatuses.includes(input.status)) {
      return {
        ok: false,
        error: `Invalid status. Must be one of: ${validStatuses.join(", ")}`,
        status: 400,
      };
    }

    // Validate sectionId exists
    const sectionExists = manifest.sections.some((s) => s.id === input.sectionId);
    if (!sectionExists) {
      return { ok: false, error: `Unknown section: ${input.sectionId}`, status: 400 };
    }

    const commentId = input.id ?? crypto.randomUUID();
    const existingIdx = manifest.comments.findIndex((c) => c.id === commentId);
    const existingComment = existingIdx >= 0 ? manifest.comments[existingIdx] : undefined;
    const now = new Date().toISOString();

    const comment: ReviewComment = {
      id: commentId,
      sectionId: input.sectionId,
      audioTimestamp: input.audioTimestamp,
      type: input.type,
      priority: input.priority,
      text: input.text,
      createdAt: existingComment?.createdAt ?? now,
      status: input.status ?? existingComment?.status ?? "open",
      updatedAt: now,
    };

    if (input.anchor) {
      comment.anchor = input.anchor;
    }

    if (existingIdx >= 0) {
      manifest.comments[existingIdx] = comment;
    } else {
      manifest.comments.push(comment);
    }

    // Update status to in-progress if first comment
    if (manifest.status === "ready" || manifest.status === "generating") {
      manifest.status = "in-progress";
    }

    await saveManifest(manifest, this.getReviewDir());

    return { ok: true, data: comment };
  }

  async delete(commentId: string): Promise<CommentServiceResult<{ deleted: string }>> {
    const manifest = this.getManifest();
    if (!manifest) {
      return { ok: false, error: "Server not ready", status: 503 };
    }

    const idx = manifest.comments.findIndex((c) => c.id === commentId);
    if (idx < 0) {
      return { ok: false, error: `Comment not found: ${commentId}`, status: 404 };
    }

    manifest.comments.splice(idx, 1);
    await saveManifest(manifest, this.getReviewDir());

    return { ok: true, data: { deleted: commentId } };
  }
}
