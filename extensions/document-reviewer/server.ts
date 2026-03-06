import { randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { URL, fileURLToPath } from "node:url";
import { normalizeAnchorSelector, reanchorSelector, reanchorThreads, type CommentAnchor } from "./anchors.js";
import { compilePlainTextReviewExport } from "./export.js";
import { SidecarCommentRepository, type CommentEntry, type CommentThread } from "./repository.js";
import { SessionStore, type SessionRecord } from "./session-store.js";

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown", ".mdown", ".mkd", ".mdx"]);
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_COMMENT_BODY_LENGTH = 4000;
const SESSION_TOKEN_HEADER = "x-review-session-token";
const REVIEW_ASSET_BASE_PATH = "/review/assets";

const REVIEW_UI_ASSETS: Readonly<Record<string, string>> = {
	"app.js": "application/javascript; charset=utf-8",
	"comment-composer.js": "application/javascript; charset=utf-8",
	"end-review.js": "application/javascript; charset=utf-8",
	"keymap.js": "application/javascript; charset=utf-8",
	"mermaid-block.js": "application/javascript; charset=utf-8",
	"selection.js": "application/javascript; charset=utf-8",
	"threads-panel.js": "application/javascript; charset=utf-8",
	"styles.css": "text/css; charset=utf-8",
};

const REVIEW_UI_DIRECTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "ui");
const REVIEW_UI_INDEX_PATH = path.join(REVIEW_UI_DIRECTORY, "index.html");

let reviewIndexTemplateCache: string | undefined;
const reviewAssetCache = new Map<string, Buffer>();

interface DocumentPayload {
	docPath: string;
	docHash: string;
	title: string;
	markdown: string;
	status: "ready";
	threads: CommentThread[];
	apiToken: string;
}

interface ReviewUiBootstrapPayload {
	sessionId: string;
	title: string;
	docPath: string;
	documentUrl: string;
	healthUrl: string;
	apiToken: string;
	initialMode: "NORMAL";
}

interface ServiceLogger {
	info: (message: string) => void;
	warn: (message: string) => void;
	error: (message: string) => void;
}

export interface ReviewSessionInfo {
	sessionId: string;
	title: string;
	reviewUrl: string;
	documentUrl: string;
	healthUrl: string;
	apiToken: string;
}

export interface DocumentReviewServiceOptions {
	host?: string;
	rootDir?: string;
	sessionTtlMs?: number;
	cleanupIntervalMs?: number;
	maxSessions?: number;
	maxDocumentBytes?: number;
	logger?: ServiceLogger;
}

class HttpError extends Error {
	statusCode: number;

	constructor(statusCode: number, message: string) {
		super(message);
		this.name = "HttpError";
		this.statusCode = statusCode;
	}
}

export class DocumentReviewService {
	private readonly host: string;
	private readonly rootDir: string;
	private readonly maxDocumentBytes: number;
	private readonly logger: ServiceLogger;
	private readonly sessions: SessionStore<DocumentPayload>;
	private readonly repository: SidecarCommentRepository;
	private server?: http.Server;
	private port?: number;
	private starting?: Promise<void>;

	constructor(options: DocumentReviewServiceOptions = {}) {
		this.host = options.host ?? DEFAULT_HOST;
		if (this.host !== DEFAULT_HOST) {
			throw new Error(`DocumentReviewService only supports ${DEFAULT_HOST} binding.`);
		}

		this.rootDir = path.resolve(options.rootDir ?? process.cwd());
		this.maxDocumentBytes = Math.max(1024, options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES);
		this.logger = options.logger ?? console;
		this.sessions = new SessionStore<DocumentPayload>({
			sessionTtlMs: options.sessionTtlMs,
			cleanupIntervalMs: options.cleanupIntervalMs,
			maxSessions: options.maxSessions,
			onSessionExpired: (record) => {
				this.logger.info(`[document-reviewer] session expired: ${record.sessionId}`);
			},
			onSessionRemoved: (record, reason) => {
				this.logger.info(`[document-reviewer] session removed: ${record.sessionId} (${reason})`);
			},
		});
		this.repository = new SidecarCommentRepository({
			rootDir: this.rootDir,
		});
	}

