// Captures the README preview, docs/preview-light.png and docs/preview-dark.png.
//
// The built page is served to the browser directly, with the same
// Content-Security-Policy header the Worker sends, so no server is needed.
// Run `npm run screenshots`; the first time, install the browser with
// `npx playwright install chromium`.

import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { chromium } from "playwright";
import { PAGE_CSP, PAGE_HTML } from "../src/page.generated.ts";

// Requests are answered below, before they reach the network. localhost
// because the page needs a secure context (for crypto.subtle).
const origin = "http://localhost:8787";
const out = new URL("../docs/", import.meta.url);

// 800 CSS pixels at 2x: sharp on high-density screens, and the README shows it
// at 800px wide, so it appears at the page's real size.
const width = 800;
const height = 660;

const list = {
	v: 1,
	title: "Release v2.4",
	description: "Pulled from the release thread: https://github.com/example/app/issues/128",
	ordered: true,
	sections: [
		{ title: "Prepare", tasks: ["Merge the open PRs tagged `v2.4`", "Update the changelog"] },
		{
			title: "Release",
			ordered: true,
			tasks: [
				{
					text: "Publish to npm",
					details: "Run `npm publish`, then check the package page shows this version.",
					copy: [
						{ label: "Package", value: "@example/app" },
						{ label: "Version", value: "2.4.0" },
					],
				},
				"Push the tag with `git push --follow-tags`",
			],
		},
	],
};
const link = `${origin}/l/#v1.${deflateRawSync(JSON.stringify(list)).toString("base64url")}`;

const browser = await chromium.launch();
try {
	for (const scheme of ["light", "dark"] as const) {
		const page = await browser.newPage({ colorScheme: scheme, viewport: { width, height: 900 }, deviceScaleFactor: 2 });
		await page.route(`${origin}/**`, (route) =>
			route.fulfill({ contentType: "text/html; charset=utf-8", headers: { "content-security-policy": PAGE_CSP }, body: PAGE_HTML }),
		);
		await page.goto(link);
		await page.waitForURL(/\/l\/[A-Za-z0-9_-]+$/);
		// Finish "Prepare", which unlocks "Release" and its first step.
		for (const index of [0, 1]) await page.locator(".task .box").nth(index).click();
		// The grab handle and copy button only show on hover, and the pointer can only
		// be in one place, so show one of each by hand (setting style through the DOM
		// is allowed by the page's CSP).
		await page.evaluate(`
			for (const button of [document.querySelectorAll(".task")[1].querySelector(".handle"), document.querySelector(".copy button")]) {
				button.style.opacity = "1";
			}
		`);
		await page.waitForTimeout(600); // let the check mark finish drawing
		const path = fileURLToPath(new URL(`preview-${scheme}.png`, out));
		await page.screenshot({ path, clip: { x: 0, y: 0, width, height }, animations: "disabled" });
		console.log(`Wrote docs/preview-${scheme}.png`);
		await page.close();
	}
} finally {
	await browser.close();
}
