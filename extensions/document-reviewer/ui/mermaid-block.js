const MERMAID_MODULE_URL = "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs";

const UNSAFE_SVG_TAGS = new Set(["script", "foreignobject", "iframe", "object", "embed", "link", "meta"]);
const LINK_ATTRIBUTES = new Set(["href", "xlink:href"]);

let mermaidRendererPromise;

export function isUnsafeSvgTagName(tagName) {
	return UNSAFE_SVG_TAGS.has(String(tagName).toLowerCase());
}

export async function renderMermaidBlocks(container) {
	const blocks = Array.from(container.querySelectorAll("[data-mermaid-block]"));
	if (blocks.length === 0) {
		return { total: 0, rendered: 0, fallback: 0 };
	}

	let mermaid;
	try {
		mermaid = await getMermaidRenderer();
	} catch {
		for (const block of blocks) {
			renderFallback(block, "Mermaid renderer unavailable in this environment.");
		}
		return { total: blocks.length, rendered: 0, fallback: blocks.length };
	}

	let rendered = 0;
	let fallback = 0;
	const runId = Date.now();

	for (let index = 0; index < blocks.length; index += 1) {
		const block = blocks[index];
		const source = readMermaidSource(block);
		if (!source.trim()) {
			renderFallback(block, "Mermaid source block is empty.");
			fallback += 1;
			continue;
		}

		try {
			const output = await mermaid.render(`review-mermaid-${runId}-${index}`, source);
			const svgMarkup = extractSvg(output);
			if (!svgMarkup) {
				throw new Error("Renderer did not return SVG output.");
			}

			const svgElement = parseAndSanitizeSvg(svgMarkup);
			if (!svgElement) {
				throw new Error("Renderer output is not valid SVG.");
			}

			const didRender = renderSuccess(block, svgElement);
			if (!didRender) {
				renderFallback(block, "Missing Mermaid render container in reviewer shell.");
				fallback += 1;
				continue;
			}

			rendered += 1;
		} catch (error) {
			renderFallback(block, readRenderError(error));
			fallback += 1;
		}

		if (index % 2 === 1) {
			await waitForFrame();
		}
	}

	return { total: blocks.length, rendered, fallback };
}

async function getMermaidRenderer() {
	if (!mermaidRendererPromise) {
		mermaidRendererPromise = (async () => {
			const module = await import(MERMAID_MODULE_URL);
			const mermaid = module.default ?? module.mermaid ?? module;
			if (!mermaid || typeof mermaid.initialize !== "function" || typeof mermaid.render !== "function") {
				throw new Error("Unexpected Mermaid module shape.");
			}

			mermaid.initialize({
				startOnLoad: false,
				securityLevel: "strict",
				theme: "base",
				themeVariables: {
					background: "#101722",
					primaryColor: "#2a3851",
					primaryTextColor: "#e8ecf2",
					lineColor: "#8195ba",
					tertiaryColor: "#1a2332",
					fontFamily: "Inter, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
				},
			});
			return mermaid;
		})().catch((error) => {
			mermaidRendererPromise = undefined;
			throw error;
		});
	}

	return mermaidRendererPromise;
}

function readMermaidSource(block) {
	const sourceElement = block.querySelector(".mermaid-block__source");
	if (!(sourceElement instanceof HTMLElement)) return "";
	return sourceElement.textContent ?? "";
}

function renderSuccess(block, svgElement) {
	const canvas = block.querySelector(".mermaid-block__canvas");
	const fallbackDetails = block.querySelector(".mermaid-block__fallback");
	if (!(canvas instanceof HTMLElement)) return false;

	const wrapper = document.createElement("div");
	wrapper.className = "mermaid-block__diagram";
	wrapper.append(document.importNode(svgElement, true));
	canvas.replaceChildren(wrapper);

	block.classList.remove("mermaid-block--fallback");
	block.classList.add("mermaid-block--ready");
	if (fallbackDetails instanceof HTMLElement) {
		fallbackDetails.hidden = true;
	}
	return true;
}

function renderFallback(block, reason) {
	const canvas = block.querySelector(".mermaid-block__canvas");
	const fallbackDetails = block.querySelector(".mermaid-block__fallback");
	const source = readMermaidSource(block);

	if (canvas instanceof HTMLElement) {
		const status = document.createElement("p");
		status.className = "mermaid-block__status";
		status.textContent = `Could not render Mermaid diagram: ${reason}`;
		canvas.replaceChildren(status);
	}

	block.classList.remove("mermaid-block--ready");
	block.classList.add("mermaid-block--fallback");
	if (fallbackDetails instanceof HTMLElement) {
		const codeElement = fallbackDetails.querySelector("code");
		if (codeElement instanceof HTMLElement) {
			codeElement.textContent = source;
		}
		fallbackDetails.hidden = false;
	}
}

function extractSvg(renderOutput) {
	if (typeof renderOutput === "string") {
		return renderOutput;
	}
	if (renderOutput && typeof renderOutput.svg === "string") {
		return renderOutput.svg;
	}
	return "";
}

function parseAndSanitizeSvg(svgMarkup) {
	const parser = new DOMParser();
	const svgDocument = parser.parseFromString(svgMarkup, "image/svg+xml");
	if (svgDocument.querySelector("parsererror")) {
		return null;
	}

	const svgElement = svgDocument.documentElement;
	if (!svgElement || svgElement.nodeName.toLowerCase() !== "svg") {
		return null;
	}

	sanitizeSvg(svgElement);
	return svgElement;
}

function sanitizeSvg(svgRoot) {
	const nodes = [svgRoot, ...svgRoot.querySelectorAll("*")];
	for (const node of nodes) {
		if (!(node instanceof Element)) continue;

		const tagName = node.tagName.toLowerCase();
		if (isUnsafeSvgTagName(tagName)) {
			node.remove();
			continue;
		}

		for (const attribute of Array.from(node.attributes)) {
			const name = attribute.name.toLowerCase();
			const value = attribute.value.trim();
			if (name.startsWith("on")) {
				node.removeAttribute(attribute.name);
				continue;
			}
			if (LINK_ATTRIBUTES.has(name) && isUnsafeLink(value)) {
				node.removeAttribute(attribute.name);
			}
		}
	}
}

function isUnsafeLink(value) {
	const lowered = value.toLowerCase();
	return lowered.startsWith("javascript:") || lowered.startsWith("data:text/html") || lowered.startsWith("vbscript:");
}

function readRenderError(error) {
	if (error instanceof Error && error.message) {
		const firstLine = error.message.split("\n").find((line) => line.trim().length > 0)?.trim();
		return firstLine ? firstLine.slice(0, 220) : "Unsupported Mermaid syntax.";
	}
	return "Unsupported Mermaid syntax.";
}

function waitForFrame() {
	return new Promise((resolve) => {
		if (typeof requestAnimationFrame === "function") {
			requestAnimationFrame(() => resolve());
			return;
		}
		setTimeout(resolve, 0);
	});
}
