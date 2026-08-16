import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { DocumentReviewService } from "./server.js";

const sourceFingerprint = "a".repeat(64);
let browser: Browser;

test.before(async () => {
	try {
		browser = await chromium.launch({ headless: true });
	} catch (bundledError) {
		try {
			browser = await chromium.launch({ channel: process.env.PI_DOCUMENT_REVIEW_BROWSER_CHANNEL ?? "chrome", headless: true });
		} catch (systemError) {
			throw new Error(
				"Document reviewer browser tests need Playwright Chromium or a system Chrome channel. Run `npx playwright-core install chromium` or set PI_DOCUMENT_REVIEW_BROWSER_CHANNEL.",
				{ cause: new AggregateError([bundledError, systemError]) },
			);
		}
	}
});

test.after(async () => {
	await browser?.close();
});

function decisionReport(
	id: string,
	options: { selected?: boolean; status?: "proposed" | "accepted" } = {},
): string {
	const status = options.status ?? "proposed";
	const selected = options.selected === false ? "" : " checked";
	const accepted = status === "accepted" ? " disabled" : "";
	const recorded = status === "accepted" ? " checked disabled" : " disabled";
	return `<!doctype html><html><body style="padding-top: 140px">
		<fieldset class="decision-recorder" data-review-id="${id}" data-review-decision="recorded-decision" data-decision-status="${status}" data-decision-source-fingerprint="${sourceFingerprint}">
			<legend>Where should accounts live?</legend>
			<label><input type="radio" name="${id}" value="company"${selected}${accepted}><span>Company accounts</span></label>
			<label><input type="radio" name="${id}" value="other"${accepted}><span>Other / custom answer</span></label>
			<label><span>Custom answer</span><input type="text" data-decision-custom${accepted}></label>
			<label><span>Rationale</span><textarea data-decision-rationale${accepted}>Shared banking reality</textarea></label>
			<label><span>Owner</span><input data-decision-owner value="Product owner"${accepted}></label>
			<label><input type="checkbox" data-decision-recorded${recorded}>Decision recorded</label>
			<p class="decision-status">Not recorded</p>
		</fieldset>
	</body></html>`;
}

function unsupportedDecisionReport(id: string): string {
	return `<!doctype html><html><body style="padding-top: 140px">
		<div data-review-id="${id}" data-review-decision="single-choise">
			<label><input type="radio" name="${id}" value="option-a"><span>Option A</span></label>
		</div>
	</body></html>`;
}

function singleChoiceReport(id: string): string {
	return `<!doctype html><html><body style="padding-top: 140px">
		<div data-review-id="${id}" data-review-decision="single-choice">
			<label><input type="radio" name="${id}" value="option-a"><span>Option A</span></label>
			<label><input type="radio" name="${id}" value="option-b"><span>Option B</span><input type="text" data-single-choice-custom></label>
		</div>
	</body></html>`;
}

