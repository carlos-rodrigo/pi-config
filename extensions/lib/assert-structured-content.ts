import assert from "node:assert/strict";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";

/** Asserts a tool result carries structuredContent that still matches the tool's outputSchema after JSON serialization, as Code Mode scripts receive it. */
export function assertStructuredContent<T = any>(tool: { name: string; outputSchema?: TSchema }, result: { structuredContent?: unknown }): T {
	assert.ok(tool.outputSchema, `${tool.name} should declare outputSchema`);
	assert.notEqual(result.structuredContent, undefined, `${tool.name} should return structuredContent`);
	const serialized = JSON.parse(JSON.stringify(result.structuredContent));
	const errors = [...Value.Errors(tool.outputSchema, serialized)].map((error) => `${error.instancePath || "/"} ${error.message}`);
	assert.deepEqual(errors, [], `${tool.name} structuredContent should match outputSchema`);
	return serialized as T;
}
