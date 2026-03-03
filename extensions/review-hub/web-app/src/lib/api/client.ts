import type {
  CompleteReviewResponse,
  ExportFeedbackResponse,
  FinishRequest,
  FinishResponse,
  ReviewComment,
  ReviewManifest,
  SaveCommentInput,
  VisualModelResponse,
} from "@/lib/api/types";

const DEFAULT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 600;

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface ReviewApiClientOptions {
  retries?: number;
  retryDelayMs?: number;
}

export class ReviewApiClient {
  private readonly retries: number;
  private readonly retryDelayMs: number;

  constructor(
    private readonly token: string,
    options: ReviewApiClientOptions = {},
  ) {
    this.retries = options.retries ?? DEFAULT_RETRIES;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  }

  async fetchManifest(): Promise<ReviewManifest> {
    return this.request<ReviewManifest>("/manifest.json");
  }

  async saveComment(input: SaveCommentInput): Promise<ReviewComment> {
    return this.request<ReviewComment>("/comments", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async deleteComment(commentId: string): Promise<{ deleted: string }> {
    return this.request<{ deleted: string }>(`/comments/${encodeURIComponent(commentId)}`, {
      method: "DELETE",
    });
  }

  async completeReview(): Promise<CompleteReviewResponse> {
    return this.request<CompleteReviewResponse>("/complete", {
      method: "POST",
    });
  }

  async fetchVisualModel(): Promise<VisualModelResponse> {
    return this.request<VisualModelResponse>("/visual-model");
  }

  async exportFeedback(scope?: "open" | "all"): Promise<ExportFeedbackResponse> {
    return this.request<ExportFeedbackResponse>("/export-feedback", {
      method: "POST",
      body: JSON.stringify(scope ? { scope } : {}),
    });
  }

  async finish(request: FinishRequest): Promise<FinishResponse> {
    return this.request<FinishResponse>("/finish", {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  async clipboardCopy(markdown: string): Promise<{ copied: boolean; warning?: string }> {
    return this.request<{ copied: boolean; warning?: string }>("/clipboard/copy", {
      method: "POST",
      body: JSON.stringify({ markdown }),
    });
  }

  private async request<T>(input: string, init: RequestInit = {}): Promise<T> {
    let attempt = 0;
    let lastError: unknown = null;

    while (attempt <= this.retries) {
      try {
        const headers = new Headers(init.headers);
        headers.set("X-Session-Token", this.token);
        if (init.body && !headers.has("Content-Type")) {
          headers.set("Content-Type", "application/json");
        }

        const response = await fetch(input, {
          ...init,
          headers,
        });

        const text = await response.text();
        const data = text ? tryParseJson(text) : null;

        if (!response.ok) {
          const message =
            (data && typeof data === "object" && "error" in data && typeof data.error === "string"
              ? data.error
              : null) ?? `Request failed with status ${response.status}`;

          throw new ApiError(message, response.status);
        }

        return (data as T) ?? ({} as T);
      } catch (error) {
        lastError = error;

        if (error instanceof ApiError) {
          throw error;
        }

        if (attempt >= this.retries) {
          break;
        }

        await sleep(this.retryDelayMs * (attempt + 1));
        attempt += 1;
      }
    }

    throw new Error(
      `Network request failed after ${this.retries + 1} attempt${this.retries === 0 ? "" : "s"}`,
      { cause: lastError },
    );
  }
}

function tryParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
