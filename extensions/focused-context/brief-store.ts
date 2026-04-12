import { access, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

export type BriefSource = "project" | "global";

export type BriefRecord = {
	topic: string;
	aliases: string[];
	scope: string;
	updatedAt?: string;
	hotFiles: string[];
	hotDocs: string[];
	title: string;
	body: string;
	path: string;
	source: BriefSource;
	raw: string;
};

export type LoadBriefOptions = {
	projectBriefDir?: string;
	globalBriefDir?: string;
};

export type BriefDirectories = {
	projectBriefDir: string;
	globalBriefDir: string;
};

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export function normalizeTopic(value: string): string {
	return value.trim().toLowerCase();
}

function unquote(value: string): string {
	return value.replace(/^['"]|['"]$/g, "").trim();
}

function parseStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter(Boolean);
}

export function parseFrontmatter(frontmatter: string): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	let currentArrayKey: string | null = null;

	for (const rawLine of frontmatter.split("\n")) {
		const line = rawLine.replace(/\r$/, "");
		if (!line.trim()) continue;

		const listMatch = line.match(/^\s*-\s*(.+)$/);
		if (listMatch && currentArrayKey) {
			const current = result[currentArrayKey];
			if (Array.isArray(current)) current.push(unquote(listMatch[1]));
			continue;
		}

		currentArrayKey = null;
		const keyMatch = line.match(/^([A-Za-z0-9_]+):(?:\s*(.*))?$/);
		if (!keyMatch) continue;

		const [, key, rawValue = ""] = keyMatch;
		if (rawValue === "") {
			result[key] = [];
			currentArrayKey = key;
			continue;
		}

		result[key] = unquote(rawValue);
	}

	return result;
}

function splitFrontmatter(content: string): { frontmatter?: string; body: string } {
	if (!content.startsWith("---\n")) return {body: content};

	const endMarker = content.indexOf("\n---\n", 4);
	if (endMarker === -1) return {body: content};

	return {
		frontmatter: content.slice(4, endMarker),
		body: content.slice(endMarker + 5).trimStart(),
	};
}

export function parseBriefDocument(content: string, path: string, source: BriefSource): BriefRecord | null {
	const {frontmatter, body} = splitFrontmatter(content);
	if (!frontmatter) return null;

	const parsed = parseFrontmatter(frontmatter);
	if (typeof parsed.topic !== "string" || !parsed.topic.trim()) return null;

	const title =
		body
			.split("\n")
			.find((line) => line.startsWith("# "))
			?.slice(2)
			.trim() || parsed.topic.trim();

	const aliases = parseStringArray(parsed.aliases).map(normalizeTopic);
	const topic = normalizeTopic(parsed.topic);

	return {
		topic,
		aliases,
		scope: typeof parsed.scope === "string" && parsed.scope.trim() ? parsed.scope.trim() : source,
		updatedAt: typeof parsed.updatedAt === "string" && parsed.updatedAt.trim() ? parsed.updatedAt.trim() : undefined,
		hotFiles: parseStringArray(parsed.hotFiles),
		hotDocs: parseStringArray(parsed.hotDocs),
		title,
		body,
		path,
		source,
		raw: content,
	};
}

export async function findProjectRoot(startDir: string): Promise<string> {
	let current = resolve(startDir);

	while (true) {
		if (
			(await pathExists(join(current, ".pi"))) ||
			(await pathExists(join(current, ".git"))) ||
			(await pathExists(join(current, "package.json")))
		) {
			return current;
		}

		const parent = dirname(current);
		if (parent === current) return resolve(startDir);
		current = parent;
	}
}

export async function resolveBriefDirectories(startDir: string, options: LoadBriefOptions = {}): Promise<BriefDirectories> {
	const projectRoot = options.projectBriefDir ? dirname(dirname(resolve(options.projectBriefDir))) : await findProjectRoot(startDir);
	return {
		projectBriefDir: options.projectBriefDir ? resolve(options.projectBriefDir) : join(projectRoot, ".pi", "briefs"),
		globalBriefDir: options.globalBriefDir ? resolve(options.globalBriefDir) : join(homedir(), ".pi", "agent", "briefs"),
	};
}

async function loadBriefsFromDir(dir: string, source: BriefSource): Promise<BriefRecord[]> {
	if (!(await pathExists(dir))) return [];

	const entries = await readdir(dir, {withFileTypes: true});
	const briefs: BriefRecord[] = [];

	for (const entry of entries) {
		if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
		const path = join(dir, entry.name);
		const content = await readFile(path, "utf8");
		const parsed = parseBriefDocument(content, path, source);
		if (parsed) briefs.push(parsed);
	}

	return briefs;
}

export async function loadBriefs(startDir: string, options: LoadBriefOptions = {}): Promise<BriefRecord[]> {
	const {projectBriefDir, globalBriefDir} = await resolveBriefDirectories(startDir, options);
	const globalBriefs = await loadBriefsFromDir(globalBriefDir, "global");
	const projectBriefs = await loadBriefsFromDir(projectBriefDir, "project");

	const merged = new Map<string, BriefRecord>();
	for (const brief of globalBriefs) merged.set(brief.topic, brief);
	for (const brief of projectBriefs) merged.set(brief.topic, brief);

	return [...merged.values()].sort((left, right) => left.topic.localeCompare(right.topic));
}

export function findBriefByTopicOrAlias(briefs: BriefRecord[], query: string | undefined): BriefRecord | undefined {
	if (!query?.trim()) return undefined;
	const normalized = normalizeTopic(query);
	return briefs.find((brief) => brief.topic === normalized || brief.aliases.includes(normalized));
}

export function formatBriefList(
	briefs: BriefRecord[],
	state: {activeTopic?: string; pinnedTopic?: string} = {},
): string {
	if (briefs.length === 0) {
		return "# Focused Context Briefs\n\nNo briefs found in `.pi/briefs/` or `~/.pi/agent/briefs/`.";
	}

	const lines = ["# Focused Context Briefs", ""];
	if (state.activeTopic || state.pinnedTopic) {
		lines.push(`Active: ${state.activeTopic ?? "none"}`);
		lines.push(`Pinned: ${state.pinnedTopic ?? "none"}`);
		lines.push("");
	}

	for (const brief of briefs) {
		const markers: string[] = [];
		if (brief.topic === state.activeTopic) markers.push("active");
		if (brief.topic === state.pinnedTopic) markers.push("pinned");
		const suffix = markers.length > 0 ? ` (${markers.join(", ")})` : "";
		lines.push(`- ${brief.topic} [${brief.source}]${suffix}`);
		if (brief.aliases.length > 0) lines.push(`  aliases: ${brief.aliases.join(", ")}`);
		if (brief.updatedAt) lines.push(`  updated: ${brief.updatedAt}`);
	}

	return lines.join("\n");
}

export function formatBriefView(brief: BriefRecord): string {
	return [
		`# Brief: ${brief.title}`,
		"",
		`- topic: ${brief.topic}`,
		`- source: ${brief.source}`,
		brief.updatedAt ? `- updated: ${brief.updatedAt}` : undefined,
		brief.aliases.length > 0 ? `- aliases: ${brief.aliases.join(", ")}` : undefined,
		"",
		brief.body.trim(),
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}
