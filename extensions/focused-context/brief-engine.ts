import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { complete, type Message } from "@mariozechner/pi-ai";
import { buildSessionContext, convertToLlm, serializeConversation, type ExtensionContext } from "@mariozechner/pi-coding-agent";

import {
	parseBriefDocument,
	resolveBriefDirectories,
	normalizeTopic,
	type BriefRecord,
} from "./brief-store.ts";

export type RefreshModelCandidate = {
	provider: string;
	model: string;
};

export type RefreshModel = {
	provider: string;
	id?: string;
	model?: string;
	name?: string;
};

export type RefreshSource = {
	label: string;
	content: string;
	path?: string;
};

export type GeneratedBriefSections = {
	objective: string;
	stableFacts: string;
	hotFiles: string;
	commonCommands: string;
	gotchas: string;
	openQuestions: string;
	nextSlice: string;
};

export type RefreshBriefResult =
	| {
			ok: true;
			brief: BriefRecord;
			created: boolean;
			usedModel: string;
			modelSource: "helper" | "active";
	  }
	| {
			ok: false;
			error: string;
	  };

export const DEFAULT_REFRESH_MODEL_CANDIDATES: RefreshModelCandidate[] = [
	{provider: "openai-codex", model: "gpt-5.3-codex"},
	{provider: "google", model: "gemini-2.5-flash"},
	{provider: "anthropic", model: "claude-sonnet-4-6"},
];

const MAX_SOURCE_ITEMS = 6;
const MAX_SOURCE_CHARS = 2_500;
const MAX_SESSION_CHARS = 4_000;
const MAX_HANDOFF_CHARS = 2_000;

const REFRESH_SYSTEM_PROMPT = `You maintain compact, durable topic briefs for coding sessions.
Return ONLY markdown using EXACTLY these headings in this order:

## Objective
## Stable Facts
## Hot Files
## Common Commands
## Gotchas
## Open Questions
## Next Slice

Rules:
- Be concise and specific.
- Prefer durable facts over transient step-by-step history.
- Mention file paths and commands only when they are genuinely useful.
- Do not add headings beyond the required ones.
- Do not include frontmatter.`;

function getModelId(model: RefreshModel): string {
	return model.id ?? model.model ?? model.name ?? "unknown-model";
}

export function describeModel(model: RefreshModel): string {
	return `${model.provider}/${getModelId(model)}`;
}

export async function resolveRefreshModel(
	ctx: Pick<ExtensionContext, "model" | "modelRegistry">,
	candidates: RefreshModelCandidate[] = DEFAULT_REFRESH_MODEL_CANDIDATES,
): Promise<
	| {model: RefreshModel; apiKey: string; source: "helper" | "active"}
	| {error: string}
> {
	for (const candidate of candidates) {
		const helper = ctx.modelRegistry.find(candidate.provider, candidate.model) as RefreshModel | undefined;
		if (!helper) continue;
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(helper.provider);
		if (!apiKey) continue;
		return {model: helper, apiKey, source: "helper"};
	}

	if (!ctx.model) {
		return {error: "No model available for focused-context brief refresh."};
	}

	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(ctx.model.provider);
	if (!apiKey) {
		return {error: `No API key available for ${describeModel(ctx.model as RefreshModel)}.`};
	}

	return {model: ctx.model as RefreshModel, apiKey, source: "active"};
}

