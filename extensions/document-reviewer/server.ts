import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
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

let service: DocumentReviewService | undefined;

export async function getDocumentReviewService(): Promise<DocumentReviewService> {
	if (!service) {
		service = new DocumentReviewService();
		await service.start();
	}
	return service;
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

		// CORS headers for local development
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
		res.setHeader("Access-Control-Allow-Headers", "Content-Type");

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
				const comment: ReviewComment = {
					id: crypto.randomBytes(4).toString("hex"),
					selectedText: typeof data.selectedText === "string" ? data.selectedText : "",
					comment: typeof data.comment === "string" ? data.comment : "",
					offsetStart: typeof data.offsetStart === "number" ? data.offsetStart : 0,
					offsetEnd: typeof data.offsetEnd === "number" ? data.offsetEnd : 0,
					lineStart: typeof data.lineStart === "number" ? data.lineStart : undefined,
					lineEnd: typeof data.lineEnd === "number" ? data.lineEnd : undefined,
					inlineEligible: typeof data.inlineEligible === "boolean" ? data.inlineEligible : undefined,
					fallbackReason: typeof data.fallbackReason === "string" ? data.fallbackReason : undefined,
				};
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
			};

		return {
			status: "finished",
			mode: session.mode,
			commentsSubmitted: comments.length,
			inlineComments: publishResult.inlineComments,
			fallbackComments: publishResult.fallbackComments,
			filePath: session.filePath,
			pullRequest: session.pullRequest,
		};
	}

	/**
	 * Insert review comments inline into the markdown, right after the selected text.
	 * Comments are inserted from last to first (by offset) to preserve earlier offsets.
	 */
	private insertCommentsIntoMarkdown(markdown: string, comments: ReviewComment[]): string {
		if (comments.length === 0) return markdown;

		// Sort by offsetEnd descending so inserting doesn't shift earlier offsets
		const sorted = [...comments].sort((a, b) => b.offsetEnd - a.offsetEnd);

		let result = markdown;
		for (const comment of sorted) {
			const annotation = ` <!-- REVIEW: ${comment.comment.replace(/-->/g, "~~>")} -->`;
			// Insert right after the selected text ends
			result = result.slice(0, comment.offsetEnd) + annotation + result.slice(comment.offsetEnd);
		}

		return result;
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
