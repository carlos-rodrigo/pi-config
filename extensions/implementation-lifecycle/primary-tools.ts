import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runProcess, scrubbedEnvironment } from "./process.ts";

export const PRIMARY_READ_ONLY_TOOLS = ["trusted_delivery_read", "trusted_delivery_grep", "trusted_delivery_find", "trusted_delivery_ls"] as const;

export async function primaryProfileDigest(): Promise<string> {
	const source = await readFile(fileURLToPath(import.meta.url));
	const controllerSource = await readFile(fileURLToPath(new URL("./index.ts", import.meta.url)));
	return createHash("sha256").update(JSON.stringify({
		tools: PRIMARY_READ_ONLY_TOOLS,
		toolSourceSha256: createHash("sha256").update(source).digest("hex"),
		controllerSourceSha256: createHash("sha256").update(controllerSource).digest("hex"),
	})).digest("hex");
}

async function confined(cwd: string, raw = "."): Promise<string> {
	if (raw.includes("\0")) throw new Error("Invalid path.");
	const root = await realpath(cwd);
	const target = await realpath(resolve(root, raw.replace(/^@/, "")));
	const local = relative(root, target);
	const segments = local.split(sep);
	const protectedFile = segments.some((segment) => segment === ".git" || segment === ".env" || segment.startsWith(".env.") && ![".env.example", ".env.sample", ".env.template"].includes(segment) || [".npmrc", ".pypirc", ".netrc"].includes(segment));
	if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local) || protectedFile) throw new Error("Path escapes the trusted project read boundary or targets credential-bearing data.");
	return target;
}

function result(text: string, details: Record<string, unknown> = {}, forceTruncated = false) {
	const encoded = Buffer.from(text, "utf8");
	const truncated = forceTruncated || encoded.length > 50_000;
	const bounded = truncated ? `${encoded.subarray(0, 50_000).toString("utf8")}\n…truncated; refine the read-only query` : text;
	return { content: [{ type: "text" as const, text: bounded }], details: { ...details, truncated, originalBytesAtLeast: encoded.length } };
}

export function registerPrimaryReadOnlyTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "trusted_delivery_read", label: "Read trusted project file", description: "Read one regular file whose resolved target remains inside the trusted project boundary.",
		parameters: Type.Object({ path: Type.String(), offset: Type.Optional(Type.Number({ minimum: 1 })), limit: Type.Optional(Type.Number({ minimum: 1, maximum: 2_000 })) }, { additionalProperties: false }),
		async execute(_id, params, signal, _update, ctx) {
			if (signal.aborted) throw new DOMException("Aborted", "AbortError");
			const path = await confined(ctx.cwd, params.path);
			const metadata = await lstat(path);
			if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Only regular non-symlink files are readable.");
			const lines = (await readFile(path, "utf8")).split("\n");
			const offset = params.offset ?? 1;
			const limit = params.limit ?? 2_000;
			return result(lines.slice(offset - 1, offset - 1 + limit).join("\n"), { path: params.path, offset, limit });
		},
	});
	pi.registerTool({
		name: "trusted_delivery_ls", label: "List trusted project directory", description: "List one project directory without mutation.",
		parameters: Type.Object({ path: Type.Optional(Type.String()) }, { additionalProperties: false }),
		async execute(_id, params, signal, _update, ctx) {
			if (signal.aborted) throw new DOMException("Aborted", "AbortError");
			const path = await confined(ctx.cwd, params.path ?? ".");
			const entries = await readdir(path, { withFileTypes: true });
			return result(entries.sort((a, b) => a.name.localeCompare(b.name)).map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`).join("\n"));
		},
	});
	for (const definition of [
		{ name: "trusted_delivery_grep", label: "Search trusted project text", description: "Search project text with ripgrep.", parameters: Type.Object({ pattern: Type.String({ maxLength: 500 }), path: Type.Optional(Type.String()) }, { additionalProperties: false }), args: (params: { pattern: string; path?: string }, path: string) => ["--line-number", "--color", "never", "--", params.pattern, path] },
		{ name: "trusted_delivery_find", label: "Find trusted project files", description: "Find project paths with a glob.", parameters: Type.Object({ pattern: Type.String({ maxLength: 500 }), path: Type.Optional(Type.String()) }, { additionalProperties: false }), args: (params: { pattern: string; path?: string }, path: string) => ["--files", "--glob", params.pattern, "--", path] },
	] as const) {
		pi.registerTool({ ...definition, async execute(_id, params, signal, _update, ctx) {
			const path = await confined(ctx.cwd, params.path ?? ".");
			const execution = await runProcess("rg", definition.args(params, path), { cwd: ctx.cwd, env: scrubbedEnvironment(), signal, timeoutMs: 30_000, maxOutputBytes: 50_000 });
			if (![0, 1].includes(execution.code)) throw new Error(execution.stderr || "Read-only search failed.");
			return result(execution.stdout, { completeOutputSha256: execution.outputSha256, overflowed: execution.overflowed }, execution.overflowed);
		} });
	}
}
