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
  createdAt?: string;
}

export interface CompleteReviewResponse {
  status: ReviewManifest["status"];
  completedAt: string;
  commentCount: number;
}