test("HTML review reliably persists, clears, retries, and protects decision feedback", { timeout: 30_000 }, async (t) => {
	const tempRoot = mkdtempSync(join(tmpdir(), "decision-review-browser-"));
	const service = new DocumentReviewService();
	await service.start();
	t.after(async () => {
		await service.stop();
		rmSync(tempRoot, { recursive: true, force: true });
	});

	async function createReview(name: string, html: string) {
		const filePath = join(tempRoot, `${name}.html`);
		writeFileSync(filePath, html);
		const session = await service.createHtmlSession(filePath);
		return {
			...session,
			apiBase: `${new URL(session.reviewUrl).origin}/api/${session.sessionId}`,
			sidecarPath: join(tempRoot, `${name}.review.md`),
		};
	}

	async function comments(apiBase: string): Promise<Array<Record<string, unknown>>> {
		return ((await (await fetch(`${apiBase}/comments`)).json()) as { comments: Array<Record<string, unknown>> }).comments;
	}

	await t.test("confirmation becomes selected feedback when an unblurred edit is immediately finished", async () => {
		const review = await createReview("confirm-and-flush", decisionReport("decision-confirm"));
		const finished = service.waitForFinish(review.sessionId);
		const page = await browser.newPage();
		try {
			await page.goto(review.reviewUrl);
			await page.locator("[data-decision-recorded]").check();
			await page.waitForFunction(async (base) => {
				const payload = (await (await fetch(`${base}/comments`)).json()) as { comments: Array<Record<string, unknown>> };
				return payload.comments.some((item) => item.feedbackKind === "decision" && item.decisionFeedbackStatus === "confirmed");
			}, review.apiBase);
			const reviewRoot = page.locator("#pi-html-review-root");
			await reviewRoot.locator("#toggle-drawer").click();
			assert.equal(await reviewRoot.locator(".comment-card .danger").count(), 0);
			await reviewRoot.locator("#close-drawer").click();

			await page.locator("[data-decision-rationale]").fill("Updated before immediate finish");
			await page.keyboard.press("Control+Shift+F");
			await finished;
			const sidecar = readFileSync(review.sidecarPath, "utf8");
			assert.match(sidecar, /Decision feedback status: selected/);
			assert.match(sidecar, /Updated before immediate finish/);
			assert.equal((sidecar.match(/Anchor: `decision-confirm`/g) ?? []).length, 1);
		} finally {
			await page.close();
		}
	});

	await t.test("custom input selects Other and clearing it removes stale managed feedback", async () => {
		const review = await createReview("custom-clear", decisionReport("decision-custom", { selected: false }));
		const finished = service.waitForFinish(review.sessionId);
		const page = await browser.newPage();
		try {
			await page.goto(review.reviewUrl);
			const custom = page.locator("[data-decision-custom]");
			await custom.fill("Field accounts");
			await custom.press("Tab");
			await page.waitForFunction(async (base) => {
				const payload = (await (await fetch(`${base}/comments`)).json()) as { comments: Array<{ comment: string }> };
				return payload.comments.some((item) => item.comment.includes("Decision selected: Field accounts"));
			}, review.apiBase);
			assert.equal(await page.locator('input[type="radio"][value="other"]').isChecked(), true);

			await custom.fill("");
			await custom.press("Tab");
			await page.waitForFunction(async (base) => {
				const payload = (await (await fetch(`${base}/comments`)).json()) as { comments: Array<Record<string, unknown>> };
				return payload.comments.every((item) => item.feedbackKind !== "decision");
			}, review.apiBase);
			assert.equal((await comments(review.apiBase)).length, 0);
			await page.keyboard.press("Control+Shift+F");
			await finished;
		} finally {
			await page.close();
		}
	});

	await t.test("a failed stale-feedback DELETE blocks finish and retries to an empty sidecar", async () => {
		const review = await createReview("delete-failure-retry", decisionReport("decision-delete"));
		const finished = service.waitForFinish(review.sessionId);
		const page = await browser.newPage();
		try {
			await page.goto(review.reviewUrl);
			const decision = page.locator('[data-review-id="decision-delete"]');
			await page.locator('input[type="radio"][value="company"]').dispatchEvent("change");
			await page.waitForFunction(async (base) => {
				const payload = (await (await fetch(`${base}/comments`)).json()) as { comments: Array<Record<string, unknown>> };
				return payload.comments.some((item) => item.feedbackKind === "decision");
			}, review.apiBase);

			await page.route("**/comments/decision/**", async (route) => {
				await route.fulfill({
					status: 500,
					contentType: "application/json",
					body: JSON.stringify({ error: "forced delete failure" }),
				});
			});
			await page.locator('input[type="radio"][value="other"]').check();
			await page.waitForFunction(() =>
				document.querySelector('[data-review-id="decision-delete"]')?.getAttribute("data-review-decision-dirty") === "true",
			);
			await page.keyboard.press("Control+Shift+F");
			await page.waitForFunction(() => {
				const root = document.querySelector("#pi-html-review-root")?.shadowRoot;
				const button = root?.querySelector<HTMLButtonElement>("#finish-review");
				return button?.textContent === "Finish Review" && button.disabled === false;
			});
			assert.equal(await decision.evaluate((element) => (element as HTMLElement).inert), false);
			assert.equal((await comments(review.apiBase)).filter((item) => item.feedbackKind === "decision").length, 1);

			await page.unroute("**/comments/decision/**");
			await page.locator("#pi-html-review-root").locator("#finish-review").click();
			await finished;
			assert.match(readFileSync(review.sidecarPath, "utf8"), /No comments\./);
		} finally {
			await page.close();
		}
	});

	await t.test("a failed in-flight write freezes controls, blocks finish, and retries", async () => {
		const review = await createReview("failure-retry", decisionReport("decision-retry", { selected: false }));
		const finished = service.waitForFinish(review.sessionId);
		const page = await browser.newPage();
		let releaseWrite!: () => void;
		let markWriteStarted!: () => void;
		const writeGate = new Promise<void>((resolve) => {
			releaseWrite = resolve;
		});
		const writeStarted = new Promise<void>((resolve) => {
			markWriteStarted = resolve;
		});
		try {
			await page.route("**/comments", async (route) => {
				if (route.request().method() === "POST") {
					markWriteStarted();
					await writeGate;
					await route.fulfill({
						status: 500,
						contentType: "application/json",
						body: JSON.stringify({ error: "forced write failure" }),
					});
				} else {
					await route.continue();
				}
			});
			await page.goto(review.reviewUrl);
			const decision = page.locator('[data-review-id="decision-retry"]');
			const option = page.locator('input[type="radio"][value="company"]');
			await option.check();
			await option.focus();
			assert.equal(await option.evaluate((element) => document.activeElement === element), true);
			await writeStarted;
			await page.keyboard.press("Control+Shift+F");
			await page.waitForFunction(() => {
				const root = document.querySelector("#pi-html-review-root")?.shadowRoot;
				return root?.querySelector("#finish-review")?.textContent === "Finishing…";
			});
			assert.equal(await decision.evaluate((element) => (element as HTMLElement).inert), true);
			assert.equal(await option.evaluate((element) => document.activeElement === element), false);

			releaseWrite();
			await page.waitForFunction(() => {
				const root = document.querySelector("#pi-html-review-root")?.shadowRoot;
				const button = root?.querySelector<HTMLButtonElement>("#finish-review");
				return button?.textContent === "Finish Review" && button.disabled === false;
			});
			assert.equal(await decision.evaluate((element) => (element as HTMLElement).inert), false);
			await option.focus();
			assert.equal(await option.evaluate((element) => document.activeElement === element), true);
			assert.equal((await comments(review.apiBase)).length, 0);
			assert.match((await page.locator(".decision-status").textContent()) ?? "", /not saved/i);

			await page.unroute("**/comments");
			await page.locator("#pi-html-review-root").locator("#finish-review").click();
			await finished;
			assert.match(readFileSync(review.sidecarPath, "utf8"), /Decision feedback status: selected/);
		} finally {
			releaseWrite?.();
			await page.close();
		}
	});

	await t.test("an unblurred legacy custom answer is flushed by immediate finish", async () => {
		const review = await createReview("legacy-immediate-finish", singleChoiceReport("decision-legacy-immediate"));
		const finished = service.waitForFinish(review.sessionId);
		const page = await browser.newPage();
		try {
			await page.goto(review.reviewUrl);
			await page.locator('input[type="radio"][value="option-b"]').check();
			await page.locator("[data-single-choice-custom]").fill("Immediate custom answer");
			await page.keyboard.press("Control+Shift+F");
			await finished;
			const sidecar = readFileSync(review.sidecarPath, "utf8");
			assert.match(sidecar, /Decision selected: Option B — Immediate custom answer/);
			assert.equal((sidecar.match(/Anchor: `decision-legacy-immediate`/g) ?? []).length, 1);
		} finally {
			await page.close();
		}
	});

	await t.test("failed legacy single-choice feedback is retried", async () => {
		const review = await createReview("legacy-failure-retry", singleChoiceReport("decision-legacy"));
		const finished = service.waitForFinish(review.sessionId);
		const page = await browser.newPage();
		try {
			await page.route("**/comments", async (route) => {
				if (route.request().method() === "POST") {
					await route.fulfill({
						status: 500,
						contentType: "application/json",
						body: JSON.stringify({ error: "forced legacy write failure" }),
					});
				} else {
					await route.continue();
				}
			});
			await page.goto(review.reviewUrl);
			const option = page.locator('input[type="radio"][value="option-b"]');
			await option.check();
			await page.waitForFunction(() =>
				document.querySelector('[data-review-id="decision-legacy"]')?.getAttribute("data-review-decision-dirty") === "true",
			);
			await page.keyboard.press("Control+Shift+F");
			await page.waitForFunction(() => {
				const root = document.querySelector("#pi-html-review-root")?.shadowRoot;
				const button = root?.querySelector<HTMLButtonElement>("#finish-review");
				return button?.textContent === "Finish Review" && button.disabled === false;
			});
			assert.equal(await option.isEnabled(), true);
			assert.equal((await comments(review.apiBase)).length, 0);

			await page.unroute("**/comments");
			await page.keyboard.press("Control+Shift+F");
			await finished;
			const sidecar = readFileSync(review.sidecarPath, "utf8");
			assert.match(sidecar, /Decision feedback status: selected/);
			assert.match(sidecar, /Decision selected: Option B/);
		} finally {
			await page.close();
		}
	});

	await t.test("unsupported decision marker values do not fall through to weaker feedback", async () => {
		const review = await createReview("unsupported-marker", unsupportedDecisionReport("decision-unsupported"));
		const finished = service.waitForFinish(review.sessionId);
		const page = await browser.newPage();
		try {
			await page.goto(review.reviewUrl);
			await page.locator('input[type="radio"][value="option-a"]').check();
			assert.equal((await comments(review.apiBase)).length, 0);
			await page.locator("#pi-html-review-root").locator("#finish-review").click();
			await finished;
			assert.match(readFileSync(review.sidecarPath, "utf8"), /No comments\./);
		} finally {
			await page.close();
		}
	});

	await t.test("accepted decisions remain read-only and create no review feedback", async () => {
		const review = await createReview("accepted", decisionReport("decision-accepted", { status: "accepted" }));
		const finished = service.waitForFinish(review.sessionId);
		const page = await browser.newPage();
		try {
			await page.goto(review.reviewUrl);
			const checkbox = page.locator("[data-decision-recorded]");
			assert.equal(await checkbox.isChecked(), true);
			assert.equal(await checkbox.isDisabled(), true);
			assert.equal((await comments(review.apiBase)).length, 0);
			await page.keyboard.press("Control+Shift+F");
			await finished;
			assert.match(readFileSync(review.sidecarPath, "utf8"), /No comments\./);
		} finally {
			await page.close();
		}
	});
});
