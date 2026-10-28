import { deflateRawSync } from "node:zlib";
import { afterAll, afterEach, beforeAll, expect } from "vitest";
import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "playwright";
import { PAGE_CSP, PAGE_HTML } from "../../src/page.generated.ts";

// Requests are answered before they reach the network, with the same headers
// the Worker sends. localhost because the page needs a secure context (for
// crypto.subtle and the clipboard).
export const ORIGIN = "http://localhost:8787";

export function linkFor(list: Record<string, unknown>): string {
	return `${ORIGIN}/l/#v1.${deflateRawSync(JSON.stringify({ v: 1, ...list })).toString("base64url")}`;
}

export function plainLinkFor(list: Record<string, unknown>): string {
	return `${ORIGIN}/l/#json=${encodeURIComponent(JSON.stringify({ v: 1, ...list }))}`;
}

export const ID_URL = /\/l\/[A-Za-z0-9_-]{12}$/;

export interface Session {
	context: BrowserContext;
	open(url: string): Promise<Page>;
}

// Starts one Chromium for the file and gives each test its own browser context,
// so each starts with empty localStorage. A test fails if the page logs an error,
// which is how CSP violations show up, or opens a dialog: the page confirms with
// a second click and offers undo, never with alert(), confirm() or prompt().
export function useBrowser() {
	let browser: Browser;
	const contexts: BrowserContext[] = [];
	const errors: string[] = [];
	const dialogs: string[] = [];

	beforeAll(async () => {
		browser = await chromium.launch();
	});

	afterAll(async () => {
		await browser.close();
	});

	afterEach(async () => {
		await Promise.all(contexts.splice(0).map((context) => context.close()));
		expect(errors.splice(0)).toEqual([]);
		expect(dialogs.splice(0)).toEqual([]);
	});

	// Options are for the browser context: a colour scheme, a touch screen, a viewport.
	return async function session(options: BrowserContextOptions = {}): Promise<Session> {
		const context = await browser.newContext({ viewport: { width: 800, height: 900 }, ...options });
		contexts.push(context);
		await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
		await context.route(`${ORIGIN}/**`, (route) =>
			route.fulfill({ contentType: "text/html; charset=utf-8", headers: { "content-security-policy": PAGE_CSP }, body: PAGE_HTML }),
		);
		return {
			context,
			async open(url) {
				const page = await context.newPage();
				page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
				page.on("pageerror", (error) => errors.push(error.message));
				page.on("dialog", (dialog) => {
					dialogs.push(dialog.message());
					void dialog.dismiss();
				});
				await page.goto(url);
				return page;
			},
		};
	};
}
