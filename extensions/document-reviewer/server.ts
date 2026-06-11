import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { SubmitPullRequestReviewInput } from "./github-pr.js";
import { buildPullRequestDiffMap, getRightSideInlineCommentTarget } from "./pr-diff-map.js";
import { buildReviewPage } from "./review-page.js";

export type ReviewSessionMode = "document" | "pull_request";

export interface ReviewSession {
	sessionId: string;
	title: string;
	filePath: string;
	reviewUrl: string;
	healthUrl: string;
	documentUrl: string;
}

export interface ReviewComment {
	id: string;
	selectedText: string;
	comment: string;
	/** Character offset in the original markdown where the selected text starts */
	offsetStart: number;
	/** Character offset in the original markdown where the selected text ends */
	offsetEnd: number;
	lineStart?: number;
	lineEnd?: number;
	inlineEligible?: boolean;
	fallbackReason?: string;
}

export interface PullRequestReviewContext {
	owner: string;
	repo: string;
	number: number;
	headSha: string;
	baseSha: string;
	filePath: string;
	worktreePath: string;
	title?: string;
	url?: string;
}

export interface PullRequestFinishInput {
	comments: ReviewComment[];
	pullRequest: PullRequestReviewContext;
	filePath: string;
	markdown: string;
	title: string;
}

export interface PullRequestFinishResult {
	status: string;
	inlineComments: number;
	fallbackComments: number;
	errorComments: number;
	cleanupAttempted: boolean;
	cleanupError?: string;
}

export interface PullRequestCleanupResult {
	ok: boolean;
	error?: string;
}

export interface PullRequestPublishDependencies {
	refreshMetadata: () => Promise<{ headSha: string }>;
	refreshFiles: () => Promise<readonly { filename: string; patch?: string | null }[]>;
	submitReview: (input: SubmitPullRequestReviewInput) => Promise<unknown>;
	cleanupWorktree?: () => Promise<PullRequestCleanupResult>;
	isInlineValidationFailure?: (error: unknown) => boolean;
}

export interface CreatePullRequestSessionOptions {
	filePath: string;
	pullRequest: PullRequestReviewContext;
	onPublishReview?: (input: PullRequestFinishInput) => Promise<PullRequestFinishResult>;
}

interface BaseActiveSession {
	sessionId: string;
	filePath: string;
	title: string;
	markdown: string;
	comments: ReviewComment[];
	onFinish?: (comments: ReviewComment[]) => void;
	mode: ReviewSessionMode;
}

interface DocumentActiveSession extends BaseActiveSession {
	mode: "document";
}

interface PullRequestActiveSession extends BaseActiveSession {
	mode: "pull_request";
	pullRequest: PullRequestReviewContext;
	onPublishReview?: (input: PullRequestFinishInput) => Promise<PullRequestFinishResult>;
}

type ActiveSession = DocumentActiveSession | PullRequestActiveSession;

class RequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "RequestError";
	}
}

let service: DocumentReviewService | undefined;

export async function getDocumentReviewService(): Promise<DocumentReviewService> {
	if (!service) {
		service = new DocumentReviewService();
		await service.start();
	}
	return service;
}

const FALLBACK_SNIPPET_LIMIT = 180;

function normalizeFallbackText(text: string): string {
	return text.replace(/\r\n?/g, "\n").trim();
}

function escapeFallbackMarkdown(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\\/g, "\\\\")
		.replace(/([`*_#[\]|])/g, "\\$1");
}

function truncateFallbackSnippet(text: string): string {
	if (text.length <= FALLBACK_SNIPPET_LIMIT) return text;
	return `${text.slice(0, FALLBACK_SNIPPET_LIMIT - 1).trimEnd()}…`;
}

export function buildFallbackReviewBody(filePath: string, comments: readonly ReviewComment[]): string | undefined {
	if (comments.length === 0) return undefined;

	const entries = comments.map((comment) => {
		const location = comment.lineStart ? `${filePath}:${comment.lineStart}` : filePath;
		const snippet = truncateFallbackSnippet(normalizeFallbackText(comment.selectedText).replace(/\s+/g, " "));
		const note = normalizeFallbackText(comment.comment);
		return [
			`- \`${escapeFallbackMarkdown(location)}\``,
			`  - Snippet: ${escapeFallbackMarkdown(snippet || "(empty selection)")}`,
			`  - Note: ${escapeFallbackMarkdown(note || "(empty note)")}`,
		].join("\n");
	});

	return ["### Fallback comments", "", ...entries].join("\n\n");
}

