import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

function confined(root: string, raw: unknown): boolean {
	if (typeof raw !== "string" || raw.includes("\0")) return false;
	const absolute = resolve(root, raw.replace(/^@/, ""));
	let canonical = absolute;
	try { canonical = realpathSync(absolute); } catch {
		let ancestor = dirname(absolute);
		let resolvedAncestor: string | undefined;
		while (ancestor === root || ancestor.startsWith(`${root}${sep}`)) {
			try { resolvedAncestor = realpathSync(ancestor); break; } catch {
				const parent = dirname(ancestor);
				if (parent === ancestor) break;
				ancestor = parent;
			}
		}
		if (!resolvedAncestor) return false;
		canonical = resolve(resolvedAncestor, relative(ancestor, absolute));
	}
	const local = relative(root, canonical);
	const segments = local.split(sep);
	const protectedFile = segments.some((segment) => segment === ".git" || segment === ".env" || segment.startsWith(".env.") && ![".env.example", ".env.sample", ".env.template"].includes(segment) || [".npmrc", ".pypirc", ".netrc"].includes(segment));
	return local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local) && !protectedFile;
}

export default function roleGuard(pi: ExtensionAPI) {
	const rootValue = process.env.PI_DELIVERY_CANDIDATE_ROOT;
	const role = process.env.PI_DELIVERY_ROLE;
	if (!rootValue || !["writer", "repair", "reviewer"].includes(role ?? "")) throw new Error("Missing trusted delivery role provenance.");
	const root = realpathSync(rootValue);
	const allowed = role === "reviewer"
		? new Set(["read", "ls", "delivery_review"])
		: new Set(["read", "ls", "edit", "write"]);
	if (role === "reviewer") {
		pi.registerTool({
			name: "delivery_review",
			label: "Delivery review",
			description: "Submit the one structured independent delivery verdict.",
			parameters: Type.Object({
				verdict: StringEnum(["proud", "needs-attention"] as const),
				findings: Type.Array(Type.Object({
					severity: StringEnum(["must-fix", "should-fix", "optional"] as const),
					code: StringEnum(["correctness", "simplicity", "maintainability", "tests", "specification"] as const),
					summary: Type.String({ minLength: 1, maxLength: 500 }),
					evidence: Type.String({ minLength: 1, maxLength: 2_000 }),
				}, { additionalProperties: false }), { maxItems: 20 }),
			}, { additionalProperties: false }),
			async execute(_id, params) {
				const output = process.env.PI_DELIVERY_REVIEW_OUTPUT;
				if (!output) throw new Error("Missing controller-owned review submission path.");
				writeFileSync(output, `${JSON.stringify(params)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
				return { content: [{ type: "text", text: "Review submitted." }], details: {} };
			},
		});
	}
	pi.on("tool_call", async (event) => {
		if (!allowed.has(event.toolName)) return { block: true, reason: "Tool is outside the controller-owned role profile.", terminate: true };
		const input = event.input as Record<string, unknown>;
		for (const key of ["path", "filePath", "directory"]) {
			if (key in input && !confined(root, input[key])) return { block: true, reason: "Path escapes the candidate workspace.", terminate: true };
		}
	});
}