	async ensureStarted(): Promise<void> {
		if (this.server && this.port) return;
		if (this.starting) {
			await this.starting;
			return;
		}

		this.starting = this.startServer();
		try {
			await this.starting;
		} finally {
			this.starting = undefined;
		}
	}

	async stop(): Promise<void> {
		this.sessions.stop();
		if (!this.server) {
			this.port = undefined;
			return;
		}

		const serverToClose = this.server;
		this.server = undefined;
		this.port = undefined;
		await new Promise<void>((resolve, reject) => {
			serverToClose.close((error) => {
				if (error) reject(error);
				else resolve();
			});
		});
	}

	async createSession(docPath: string): Promise<ReviewSessionInfo> {
		await this.ensureStarted();
		const document = await readValidatedMarkdown(docPath, {
			rootDir: this.rootDir,
			maxDocumentBytes: this.maxDocumentBytes,
		});

		const sidecar = await this.repository.load(document.docPath);
		const reanchoredThreads = reanchorThreads(sidecar.threads, document.markdown);
		const payload: DocumentPayload = {
			...document,
			docHash: sidecar.docHash,
			threads: reanchoredThreads,
			apiToken: createSessionToken(),
		};

		if (payload.threads.length > 0 || sidecar.found) {
			await this.repository.save(payload.docPath, payload.threads, payload.docHash);
		}

		const record = this.sessions.create(payload);
		return this.toSessionInfo(record);
	}

	private async startServer(): Promise<void> {
		const server = http.createServer((req, res) => {
			void this.handleRequest(req, res);
		});

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				server.removeListener("listening", onListening);
				const errorCode = (error as NodeJS.ErrnoException).code;
				reject(
					new Error(
						`Failed to bind review service on ${this.host}:0${errorCode ? ` (${errorCode})` : ""}.`,
					),
				);
			};
			const onListening = () => {
				server.removeListener("error", onError);
				resolve();
			};

