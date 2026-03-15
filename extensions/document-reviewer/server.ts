import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { buildReviewPage } from "./review-page.js";

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
}

interface ActiveSession {
	sessionId: string;
	filePath: string;
	title: string;
	markdown: string;
	comments: ReviewComment[];
	onFinish?: (comments: ReviewComment[]) => void;
}

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

	async createSession(filePath: string): Promise<ReviewSession> {
		const markdown = await fs.promises.readFile(filePath, "utf-8");
		const sessionId = crypto.randomBytes(8).toString("hex");
		const title = path.basename(filePath);

		const session: ActiveSession = {
			sessionId,
			filePath,
			title,
			markdown,
			comments: [],
		};

		this.sessions.set(sessionId, session);

		const base = `http://127.0.0.1:${this.port}`;
		return {
			sessionId,
			title,
			filePath,
			reviewUrl: `${base}/review/${sessionId}`,
			healthUrl: `${base}/health`,
			documentUrl: `${base}/api/${sessionId}/document`,
		};
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
					title: session.title,
					markdown: session.markdown,
					filePath: session.filePath,
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
				const data = JSON.parse(body);
				const comment: ReviewComment = {
					id: crypto.randomBytes(4).toString("hex"),
					selectedText: data.selectedText ?? "",
					comment: data.comment ?? "",
					offsetStart: data.offsetStart ?? 0,
					offsetEnd: data.offsetEnd ?? 0,
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

			// POST /api/:sessionId/finish — finish the review, write comments to file
			const finishMatch = pathname.match(/^\/api\/([a-f0-9]+)\/finish$/);
			if (finishMatch && req.method === "POST") {
				const session = this.sessions.get(finishMatch[1]!);
				if (!session) {
					this.sendJson(res, 404, { error: "Session not found" });
					return;
				}

				// Write comments inline into the markdown file
				const annotated = this.insertCommentsIntoMarkdown(session.markdown, session.comments);
				await fs.promises.writeFile(session.filePath, annotated, "utf-8");

				const comments = [...session.comments];

				// Trigger the onFinish callback
				if (session.onFinish) {
					session.onFinish(comments);
				}

				// Clean up session
				this.sessions.delete(finishMatch[1]!);

				this.sendJson(res, 200, {
					status: "finished",
					commentsWritten: comments.length,
					filePath: session.filePath,
				});
				return;
			}

			this.sendJson(res, 404, { error: "Not found" });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.sendJson(res, 500, { error: message });
		}
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
