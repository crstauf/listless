// The list travels in the URL fragment as "v1." + base64url(deflate-raw(JSON)).
// The fragment is never sent to the server, so this module only runs for the
// convenience POST endpoint; agents can produce the same string themselves.

export const LIMITS = {
	maxTasks: 500,
	maxTaskLength: 1_000,
	maxTitleLength: 200,
	maxBodyBytes: 256 * 1024,
} as const;

export const FORMAT_PREFIX = "v1.";

export interface List {
	v: 1;
	title?: string;
	tasks: string[];
}

export type ParseResult = { ok: true; list: List } | { ok: false; error: string };

export function parseList(input: unknown): ParseResult {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { ok: false, error: "Body must be a JSON object." };
	}

	const { title, tasks } = input as Record<string, unknown>;

	if (title !== undefined && typeof title !== "string") {
		return { ok: false, error: "\"title\" must be a string when present." };
	}
	const trimmedTitle = title?.trim();
	if (trimmedTitle && trimmedTitle.length > LIMITS.maxTitleLength) {
		return { ok: false, error: `"title" must be at most ${LIMITS.maxTitleLength} characters.` };
	}

	if (!Array.isArray(tasks) || tasks.length === 0) {
		return { ok: false, error: "\"tasks\" must be a non-empty array of strings." };
	}
	if (tasks.length > LIMITS.maxTasks) {
		return { ok: false, error: `"tasks" may contain at most ${LIMITS.maxTasks} items.` };
	}

	const cleaned: string[] = [];
	for (const [i, task] of tasks.entries()) {
		if (typeof task !== "string" || task.trim() === "") {
			return { ok: false, error: `tasks[${i}] must be a non-empty string.` };
		}
		if (task.trim().length > LIMITS.maxTaskLength) {
			return { ok: false, error: `tasks[${i}] must be at most ${LIMITS.maxTaskLength} characters.` };
		}
		cleaned.push(task.trim());
	}

	const list: List = trimmedTitle ? { v: 1, title: trimmedTitle, tasks: cleaned } : { v: 1, tasks: cleaned };
	return { ok: true, list };
}

export async function encodeList(list: List): Promise<string> {
	const json = new TextEncoder().encode(JSON.stringify(list));
	const compressed = await transform(json, new CompressionStream("deflate-raw"));
	return FORMAT_PREFIX + toBase64Url(compressed);
}

export async function decodeList(fragment: string): Promise<unknown> {
	if (!fragment.startsWith(FORMAT_PREFIX)) throw new Error("Unknown link format.");
	const compressed = fromBase64Url(fragment.slice(FORMAT_PREFIX.length));
	const json = await transform(compressed, new DecompressionStream("deflate-raw"));
	return JSON.parse(new TextDecoder().decode(json));
}

async function transform(data: Uint8Array, stream: TransformStream<Uint8Array, Uint8Array>): Promise<Uint8Array> {
	const output = new Blob([data]).stream().pipeThrough(stream);
	return new Uint8Array(await new Response(output).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
	const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
	return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