			server.once("error", onError);
			server.once("listening", onListening);
			server.listen({ host: this.host, port: 0 });
		});

		const address = server.address();
		if (!address || typeof address === "string") {
			server.close();
			throw new Error("Review service did not provide a TCP address.");
		}

		if (address.address !== this.host) {
			server.close();
			throw new Error(`Review service bound to ${address.address} instead of ${this.host}.`);
		}

		this.server = server;
		this.port = address.port;
		this.logger.info(`[document-reviewer] local service listening at ${this.baseUrl}`);
	}

	private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
		try {
			if (!this.port) {
				throw new HttpError(503, "Review service not ready.");
			}

			const method = (req.method ?? "GET").toUpperCase();
			const url = new URL(req.url ?? "/", this.baseUrl);
			const pathname = normalizePathname(url.pathname);

			if (method === "POST" && pathname === "/api/review/session") {
				const body = await readJsonBody<{ docPath?: unknown }>(req);
				if (typeof body.docPath !== "string" || body.docPath.trim().length === 0) {
					throw new HttpError(400, "docPath is required and must be a non-empty string.");
				}

				const session = await this.createSession(body.docPath);
				sendJson(res, 201, {
					sessionId: session.sessionId,
					reviewUrl: session.reviewUrl,
					title: session.title,
				});
				return;
			}

			const documentMatch = pathname.match(/^\/api\/review\/session\/([^/]+)\/document$/);
			if (method === "GET" && documentMatch) {
				const record = this.getAuthorizedSessionRecord(req, documentMatch[1]);

				sendJson(res, 200, {
					sessionId: record.sessionId,
					title: record.payload.title,
					docPath: record.payload.docPath,
					markdown: record.payload.markdown,
				});
				return;
			}

			const commentsMatch = pathname.match(/^\/api\/review\/session\/([^/]+)\/comments$/);
			if (commentsMatch) {
				const record = this.getAuthorizedSessionRecord(req, commentsMatch[1]);

				if (method === "GET") {
					sendJson(res, 200, {
						threads: record.payload.threads,
					});
					return;
				}

				if (method === "POST") {
					const body = await readJsonBody<Record<string, unknown>>(req);
					assertPlainCommentModel(body);
					const anchor = parseCommentAnchor(body.anchor, record.payload.markdown);
					const commentBody = parseCommentBody(body.body);
					const thread = createCommentThread(anchor, commentBody);
					record.payload.threads.push(thread);
					await this.repository.save(record.payload.docPath, record.payload.threads, record.payload.docHash);
					sendJson(res, 201, {
						ok: true,
						thread,
					});
					return;
				}
			}

			const repliesMatch = pathname.match(/^\/api\/review\/session\/([^/]+)\/comments\/([^/]+)\/replies$/);
			if (method === "POST" && repliesMatch) {
				const record = this.getAuthorizedSessionRecord(req, repliesMatch[1]);
				const threadId = decodeSessionId(repliesMatch[2]);

				const thread = record.payload.threads.find((candidate) => candidate.threadId === threadId);
				if (!thread) {
					throw new HttpError(404, "Thread not found.");
				}

				const body = await readJsonBody<Record<string, unknown>>(req);
				assertPlainCommentModel(body);
				const commentBody = parseCommentBody(body.body);
				thread.comments.push(createCommentEntry(commentBody));
				thread.updatedAt = Date.now();
				thread.stale = false;
				await this.repository.save(record.payload.docPath, record.payload.threads, record.payload.docHash);

				sendJson(res, 201, {
					ok: true,
					thread,
				});
				return;
			}

			const exportMatch = pathname.match(/^\/api\/review\/session\/([^/]+)\/export$/);
			if (method === "POST" && exportMatch) {
				const record = this.getAuthorizedSessionRecord(req, exportMatch[1]);

				const body = await readJsonBody<Record<string, unknown>>(req);
				assertExportPayloadModel(body);
				parseExportFormat(body.format);
				const exportPayload = compilePlainTextReviewExport(record.payload.threads);

				sendJson(res, 200, {
					ok: true,
					format: "plain",
					count: exportPayload.count,
					text: exportPayload.text,
				});
				return;
			}

			const healthMatch = pathname.match(/^\/api\/review\/session\/([^/]+)\/health$/);
			if (method === "GET" && healthMatch) {
				const record = this.getAuthorizedSessionRecord(req, healthMatch[1]);

				sendJson(res, 200, {
					ok: true,
					sessionId: record.sessionId,
					status: record.payload.status,
					expiresAt: record.expiresAt,
					threadCount: record.payload.threads.length,
				});
				return;
			}

			const reviewAssetMatch = pathname.match(/^\/review\/assets\/([^/]+)$/);
			if (method === "GET" && reviewAssetMatch) {
				const assetName = decodeAssetName(reviewAssetMatch[1]);
				await serveReviewUiAsset(res, assetName);
				return;
			}

			const reviewMatch = pathname.match(/^\/review\/([^/]+)$/);
			if (method === "GET" && reviewMatch) {
				const sessionId = decodeSessionId(reviewMatch[1]);
				const record = this.sessions.get(sessionId);
				if (!record) {
					throw new HttpError(404, "Session not found.");
				}

				const session = this.toSessionInfo(record);
				const html = await renderReviewShellHtml(session, record.payload);
				sendHtml(res, 200, html);
				return;
			}

			throw new HttpError(404, "Route not found.");
		} catch (error) {
			handleHttpError(error, res, this.logger);
		}
	}

	private getAuthorizedSessionRecord(
		req: http.IncomingMessage,
		rawSessionId: string,
	): SessionRecord<DocumentPayload> {
		const sessionId = decodeSessionId(rawSessionId);
		const record = this.sessions.get(sessionId);
		if (!record) {
			throw new HttpError(404, "Session not found.");
		}

		assertSessionToken(req, record.payload.apiToken);
		return record;
	}

	private get baseUrl(): string {
		if (!this.port) {
			throw new Error("Review service has not started yet.");
		}
		return `http://${this.host}:${this.port}`;
	}

	private toSessionInfo(record: SessionRecord<DocumentPayload>): ReviewSessionInfo {
		const encodedSessionId = encodeURIComponent(record.sessionId);
		return {
			sessionId: record.sessionId,
			title: record.payload.title,
			reviewUrl: `${this.baseUrl}/review/${encodedSessionId}`,
			documentUrl: `${this.baseUrl}/api/review/session/${encodedSessionId}/document`,
			healthUrl: `${this.baseUrl}/api/review/session/${encodedSessionId}/health`,
			apiToken: record.payload.apiToken,
		};
	}
}