export async function publishPullRequestReview(
	input: PullRequestFinishInput,
	dependencies: PullRequestPublishDependencies,
): Promise<PullRequestFinishResult> {
	const result: PullRequestFinishResult = {
		status: "no_comments",
		inlineComments: 0,
		fallbackComments: 0,
		errorComments: 0,
		cleanupAttempted: false,
	};

	let pendingError: unknown;
	try {
		if (input.comments.length === 0) {
			return result;
		}

		const metadata = await dependencies.refreshMetadata();
		const files = await dependencies.refreshFiles();
		const diffMap = buildPullRequestDiffMap(files);
		const headShaChanged = metadata.headSha !== input.pullRequest.headSha;
		const commentTargets = headShaChanged
			? input.comments.map((comment) => ({ comment, target: null }))
			: input.comments.map((comment) => ({
				comment,
				target: getRightSideInlineCommentTarget(
					{
						filePath: input.pullRequest.filePath,
						lineStart: comment.lineStart,
						lineEnd: comment.lineEnd,
					},
					diffMap,
				),
			}));
		const inlineComments = commentTargets.flatMap(({ comment, target }) => (target ? [{ ...target, body: comment.comment }] : []));
		const fallbackComments = commentTargets.filter(({ target }) => target === null).map(({ comment }) => comment);

		const submitRequest = {
			commitId: metadata.headSha,
			comments: inlineComments,
			body: buildFallbackReviewBody(input.pullRequest.filePath, fallbackComments),
		};

		try {
			await dependencies.submitReview(submitRequest);
			result.status = "submitted";
			result.inlineComments = inlineComments.length;
			result.fallbackComments = fallbackComments.length;
			return result;
		} catch (error) {
			if (inlineComments.length > 0 && dependencies.isInlineValidationFailure?.(error)) {
				await dependencies.submitReview({
					commitId: metadata.headSha,
					comments: [],
					body: buildFallbackReviewBody(input.pullRequest.filePath, input.comments),
				});
				result.status = "submitted_with_fallback_retry";
				result.inlineComments = 0;
				result.fallbackComments = input.comments.length;
				return result;
			}
			throw error;
		}
	} catch (error) {
		pendingError = error;
	} finally {
		if (dependencies.cleanupWorktree) {
			result.cleanupAttempted = true;
			try {
				const cleanupResult = await dependencies.cleanupWorktree();
				if (!cleanupResult.ok && cleanupResult.error) {
					result.cleanupError = cleanupResult.error;
				}
			} catch (error) {
				result.cleanupError = error instanceof Error ? error.message : String(error);
			}
		}
	}

	if (pendingError) {
		throw pendingError;
	}
	return result;
}

export class DocumentReviewService {
	private server: http.Server | undefined;
	private port = 0;
	private sessions = new Map<string, ActiveSession>();

	async start(): Promise<void> {
		if (this.server) return;

		return new Promise((resolve, reject) => {
			this.server = http.createServer((req, res) => this.handleRequest(req, res));

			this.server.on("error", reject);
			this.server.listen(0, "127.0.0.1", () => {
				const addr = this.server!.address();
				if (addr && typeof addr === "object") {
					this.port = addr.port;
				}
				resolve();
			});
		});
	}

	async stop(): Promise<void> {
		if (!this.server) return;

		const server = this.server;
		this.server = undefined;
		this.port = 0;
		this.sessions.clear();
		if (service === this) {
			service = undefined;
		}

		await new Promise<void>((resolve, reject) => {
			server.close((error) => {
				if (error) {
					reject(error);
					return;
				}
				resolve();
			});
		});
	}

