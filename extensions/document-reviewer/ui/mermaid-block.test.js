import assert from "node:assert/strict";
import test from "node:test";
import { isUnsafeSvgTagName } from "./mermaid-block.js";

test("isUnsafeSvgTagName blocks foreignObject regardless of case", () => {
	assert.equal(isUnsafeSvgTagName("foreignObject"), true);
	assert.equal(isUnsafeSvgTagName("foreignobject"), true);
	assert.equal(isUnsafeSvgTagName("FoReIgNoBjEcT"), true);
});

test("isUnsafeSvgTagName allows normal svg content tags", () => {
	assert.equal(isUnsafeSvgTagName("svg"), false);
	assert.equal(isUnsafeSvgTagName("g"), false);
	assert.equal(isUnsafeSvgTagName("text"), false);
});
