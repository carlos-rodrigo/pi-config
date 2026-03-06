import { randomUUID } from "node:crypto";

export type SessionRemovalReason = "expired" | "manual" | "evicted";

export interface SessionRecord<T> {
	sessionId: string;
	payload: T;
	createdAt: number;
	updatedAt: number;
	expiresAt: number;
}

export interface SessionStoreHooks<T> {
	onSessionCreated?: (record: SessionRecord<T>) => void;
	onSessionTouched?: (record: SessionRecord<T>) => void;
	onSessionExpired?: (record: SessionRecord<T>) => void;
	onSessionRemoved?: (record: SessionRecord<T>, reason: SessionRemovalReason) => void;
}

export interface SessionStoreOptions<T> extends SessionStoreHooks<T> {
	sessionTtlMs?: number;
	cleanupIntervalMs?: number;
	maxSessions?: number;
}

const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;
const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_SESSIONS = 50;

export class SessionStore<T> {
	private readonly records = new Map<string, SessionRecord<T>>();
	private readonly sessionTtlMs: number;
	private readonly maxSessions: number;
	private readonly hooks: SessionStoreHooks<T>;
	private readonly cleanupTimer?: NodeJS.Timeout;

	constructor(options: SessionStoreOptions<T> = {}) {
		this.sessionTtlMs = Math.max(1000, options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS);
		this.maxSessions = Math.max(1, options.maxSessions ?? DEFAULT_MAX_SESSIONS);
		this.hooks = {
			onSessionCreated: options.onSessionCreated,
			onSessionTouched: options.onSessionTouched,
			onSessionExpired: options.onSessionExpired,
			onSessionRemoved: options.onSessionRemoved,
		};

		const cleanupIntervalMs = options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
		if (cleanupIntervalMs > 0) {
			this.cleanupTimer = setInterval(() => this.cleanupExpired(), cleanupIntervalMs);
			this.cleanupTimer.unref?.();
		}
	}

	create(payload: T, sessionId = randomUUID()): SessionRecord<T> {
		this.evictIfNeeded();

		const now = Date.now();
		const record: SessionRecord<T> = {
			sessionId,
			payload,
			createdAt: now,
			updatedAt: now,
			expiresAt: now + this.sessionTtlMs,
		};

		this.records.set(sessionId, record);
		this.hooks.onSessionCreated?.(record);
		return record;
	}

	get(sessionId: string, options: { touch?: boolean } = {}): SessionRecord<T> | undefined {
		const record = this.records.get(sessionId);
		if (!record) return undefined;

		if (this.isExpired(record)) {
			this.expireRecord(record);
			return undefined;
		}

		if (options.touch ?? true) {
			this.touchRecord(record);
		}

		return record;
	}

	remove(sessionId: string, reason: SessionRemovalReason = "manual"): boolean {
		const record = this.records.get(sessionId);
		if (!record) return false;
		this.records.delete(sessionId);
		this.hooks.onSessionRemoved?.(record, reason);
		return true;
	}

	cleanupExpired(now = Date.now()): number {
		let removed = 0;
		for (const record of this.records.values()) {
			if (record.expiresAt <= now) {
				this.expireRecord(record);
				removed += 1;
			}
		}
		return removed;
	}

	stop(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
		}
	}

	private touchRecord(record: SessionRecord<T>): void {
		record.updatedAt = Date.now();
		record.expiresAt = record.updatedAt + this.sessionTtlMs;
		this.hooks.onSessionTouched?.(record);
	}

	private expireRecord(record: SessionRecord<T>): void {
		this.records.delete(record.sessionId);
		this.hooks.onSessionExpired?.(record);
		this.hooks.onSessionRemoved?.(record, "expired");
	}

	private evictIfNeeded(): void {
		if (this.records.size < this.maxSessions) return;

		let oldestRecord: SessionRecord<T> | undefined;
		for (const record of this.records.values()) {
			if (!oldestRecord || record.updatedAt < oldestRecord.updatedAt) {
				oldestRecord = record;
			}
		}

		if (!oldestRecord) return;
		this.records.delete(oldestRecord.sessionId);
		this.hooks.onSessionRemoved?.(oldestRecord, "evicted");
	}

	private isExpired(record: SessionRecord<T>): boolean {
		return record.expiresAt <= Date.now();
	}
}