export function truncateText(text: string, maxChars: number): string {
	const normalized = text.trim();
	if (normalized.length <= maxChars) return normalized;
	return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function extractSection(markdown: string, heading: string): string | undefined {
	const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const match = markdown.match(new RegExp(`^## ${escaped}\\n([\\s\\S]*?)(?=^## |$)`, "m"));
	const content = match?.[1]?.trim();
	return content && content.length > 0 ? content : undefined;
}

export function extractManualNotes(body: string): string | undefined {
	return extractSection(body, "Manual Notes");
}

function normalizeGeneratedSection(content: string | undefined, fallback: string): string {
	const normalized = content?.trim();
	return normalized && normalized.length > 0 ? normalized : fallback;
}

export function parseGeneratedSections(markdown: string): GeneratedBriefSections {
	return {
		objective: normalizeGeneratedSection(extractSection(markdown, "Objective"), "TBD."),
		stableFacts: normalizeGeneratedSection(extractSection(markdown, "Stable Facts"), "- None captured yet."),
		hotFiles: normalizeGeneratedSection(extractSection(markdown, "Hot Files"), "- None identified yet."),
		commonCommands: normalizeGeneratedSection(extractSection(markdown, "Common Commands"), "- None captured yet."),
		gotchas: normalizeGeneratedSection(extractSection(markdown, "Gotchas"), "- None captured yet."),
		openQuestions: normalizeGeneratedSection(extractSection(markdown, "Open Questions"), "- None right now."),
		nextSlice: normalizeGeneratedSection(extractSection(markdown, "Next Slice"), "TBD."),
	};
}

export function humanizeTopic(topic: string): string {
	return topic
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

export function renderBriefBody(
	title: string,
	sections: GeneratedBriefSections,
	manualNotes?: string,
): string {
	const parts = [
		`# ${title}`,
		"",
		"## Objective",
		sections.objective,
		"",
		"## Stable Facts",
		sections.stableFacts,
		"",
		"## Hot Files",
		sections.hotFiles,
		"",
		"## Common Commands",
		sections.commonCommands,
		"",
		"## Gotchas",
		sections.gotchas,
		"",
		"## Open Questions",
		sections.openQuestions,
		"",
		"## Next Slice",
		sections.nextSlice,
	];

	if (manualNotes && manualNotes.trim()) {
		parts.push("", "## Manual Notes", manualNotes.trim());
	}

	return `${parts.join("\n").trim()}\n`;
}

export function renderBriefDocument(params: {
	topic: string;
	aliases?: string[];
	scope?: string;
	updatedAt: string;
	hotFiles?: string[];
	hotDocs?: string[];
	title?: string;
	sections: GeneratedBriefSections;
	existingBody?: string;
}): string {
	const title = params.title?.trim() || humanizeTopic(params.topic);
	const manualNotes = params.existingBody ? extractManualNotes(params.existingBody) : undefined;
	const aliases = [...new Set((params.aliases ?? []).map((alias) => normalizeTopic(alias)).filter(Boolean))];
	const hotFiles = [...new Set((params.hotFiles ?? []).map((item) => item.trim()).filter(Boolean))];
	const hotDocs = [...new Set((params.hotDocs ?? []).map((item) => item.trim()).filter(Boolean))];
	const frontmatter = [
		"---",
		`topic: ${normalizeTopic(params.topic)}`,
		aliases.length > 0 ? `aliases:\n${aliases.map((alias) => `  - ${alias}`).join("\n")}` : "aliases:",
		`scope: ${params.scope?.trim() || "project"}`,
		`updatedAt: ${params.updatedAt}`,
		hotFiles.length > 0 ? `hotFiles:\n${hotFiles.map((path) => `  - ${path}`).join("\n")}` : "hotFiles:",
		hotDocs.length > 0 ? `hotDocs:\n${hotDocs.map((path) => `  - ${path}`).join("\n")}` : "hotDocs:",
		"---",
		"",
	].join("\n");

	return `${frontmatter}${renderBriefBody(title, params.sections, manualNotes)}`;
}

function normalizeRelativePath(cwd: string, value: string): string {
	if (!value.trim()) return value;
	return isAbsolute(value) ? value : resolve(cwd, value);
}

async function readSourceFile(cwd: string, path: string): Promise<RefreshSource | null> {
	try {
		const absolute = normalizeRelativePath(cwd, path);
		const content = await readFile(absolute, "utf8");
		return {
			label: path,
			path,
			content: truncateText(content, MAX_SOURCE_CHARS),
		};
	} catch {
		return null;
	}
}

function gatherConversation(ctx: Pick<ExtensionContext, "sessionManager">): string {
	const sessionManager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
		getBranch?: () => unknown[];
		getLeafId?: () => string;
	};
	if (!sessionManager.getBranch || !sessionManager.getLeafId) return "";

	try {
		const {messages} = buildSessionContext(sessionManager.getBranch(), sessionManager.getLeafId());
		if (messages.length === 0) return "";
		return serializeConversation(convertToLlm(messages));
	} catch {
		return "";
	}
}

export async function collectRefreshSources(params: {
	cwd: string;
	brief?: BriefRecord;
	sessionText?: string;
	sessionSources?: RefreshSource[];
	latestHandoffText?: string;
}): Promise<RefreshSource[]> {
	const sources: RefreshSource[] = [];
	const seenPaths = new Set<string>();
	const candidatePaths = [...(params.brief?.hotDocs ?? []), ...(params.brief?.hotFiles ?? [])];

	for (const path of candidatePaths) {
		if (seenPaths.has(path)) continue;
		seenPaths.add(path);
		if (sources.length >= MAX_SOURCE_ITEMS) break;
		const source = await readSourceFile(params.cwd, path);
		if (source) sources.push(source);
	}

	if (params.sessionSources && params.sessionSources.length > 0) {
		for (const source of params.sessionSources) {
			sources.push({
				label: source.label,
				path: source.path,
				content: truncateText(source.content, MAX_SESSION_CHARS),
			});
		}
	} else if (params.sessionText?.trim()) {
		sources.push({
			label: "current-session",
			content: truncateText(params.sessionText, MAX_SESSION_CHARS),
		});
	}

	if (params.latestHandoffText?.trim()) {
		sources.push({
			label: "latest-handoff",
			content: truncateText(params.latestHandoffText, MAX_HANDOFF_CHARS),
		});
	}

	return sources.slice(0, MAX_SOURCE_ITEMS + 2);
}

function buildRefreshPrompt(params: {
	topic: string;
	brief?: BriefRecord;
	sources: RefreshSource[];
}): string {
	const sections = [
		`Topic: ${params.topic}`,
		params.brief
			? `Existing brief title: ${params.brief.title}\nExisting aliases: ${params.brief.aliases.join(", ") || "none"}`
			: "This topic has no existing brief yet.",
	];

	if (params.sources.length > 0) {
		sections.push(
			"Sources:",
			params.sources
				.map((source) => `### ${source.label}\n${source.content}`)
				.join("\n\n"),
		);
	} else {
		sections.push("Sources: none available. Use the topic name and any existing metadata only.");
	}

	sections.push("Write a compact durable brief for this topic using the required headings.");
	return sections.join("\n\n");
}

export async function refreshBrief(params: {
	ctx: Pick<ExtensionContext, "cwd" | "model" | "modelRegistry" | "sessionManager">;
	topic: string;
	brief?: BriefRecord;
	sessionSources?: RefreshSource[];
	latestHandoffText?: string;
	candidates?: RefreshModelCandidate[];
	now?: Date;
	completeFn?: typeof complete;
}): Promise<RefreshBriefResult> {
	const resolved = await resolveRefreshModel(params.ctx, params.candidates);
	if ("error" in resolved) return {ok: false, error: resolved.error};

	const sessionText = gatherConversation(params.ctx);
	const sources = await collectRefreshSources({
		cwd: params.ctx.cwd,
		brief: params.brief,
		sessionText,
		sessionSources: params.sessionSources,
		latestHandoffText: params.latestHandoffText,
	});
	const prompt = buildRefreshPrompt({topic: normalizeTopic(params.topic), brief: params.brief, sources});
	const message: Message = {
		role: "user",
		content: [{type: "text", text: prompt}],
		timestamp: Date.now(),
	};

	const completion = params.completeFn ?? complete;
	const response = await completion(
		resolved.model as any,
		{systemPrompt: REFRESH_SYSTEM_PROMPT, messages: [message]},
		{apiKey: resolved.apiKey},
	);

	if (response.stopReason === "aborted") {
		return {ok: false, error: "Focused-context brief refresh was cancelled."};
	}
	if (response.stopReason === "error") {
		const errorMessage = "errorMessage" in response && typeof response.errorMessage === "string"
			? response.errorMessage
			: "Brief refresh failed.";
		return {ok: false, error: errorMessage};
	}

	const markdown = response.content
		.filter((part): part is {type: "text"; text: string} => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
	if (!markdown) return {ok: false, error: "Brief refresh returned empty content."};

	const parsedSections = parseGeneratedSections(markdown);
	const now = (params.now ?? new Date()).toISOString();
	const directories = await resolveBriefDirectories(params.ctx.cwd);
	const targetPath = params.brief?.path ?? join(directories.projectBriefDir, `${normalizeTopic(params.topic)}.md`);
	const document = renderBriefDocument({
		topic: normalizeTopic(params.topic),
		aliases: params.brief?.aliases ?? [],
		scope: params.brief?.scope ?? "project",
		updatedAt: now,
		hotFiles: params.brief?.hotFiles ?? [],
		hotDocs: params.brief?.hotDocs ?? [],
		title: params.brief?.title ?? humanizeTopic(params.topic),
		sections: parsedSections,
		existingBody: params.brief?.body,
	});

	await mkdir(dirname(targetPath), {recursive: true});
	await writeFile(targetPath, document, "utf8");

	const parsedBrief = parseBriefDocument(document, targetPath, params.brief?.source ?? "project");
	if (!parsedBrief) return {ok: false, error: "Refreshed brief could not be parsed after writing."};

	return {
		ok: true,
		brief: parsedBrief,
		created: !params.brief,
		usedModel: describeModel(resolved.model),
		modelSource: resolved.source,
	};
}