let singletonService: DocumentReviewService | undefined;

export async function getDocumentReviewService(): Promise<DocumentReviewService> {
	if (!singletonService) {
		singletonService = new DocumentReviewService();
	}
	await singletonService.ensureStarted();
	return singletonService;
}

function decodeSessionId(rawValue: string): string {
	return decodeUriComponentOrThrow(rawValue, "Invalid session identifier.");
}

function decodeAssetName(rawValue: string): string {
	return decodeUriComponentOrThrow(rawValue, "Invalid asset name.");
}

function decodeUriComponentOrThrow(rawValue: string, message: string): string {
	try {
		return decodeURIComponent(rawValue);
	} catch {
		throw new HttpError(400, message);
	}
}

function normalizePathname(pathname: string): string {
	if (pathname.length > 1 && pathname.endsWith("/")) {
		return pathname.slice(0, -1);
	}
	return pathname;
}

function createSessionToken(): string {
	return `${randomUUID()}${randomUUID()}`.replaceAll("-", "");
}

function assertSessionToken(req: http.IncomingMessage, expectedToken: string): void {
	const receivedToken = readSessionTokenHeader(req);
	if (!receivedToken || !safeTokenEqual(receivedToken, expectedToken)) {
		throw new HttpError(401, "Missing or invalid session token.");
	}
}

function readSessionTokenHeader(req: http.IncomingMessage): string {
	const rawHeader = req.headers[SESSION_TOKEN_HEADER];
	if (Array.isArray(rawHeader)) {
		return String(rawHeader[0] ?? "").trim();
	}
	if (typeof rawHeader === "string") {
		return rawHeader.trim();
	}
	return "";
}

function safeTokenEqual(left: string, right: string): boolean {
	const leftBuffer = Buffer.from(left);
	const rightBuffer = Buffer.from(right);
	if (leftBuffer.byteLength !== rightBuffer.byteLength) {
		return false;
	}
	return timingSafeEqual(leftBuffer, rightBuffer);
}

interface ReadValidatedMarkdownOptions {
	rootDir: string;
	maxDocumentBytes: number;
}

interface ValidatedDocument {
	docPath: string;
	title: string;
	markdown: string;
	status: "ready";
}

async function readValidatedMarkdown(inputPath: string, options: ReadValidatedMarkdownOptions): Promise<ValidatedDocument> {
	const normalizedInput = inputPath.trim();
	if (!normalizedInput) {
		throw new HttpError(400, "Document path is required.");
	}

	const resolvedPath = path.isAbsolute(normalizedInput)
		? path.resolve(normalizedInput)
		: path.resolve(options.rootDir, normalizedInput);

	const extension = path.extname(resolvedPath).toLowerCase();
	if (!MARKDOWN_EXTENSIONS.has(extension)) {
		throw new HttpError(400, "Document must be a markdown file.");
	}

	let stat: fs.Stats;
	try {
		stat = await fs.promises.lstat(resolvedPath);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new HttpError(404, `Document not found: ${resolvedPath}`);
		}
		throw new HttpError(500, `Cannot access document: ${resolvedPath}`);
	}

	if (stat.isSymbolicLink()) {
		throw new HttpError(400, "Symlink targets are not supported.");
	}

	if (!stat.isFile()) {
		throw new HttpError(400, "Document path must point to a file.");
	}

	let realRootDir: string;
	let realDocumentPath: string;
	try {
		[realRootDir, realDocumentPath] = await Promise.all([
			fs.promises.realpath(options.rootDir),
			fs.promises.realpath(resolvedPath),
		]);
	} catch {
		throw new HttpError(500, "Failed to resolve document path for workspace safety checks.");
	}
	assertPathInsideRoot(realDocumentPath, realRootDir);

	let realStat: fs.Stats;
	try {
		realStat = await fs.promises.stat(realDocumentPath);
	} catch {
		throw new HttpError(500, "Failed to inspect resolved document path.");
	}

	if (!realStat.isFile()) {
		throw new HttpError(400, "Resolved document path must point to a file.");
	}

	if (realStat.size > options.maxDocumentBytes) {
		throw new HttpError(413, `Document exceeds max size of ${options.maxDocumentBytes} bytes.`);
	}

	const markdown = await fs.promises.readFile(realDocumentPath, "utf8");
	return {
		docPath: realDocumentPath,
		title: path.basename(realDocumentPath),
		markdown,
		status: "ready",
	};
}