	async createSession(filePath: string): Promise<ReviewSession> {
		return this.createStoredSession({ mode: "document", filePath });
	}

	async createPullRequestSession(options: CreatePullRequestSessionOptions): Promise<ReviewSession> {
		return this.createStoredSession({
			mode: "pull_request",
			filePath: options.filePath,
			pullRequest: options.pullRequest,
			onPublishReview: options.onPublishReview,
		});
	}

	waitForFinish(sessionId: string): Promise<ReviewComment[]> {
		return new Promise((resolve) => {
			const session = this.sessions.get(sessionId);
			if (!session) {
				resolve([]);
				return;
			}
			session.onFinish = resolve;
		});
	}

	private async createStoredSession(
		options:
			| { mode: "document"; filePath: string }
			| { mode: "pull_request"; filePath: string; pullRequest: PullRequestReviewContext; onPublishReview?: CreatePullRequestSessionOptions["onPublishReview"] },
	): Promise<ReviewSession> {
		const markdown = await fs.promises.readFile(options.filePath, "utf-8");
		const sessionId = crypto.randomBytes(8).toString("hex");
		const title = path.basename(options.filePath);

		const session: ActiveSession =
			options.mode === "pull_request"
				? {
					sessionId,
					filePath: options.filePath,
					title,
					markdown,
					comments: [],
					mode: "pull_request",
					pullRequest: options.pullRequest,
					onPublishReview: options.onPublishReview,
				}
				: {
					sessionId,
					filePath: options.filePath,
					title,
					markdown,
					comments: [],
					mode: "document",
				};

		this.sessions.set(sessionId, session);
		return this.buildSessionResponse(session);
	}

	private buildSessionResponse(session: ActiveSession): ReviewSession {
		const base = `http://127.0.0.1:${this.port}`;
		return {
			sessionId: session.sessionId,
			title: session.title,
			filePath: session.filePath,
			reviewUrl: `${base}/review/${session.sessionId}`,
			healthUrl: `${base}/health`,
			documentUrl: `${base}/api/${session.sessionId}/document`,
		};
	}

	private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
		const pathname = url.pathname;

