import { docs } from "./docs";
import { LIMITS, encodeList, parseList } from "./link";
import { PAGE_CSP, PAGE_HTML } from "./page.generated";

export default {
	async fetch(request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/") {
			if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
			return new Response(docs(url.origin), {
				headers: {
					"content-type": "text/plain; charset=utf-8",
					"x-content-type-options": "nosniff",
					"cache-control": "public, max-age=300",
				},
			});
		}

		if (url.pathname === "/api/lists") {
			if (request.method !== "POST") return methodNotAllowed("POST");
			return createLink(request, url.origin);
		}

		if (url.pathname === "/l" || url.pathname.startsWith("/l/")) {
			if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
			if (!/^\/l\/([A-Za-z0-9_-]+)?$/.test(url.pathname)) return Response.redirect(`${url.origin}/l/`, 302);
			return page();
		}

		return new Response("Not found\n", { status: 404 });
	},
} satisfies ExportedHandler;

// Turns a posted list into a link. Nothing is stored or logged: the list only
// exists in this request's memory and in the link returned to the caller.
async function createLink(request: Request, origin: string): Promise<Response> {
	const declaredLength = Number(request.headers.get("content-length") ?? 0);
	if (declaredLength > LIMITS.maxBodyBytes) return tooLarge();

	const body = await request.text();
	if (new TextEncoder().encode(body).byteLength > LIMITS.maxBodyBytes) return tooLarge();

	let input: unknown;
	try {
		input = JSON.parse(body);
	} catch {
		return json({ error: "Body must be valid JSON." }, 400);
	}

	const result = parseList(input);
	if (!result.ok) return json({ error: result.error }, 400);

	const fragment = await encodeList(result.list);
	return json({ url: `${origin}/l/#${fragment}` }, 201);
}

// The same static page serves every list. The list itself is in the URL
// fragment or the browser's localStorage, neither of which reaches this Worker.
function page(): Response {
	return new Response(PAGE_HTML, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"content-security-policy": PAGE_CSP,
			"referrer-policy": "no-referrer",
			"x-content-type-options": "nosniff",
			"permissions-policy": "camera=(), microphone=(), geolocation=()",
			"cache-control": "public, max-age=300",
		},
	});
}

function tooLarge(): Response {
	return json({ error: `Body must be at most ${LIMITS.maxBodyBytes} bytes.` }, 413);
}

function methodNotAllowed(allow: string): Response {
	return new Response("Method not allowed\n", { status: 405, headers: { allow } });
}

function json(data: unknown, status: number): Response {
	return new Response(JSON.stringify(data) + "\n", {
		status,
		headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
	});
}
