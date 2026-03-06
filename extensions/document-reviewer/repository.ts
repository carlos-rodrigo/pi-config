import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeAnchorSelector, type CommentAnchor } from "./anchors.js";

const SIDECAR_DIR = ".review";
const SIDECAR_SCHEMA_VERSION = 1;

export interface CommentEntry {
	commentId: string;
	body: string;
	createdAt: number;
}

export interface CommentThread {
	threadId: string;
	anchor: CommentAnchor;
	comments: CommentEntry[];
	createdAt: number;
	updatedAt: number;
	stale?: boolean;
}

export interface SidecarLoadResult {
	docHash: string;
	sidecarPath: string;
	threads: CommentThread[];
	found: boolean;
}

export interface SidecarCommentRepositoryOptions {
	rootDir: string;
}

export class SidecarCommentRepository {
	private readonly rootDir: string;

	constructor(options: SidecarCommentRepositoryOptions) {
		this.rootDir = path.resolve(options.rootDir);
	}

	getDocHash(docPath: string): string {
		return createDocHash(docPath);
	}

	getSidecarPath(docPath: string): string {
		const docHash = this.getDocHash(docPath);
		return this.getSidecarPathFromHash(docHash);
	}

	getSidecarPathFromHash(docHash: string): string {
		return this.resolveSidecarPathFromHash(docHash);
	}

	async load(docPath: string): Promise<SidecarLoadResult> {
		const docHash = this.getDocHash(docPath);
		const sidecarPath = this.resolveSidecarPathFromHash(docHash);

		let rawText: string;
		try {
			rawText = await fs.promises.readFile(sidecarPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return {
					docHash,
					sidecarPath,
					threads: [],
					found: false,
				};
			}
			throw error;
		}

		const threads = parseSidecarThreads(rawText);
		return {
			docHash,
			sidecarPath,
			threads,
			found: true,
		};
	}

	async save(docPath: string, threads: readonly CommentThread[], fixedDocHash?: string): Promise<string> {
		const docHash = fixedDocHash ?? this.getDocHash(docPath);
		const sidecarPath = this.resolveSidecarPathFromHash(docHash);
		await fs.promises.mkdir(path.dirname(sidecarPath), { recursive: true });

		const payload = {
			schemaVersion: SIDECAR_SCHEMA_VERSION,
			docHash,
			docPath: path.resolve(docPath),
			updatedAt: Date.now(),
			threads: normalizeThreads(threads),
		};
		const serialized = `${JSON.stringify(payload, null, "\t")}\n`;
		const tempPath = `${sidecarPath}.${process.pid}.${Date.now()}.tmp`;
		await fs.promises.writeFile(tempPath, serialized, "utf8");
		try {
			await fs.promises.rename(tempPath, sidecarPath);
		} catch (error) {
			await fs.promises.rm(tempPath, { force: true });
			throw error;
		}

		return sidecarPath;
	}

	private resolveSidecarPathFromHash(docHash: string): string {
		return path.join(this.rootDir, SIDECAR_DIR, `${docHash}.comments.json`);
	}
}

function parseSidecarThreads(rawText: string): CommentThread[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawText);
	} catch (error) {
		throw new Error(`Invalid comment sidecar JSON: ${formatError(error)}`);
	}

	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return [];
	}

	const threads = (parsed as { threads?: unknown }).threads;
	if (!Array.isArray(threads)) {
		return [];
	}

	return normalizeThreads(threads);
}

function normalizeThreads(input: readonly unknown[]): CommentThread[] {
	const normalized: CommentThread[] = [];
	for (const item of input) {
		const thread = normalizeThread(item);
		if (thread) {
			normalized.push(thread);
		}
	}
	return normalized;
}

function normalizeThread(value: unknown): CommentThread | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}

	const record = value as Record<string, unknown>;
	const anchor = normalizeAnchorSelector(record.anchor);
	if (!anchor || !anchor.exact) {
		return null;
	}

	const commentsRaw = Array.isArray(record.comments) ? record.comments : [];
	const comments = commentsRaw
		.map((comment) => normalizeComment(comment))
		.filter((comment): comment is CommentEntry => Boolean(comment));
	if (comments.length === 0) {
		return null;
	}

	const fallbackCreatedAt = comments[0].createdAt;
	const fallbackUpdatedAt = comments[comments.length - 1].createdAt;

	const createdAt = parseTimestamp(record.createdAt) ?? fallbackCreatedAt;
	const updatedAt = parseTimestamp(record.updatedAt) ?? Math.max(createdAt, fallbackUpdatedAt);
	const threadId = normalizeIdentifier(record.threadId) ?? randomUUID();

	return {
		threadId,
		anchor,
		comments,
		createdAt,
		updatedAt,
		...(record.stale === true ? { stale: true } : {}),
	};
}

function normalizeComment(value: unknown): CommentEntry | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}

	const record = value as Record<string, unknown>;
	const body = normalizeCommentBody(record.body);
	if (!body) {
		return null;
	}

	return {
		commentId: normalizeIdentifier(record.commentId) ?? randomUUID(),
		body,
		createdAt: parseTimestamp(record.createdAt) ?? Date.now(),
	};
}

function normalizeCommentBody(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim();
	if (!normalized) {
		return null;
	}
	return normalized;
}

function normalizeIdentifier(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const normalized = value.trim();
	return normalized || null;
}

function parseTimestamp(value: unknown): number | undefined {
	if (!Number.isFinite(value)) {
		return undefined;
	}
	const normalized = Math.trunc(Number(value));
	return normalized > 0 ? normalized : undefined;
}

function createDocHash(docPath: string): string {
	const normalizedPath = path.resolve(docPath).replaceAll("\\", "/");
	return createHash("sha256").update(normalizedPath).digest("hex").slice(0, 32);
}

function formatError(error: unknown): string {
	if (error instanceof Error && error.message) {
		return error.message;
	}
	return String(error);
}