		if (!this.applyLocalOriginHeaders(req, res)) {
			this.sendJson(res, 403, { error: "Origin not allowed" });
			return;
		}

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		try {
			if (pathname === "/health") {
				this.sendJson(res, 200, { status: "ok", sessions: this.sessions.size });
				return;
			}

			// GET /review/:sessionId — serve the review page
			const reviewMatch = pathname.match(/^\/review\/([a-f0-9]+)$/);
			if (reviewMatch && req.method === "GET") {
				const session = this.sessions.get(reviewMatch[1]!);
				if (!session) {
					this.sendJson(res, 404, { error: "Session not found" });
					return;
				}
				const html = buildReviewPage(session.sessionId, session.title);
				res.writeHead(200, {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "no-store, no-cache, must-revalidate",
					Pragma: "no-cache",
					Expires: "0",
				});
				res.end(html);
				return;
			}

			// GET /api/:sessionId/document — return the markdown content
			const docMatch = pathname.match(/^\/api\/([a-f0-9]+)\/document$/);
			if (docMatch && req.method === "GET") {
				const session = this.sessions.get(docMatch[1]!);
				if (!session) {
					this.sendJson(res, 404, { error: "Session not found" });
					return;
				}
				this.sendJson(res, 200, {
					mode: session.mode,
					title: session.title,
					markdown: session.markdown,
					filePath: session.filePath,
					pullRequest: session.mode === "pull_request" ? session.pullRequest : null,
				});
				return;
			}

			// GET /api/:sessionId/comments — return current comments
			const commentsGetMatch = pathname.match(/^\/api\/([a-f0-9]+)\/comments$/);
			if (commentsGetMatch && req.method === "GET") {
				const session = this.sessions.get(commentsGetMatch[1]!);
				if (!session) {
					this.sendJson(res, 404, { error: "Session not found" });
					return;
				}
				this.sendJson(res, 200, { comments: session.comments });
				return;
			}

			// POST /api/:sessionId/comments — add a comment
			const commentsPostMatch = pathname.match(/^\/api\/([a-f0-9]+)\/comments$/);
			if (commentsPostMatch && req.method === "POST") {
				const session = this.sessions.get(commentsPostMatch[1]!);
				if (!session) {
					this.sendJson(res, 404, { error: "Session not found" });
					return;
				}
				const body = await this.readBody(req);
				const data = JSON.parse(body) as Record<string, unknown>;
				const comment = this.createComment(session, data);
				session.comments.push(comment);
				this.sendJson(res, 201, { comment });
				return;
			}

			// DELETE /api/:sessionId/comments/:commentId — delete a comment
			const commentDeleteMatch = pathname.match(/^\/api\/([a-f0-9]+)\/comments\/([a-f0-9]+)$/);
			if (commentDeleteMatch && req.method === "DELETE") {
				const session = this.sessions.get(commentDeleteMatch[1]!);
				if (!session) {
					this.sendJson(res, 404, { error: "Session not found" });
					return;
				}
				const commentId = commentDeleteMatch[2];
				session.comments = session.comments.filter((c) => c.id !== commentId);
				this.sendJson(res, 200, { deleted: commentId });
				return;
			}

			// POST /api/:sessionId/finish — finish the review and branch by session mode
			const finishMatch = pathname.match(/^\/api\/([a-f0-9]+)\/finish$/);
			if (finishMatch && req.method === "POST") {
				const session = this.sessions.get(finishMatch[1]!);
				if (!session) {
					this.sendJson(res, 404, { error: "Session not found" });
					return;
				}

				const comments = [...session.comments];
				const responsePayload =
					session.mode === "pull_request"
						? await this.finishPullRequestSession(session, comments)
						: await this.finishDocumentSession(session, comments);

				if (session.onFinish) {
					session.onFinish(comments);
				}

				this.sessions.delete(finishMatch[1]!);
				this.sendJson(res, 200, responsePayload);
				return;
			}

			this.sendJson(res, 404, { error: "Not found" });
		} catch (error) {
			if (error instanceof RequestError) {
				this.sendJson(res, error.status, { error: error.message });
				return;
			}
			const message = error instanceof Error ? error.message : String(error);
			this.sendJson(res, 500, { error: message });
		}
	}

	private async finishDocumentSession(session: DocumentActiveSession, comments: ReviewComment[]) {
		const annotated = this.insertCommentsIntoMarkdown(session.markdown, comments);
		await fs.promises.writeFile(session.filePath, annotated, "utf-8");
		return {
			status: "finished",
			mode: session.mode,
			commentsWritten: comments.length,
			filePath: session.filePath,
		};
	}

	private async finishPullRequestSession(session: PullRequestActiveSession, comments: ReviewComment[]) {
		const publishResult = session.onPublishReview
			? await session.onPublishReview({
				comments,
				pullRequest: session.pullRequest,
				filePath: session.filePath,
				markdown: session.markdown,
				title: session.title,
			})
			: {
				status: "submitted",
				inlineComments: 0,
				fallbackComments: comments.length,
				errorComments: 0,
				cleanupAttempted: false,
			};

		return {
			status: "finished",
			mode: session.mode,
			commentsSubmitted: comments.length,
			inlineComments: publishResult.inlineComments,
			fallbackComments: publishResult.fallbackComments,
			errorComments: publishResult.errorComments,
			cleanupAttempted: publishResult.cleanupAttempted,
			cleanupError: publishResult.cleanupError,
			filePath: session.filePath,
			pullRequest: session.pullRequest,
		};
	}

	private applyLocalOriginHeaders(req: http.IncomingMessage, res: http.ServerResponse): boolean {
		const origin = req.headers.origin;
		if (!origin) return true;
		if (!this.isAllowedOrigin(origin)) return false;

		res.setHeader("Access-Control-Allow-Origin", origin);
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");
		res.setHeader("Vary", "Origin");
		return true;
	}

	private isAllowedOrigin(origin: string): boolean {
		return origin === `http://127.0.0.1:${this.port}` || origin === `http://localhost:${this.port}`;
	}

	private createComment(session: ActiveSession, data: Record<string, unknown>): ReviewComment {
		const selectedText = typeof data.selectedText === "string" ? data.selectedText : "";
		const commentText = typeof data.comment === "string" ? data.comment : "";
		const rawOffsetStart = data.offsetStart;
		const rawOffsetEnd = data.offsetEnd;
		const rawLineStart = data.lineStart;
		const rawLineEnd = data.lineEnd;

		if (!selectedText) {
			throw new RequestError("Selected text is required to create a review comment.", 400);
		}
		if (!commentText.trim()) {
			throw new RequestError("Comment text is required to create a review comment.", 400);
		}
		if (
			typeof rawOffsetStart !== "number" ||
			!Number.isInteger(rawOffsetStart) ||
			typeof rawOffsetEnd !== "number" ||
			!Number.isInteger(rawOffsetEnd) ||
			rawOffsetStart < 0 ||
			rawOffsetEnd < rawOffsetStart ||
			rawOffsetEnd > session.markdown.length
		) {
			throw new RequestError("Comment offsets must be finite integers within the source markdown bounds.", 400);
		}

		const offsetStart = Number(rawOffsetStart);
		const offsetEnd = Number(rawOffsetEnd);
		if (session.markdown.slice(offsetStart, offsetEnd) !== selectedText) {
			throw new RequestError("Comment selection no longer matches the source markdown at the provided offsets.", 400);
		}
		if (rawLineStart !== undefined || rawLineEnd !== undefined) {
			if (
				typeof rawLineStart !== "number" ||
				!Number.isInteger(rawLineStart) ||
				typeof rawLineEnd !== "number" ||
				!Number.isInteger(rawLineEnd) ||
				rawLineStart <= 0 ||
				rawLineEnd <= 0 ||
				rawLineEnd < rawLineStart
			) {
				throw new RequestError("Comment line metadata must be positive integers with lineEnd >= lineStart.", 400);
			}
		}

		const normalizedLineStart = Number.isInteger(rawLineStart) ? Number(rawLineStart) : undefined;
		const normalizedLineEnd = Number.isInteger(rawLineEnd) ? Number(rawLineEnd) : undefined;
		const inlineEligible =
			normalizedLineStart !== undefined && normalizedLineEnd !== undefined ? normalizedLineStart === normalizedLineEnd : undefined;
		const fallbackReason =
			normalizedLineStart !== undefined && normalizedLineEnd !== undefined && normalizedLineStart !== normalizedLineEnd
				? "multi_line_selection"
				: undefined;

		return {
			id: crypto.randomBytes(4).toString("hex"),
			selectedText,
			comment: commentText,
			offsetStart,
			offsetEnd,
			lineStart: normalizedLineStart,
			lineEnd: normalizedLineEnd,
			inlineEligible,
			fallbackReason,
		};
	}

	/**
	 * Insert review comments inline into the markdown, right after the selected text.
	 * Comments are inserted from last to first (by offset) to preserve earlier offsets.
	 */
	private insertCommentsIntoMarkdown(markdown: string, comments: ReviewComment[]): string {
		if (comments.length === 0) return markdown;

		const sorted = [...comments].sort((a, b) => a.offsetEnd - b.offsetEnd);
		const parts: string[] = [];
		let cursor = 0;

		for (const comment of sorted) {
			parts.push(markdown.slice(cursor, comment.offsetEnd));
			parts.push(` <!-- REVIEW: ${comment.comment.replace(/-->/g, "~~>")} -->`);
			cursor = comment.offsetEnd;
		}
		parts.push(markdown.slice(cursor));

		return parts.join("");
	}

	private sendJson(res: http.ServerResponse, status: number, data: unknown): void {
		res.writeHead(status, {
			"Content-Type": "application/json",
			"Cache-Control": "no-store, no-cache, must-revalidate",
			Pragma: "no-cache",
			Expires: "0",
		});
		res.end(JSON.stringify(data));
	}

	private readBody(req: http.IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on("data", (chunk: Buffer) => chunks.push(chunk));
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
			req.on("error", reject);
		});
	}
}