function assertPathInsideRoot(candidatePath: string, rootDir: string): void {
	const relativePath = path.relative(rootDir, candidatePath);
	if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
		throw new HttpError(403, `Document path must stay inside workspace root: ${rootDir}`);
	}
}

async function readJsonBody<T>(req: http.IncomingMessage, maxBytes = 256 * 1024): Promise<T> {
	const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
	const mimeType = contentType.split(";")[0]?.trim();
	if (mimeType !== "application/json") {
		throw new HttpError(415, "Request body must use content-type application/json.");
	}

	const chunks: Buffer[] = [];
	let totalBytes = 0;

	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		totalBytes += buffer.byteLength;
		if (totalBytes > maxBytes) {
			throw new HttpError(413, "Request body exceeds 256KB limit.");
		}
		chunks.push(buffer);
	}

	if (chunks.length === 0) {
		throw new HttpError(400, "Request body is required.");
	}

	const bodyText = Buffer.concat(chunks).toString("utf8");
	try {
		return JSON.parse(bodyText) as T;
	} catch {
		throw new HttpError(400, "Request body must be valid JSON.");
	}
}

function assertPlainCommentModel(payload: unknown): asserts payload is Record<string, unknown> {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new HttpError(400, "Comment payload must be a JSON object.");
	}

	const disallowedFields = ["type", "tag", "severity", "status"];
	for (const field of disallowedFields) {
		if (Object.hasOwn(payload, field)) {
			throw new HttpError(400, `Comment classification field \"${field}\" is not supported.`);
		}
	}
}

function assertExportPayloadModel(payload: unknown): asserts payload is Record<string, unknown> {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
		throw new HttpError(400, "Export payload must be a JSON object.");
	}
}

function parseCommentBody(value: unknown): string {
	if (typeof value !== "string") {
		throw new HttpError(400, "Comment body is required.");
	}
	const normalized = value.trim();
	if (!normalized) {
		throw new HttpError(400, "Comment cannot be empty.");
	}
	if (normalized.length > MAX_COMMENT_BODY_LENGTH) {
		throw new HttpError(400, `Comment exceeds ${MAX_COMMENT_BODY_LENGTH} characters.`);
	}
	return normalized;
}

function parseExportFormat(value: unknown): "plain" {
	if (value === undefined || value === null || value === "plain") {
		return "plain";
	}
	throw new HttpError(400, "Only plain export format is supported.");
}

function parseCommentAnchor(value: unknown, markdown: string): CommentAnchor {
	if (!value || typeof value !== "object") {
		throw new HttpError(400, "Selection anchor is required.");
	}

	const normalized = normalizeAnchorSelector(value);
	if (!normalized) {
		throw new HttpError(
			400,
			"Selection anchor must include exact (or quote) text plus valid optional offsets/context fields.",
		);
	}

	const reanchored = reanchorSelector(normalized, markdown);
	if (reanchored.stale) {
		throw new HttpError(400, "Selection anchor could not be mapped to the current document.");
	}

	return reanchored.anchor;
}

function createCommentThread(anchor: CommentAnchor, initialBody: string): CommentThread {
	const createdAt = Date.now();
	return {
		threadId: randomUUID(),
		anchor,
		comments: [createCommentEntry(initialBody, createdAt)],
		createdAt,
		updatedAt: createdAt,
		stale: false,
	};
}

