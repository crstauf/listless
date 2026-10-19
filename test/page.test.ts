import { describe, expect, it } from "vitest";
import { PAGE_CSP, PAGE_HTML } from "../src/page.generated";
import { get, post } from "./helpers";

async function sha256(source: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
	return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

function between(html: string, open: string, close: string): string[] {
	return html.split(open).slice(1).map((part) => part.split(close)[0]);
}

describe("checklist page", () => {
	it.each(["/l/", "/l/abcDEF123_-x"])("is served at %s with strict headers", async (path) => {
		const res = await get(path);
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
		expect(res.headers.get("content-security-policy")).toBe(PAGE_CSP);
		expect(res.headers.get("referrer-policy")).toBe("no-referrer");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(await res.text()).toBe(PAGE_HTML);
	});

	it("redirects other /l paths to /l/", async () => {
		for (const path of ["/l", "/l/a/b", "/l/bad%20id"]) {
			const res = await get(path);
			expect(res.status).toBe(302);
			expect(res.headers.get("location")).toMatch(/\/l\/$/);
		}
	});

	it("only accepts GET and HEAD", async () => {
		expect((await post("/l/", "")).status).toBe(405);
	});
});

describe("Content-Security-Policy", () => {
	const directives = new Map(
		PAGE_CSP.split(";").map((d) => {
			const [name, ...values] = d.trim().split(/\s+/);
			return [name, values.join(" ")];
		}),
	);

	it("forbids every kind of network request", () => {
		expect(directives.get("default-src")).toBe("'none'");
		expect(directives.get("connect-src")).toBe("'none'");
		expect(directives.get("form-action")).toBe("'none'");
		expect(directives.get("base-uri")).toBe("'none'");
		expect(directives.get("frame-ancestors")).toBe("'none'");
		expect(directives.get("img-src")).toBe("data:");
	});

	it("matches the <meta> policy, which can't carry frame-ancestors", () => {
		const meta = PAGE_HTML.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/)?.[1];
		expect(`${meta}; frame-ancestors 'none'`).toBe(PAGE_CSP);
	});

	it("allows exactly the page's one inline script and one inline style", async () => {
		const scripts = between(PAGE_HTML, "<script>", "</script>");
		const styles = between(PAGE_HTML, "<style>", "</style>");
		expect(scripts).toHaveLength(1);
		expect(styles).toHaveLength(1);
		expect(directives.get("script-src")).toBe(`'sha256-${await sha256(scripts[0])}'`);
		expect(directives.get("style-src")).toBe(`'sha256-${await sha256(styles[0])}'`);
	});

	it("has no external resources or links in the page", () => {
		// The only absolute URL allowed is the SVG namespace inside the inline favicon.
		const urls = PAGE_HTML.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
		expect(urls.filter((u) => u !== "http://www.w3.org/2000/svg")).toEqual([]);
		expect(PAGE_HTML).not.toMatch(/<script[^>]+src=/);
		expect(PAGE_HTML).not.toMatch(/<link[^>]+rel="stylesheet"/);
	});
});
