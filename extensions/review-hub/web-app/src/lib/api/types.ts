import type {
  ReviewComment as BackendReviewComment,
  ReviewManifest as BackendReviewManifest,
} from "../../../../lib/manifest";

export type ReviewManifest = BackendReviewManifest;
export type ReviewComment = BackendReviewComment;

export type CommentType = ReviewComment["type"];
export type CommentPriority = ReviewComment["priority"];

export interface SaveCommentInput {
  id?: string;
  sectionId: string;
  audioTimestamp?: number;
  type: CommentType;
  priority: CommentPriority;
  text: string;
  status?: ReviewComment["status"];
  anchor?: ReviewComment["anchor"];
}

export interface CompleteReviewResponse {
  status: ReviewManifest["status"];
  completedAt: string;
  commentCount: number;
}

/** A renderable section from the canonical /visual-model endpoint. */
export interface RenderSection {
  sectionId: string;
  headingPath: string[];
  headingLevel: number;
  markdown: string;
  sourceTextHash: string;
}

export interface VisualModelResponse {
  sections: RenderSection[];
}

export interface ExportFeedbackResponse {
  markdown: string;
  exportHash: string;
  stats: {
    totalComments: number;
    openComments: number;
    resolvedComments: number;
  };
}

export interface FinishRequest {
  idempotencyKey: string;
  exportHash: string;
  clipboardMode: "browser" | "backend-fallback";
}

export interface FinishResponse {
  success: boolean;
  handedOff: boolean;
  copiedByBackend?: boolean;
  warning?: string;
}
