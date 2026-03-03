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