function createCommentEntry(body: string, createdAt = Date.now()): CommentEntry {
	return {
		commentId: randomUUID(),
		body,
		createdAt,
	};
}

async function serveReviewUiAsset(res: http.ServerResponse, assetName: string): Promise<void> {
	const contentType = REVIEW_UI_ASSETS[assetName];
	if (!contentType) {
		throw new HttpError(404, "Asset not found.");
	}

	let content = reviewAssetCache.get(assetName);
	if (!content) {
		const assetPath = path.join(REVIEW_UI_DIRECTORY, assetName);
		try {
			content = await fs.promises.readFile(assetPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				throw new HttpError(404, "Asset not found.");
			}
			throw new HttpError(500, `Could not load UI asset: ${assetName}`);
		}
		reviewAssetCache.set(assetName, content);
	}

	sendBytes(res, 200, content, contentType, "private, max-age=300");
}

async function renderReviewShellHtml(session: ReviewSessionInfo, document: DocumentPayload): Promise<string> {
	const template = await readReviewIndexTemplate();
	assertTemplateToken(template, "__REVIEW_ASSET_BASE_PATH__");
	assertTemplateToken(template, "__REVIEW_BOOTSTRAP__");

	const bootstrap: ReviewUiBootstrapPayload = {
		sessionId: session.sessionId,
		title: session.title,
		docPath: document.docPath,
		documentUrl: session.documentUrl,
		healthUrl: session.healthUrl,
		apiToken: session.apiToken,
		initialMode: "NORMAL",
	};

	return template
		.replaceAll("__REVIEW_ASSET_BASE_PATH__", REVIEW_ASSET_BASE_PATH)
		.replace("__REVIEW_BOOTSTRAP__", serializeForInlineJson(bootstrap));
}

async function readReviewIndexTemplate(): Promise<string> {
	if (reviewIndexTemplateCache) {
		return reviewIndexTemplateCache;
	}

	try {
		reviewIndexTemplateCache = await fs.promises.readFile(REVIEW_UI_INDEX_PATH, "utf8");
		return reviewIndexTemplateCache;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new HttpError(500, "Review UI template is missing.");
		}
		throw new HttpError(500, "Review UI template could not be loaded.");
	}
}

function assertTemplateToken(template: string, token: string): void {
	if (!template.includes(token)) {
		throw new HttpError(500, `Review UI template missing required token: ${token}`);
	}
}

function serializeForInlineJson(value: unknown): string {
	return JSON.stringify(value)
		.replaceAll("<", "\\u003c")
		.replaceAll(">", "\\u003e")
		.replaceAll("&", "\\u0026")
		.replaceAll("\u2028", "\\u2028")
		.replaceAll("\u2029", "\\u2029");
}

function sendJson(res: http.ServerResponse, statusCode: number, body: Record<string, unknown>): void {
	if (res.writableEnded) return;
	const payload = JSON.stringify(body);
	res.writeHead(statusCode, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(payload);
}

function sendHtml(res: http.ServerResponse, statusCode: number, html: string): void {
	if (res.writableEnded) return;
	res.writeHead(statusCode, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
	});
	res.end(html);
}

function sendBytes(
	res: http.ServerResponse,
	statusCode: number,
	content: Buffer,
	contentType: string,
	cacheControl = "no-store",
): void {
	if (res.writableEnded) return;
	res.writeHead(statusCode, {
		"content-type": contentType,
		"cache-control": cacheControl,
		"content-length": content.byteLength,
	});
	res.end(content);
}

function handleHttpError(error: unknown, res: http.ServerResponse, logger: ServiceLogger): void {
	if (error instanceof HttpError) {
		sendJson(res, error.statusCode, { error: error.message });
		return;
	}

	logger.error(`[document-reviewer] unexpected service error: ${formatError(error)}`);
	sendJson(res, 500, { error: "Unexpected review service error." });
}

function formatError(error: unknown): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	return String(error);
}
