import { LIMITS, encodeList, parseList } from "./link";

export default {
	async fetch(request): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/api/lists") {
			if (request.method !== "POST") return methodNotAllowed("POST");
			return createLink(request, url.origin);
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
