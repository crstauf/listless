// The list travels in the URL fragment as "v1." + base64url(deflate-raw(JSON)).
// The fragment is never sent to the server, so this module only runs for the
// convenience POST endpoint; agents can produce the same string themselves.

export const LIMITS = {
	maxTasks: 500,
	maxSections: 50,
	maxTaskLength: 1_000,
	maxDetailsLength: 2_000,
	maxTitleLength: 200,
	maxDescriptionLength: 2_000,
	maxBodyBytes: 256 * 1024,
} as const;

export const FORMAT_PREFIX = "v1.";

// A task is plain text, or text plus muted details. Backtick spans in any text
// are shown as code on the page; nothing else is interpreted. `done` marks a
// task that starts out checked off.
export type Task = string | { text: string; details?: string; done?: true };

export interface Section {
	title: string;
	tasks: Task[];
}

export type List = {
	v: 1;
	title?: string;
	// Shown under the title. Web addresses in it become links, so it's the
	// place for a link back to the conversation the list came from.
	description?: string;
	ordered?: true;
} & ({ tasks: Task[] } | { sections: Section[] });

export type ParseResult = { ok: true; list: List } | { ok: false; error: string };

class InvalidList extends Error {}

export function parseList(input: unknown): ParseResult {
	try {
		return { ok: true, list: toList(input) };
	} catch (error) {
		if (error instanceof InvalidList) return { ok: false, error: error.message };
		throw error;
	}
}

function toList(input: unknown): List {
	if (!isObject(input)) throw new InvalidList("Body must be a JSON object.");
	const { title, description, ordered, tasks, sections } = input;

	const cleanTitle = optionalText(title, "title", LIMITS.maxTitleLength);
	const cleanDescription = optionalText(description, "description", LIMITS.maxDescriptionLength);
	if (ordered !== undefined && typeof ordered !== "boolean") {
		throw new InvalidList('"ordered" must be true or false when present.');
	}
	if ((tasks === undefined) === (sections === undefined)) {
		throw new InvalidList('Provide either "tasks" or "sections", not both.');
	}

	const head = {
		v: 1 as const,
		...(cleanTitle ? { title: cleanTitle } : {}),
		...(cleanDescription ? { description: cleanDescription } : {}),
		...(ordered ? { ordered: true as const } : {}),
	};
	let count = 0;
	const countTasks = (n: number) => {
		count += n;
		if (count > LIMITS.maxTasks) throw new InvalidList(`A list may contain at most ${LIMITS.maxTasks} tasks.`);
	};

	if (tasks !== undefined) {
		const cleaned = taskList(tasks, "tasks");
		countTasks(cleaned.length);
		if (ordered) checkDoneFirst(cleaned);
		return { ...head, tasks: cleaned };
	}

	if (!Array.isArray(sections) || sections.length === 0) {
		throw new InvalidList('"sections" must be a non-empty array.');
	}
	if (sections.length > LIMITS.maxSections) {
		throw new InvalidList(`"sections" may contain at most ${LIMITS.maxSections} items.`);
	}
	const cleanedSections = sections.map((section, i): Section => {
		const path = `sections[${i}]`;
		if (!isObject(section)) throw new InvalidList(`${path} must be an object with "title" and "tasks".`);
		const sectionTitle = requiredText(section.title, `${path}.title`, LIMITS.maxTitleLength);
		const sectionTasks = taskList(section.tasks, `${path}.tasks`);
		countTasks(sectionTasks.length);
		return { title: sectionTitle, tasks: sectionTasks };
	});
	if (ordered) checkDoneFirst(cleanedSections.flatMap((section) => section.tasks));
	return { ...head, sections: cleanedSections };
}

// Ordered lists are completed from the top, so a task can only start out done
// if every task before it does too.
function checkDoneFirst(tasks: Task[]): void {
	let open = false;
	for (const task of tasks) {
		const done = typeof task !== "string" && task.done === true;
		if (done && open) throw new InvalidList('In an ordered list, "done" tasks must come before all others.');
		if (!done) open = true;
	}
}

function taskList(value: unknown, path: string): Task[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new InvalidList(`"${path}" must be a non-empty array of tasks.`);
	}
	if (value.length > LIMITS.maxTasks) {
		throw new InvalidList(`A list may contain at most ${LIMITS.maxTasks} tasks.`);
	}
	return value.map((task, i) => cleanTask(task, `${path}[${i}]`));
}

function cleanTask(task: unknown, path: string): Task {
	if (typeof task === "string") return requiredText(task, path, LIMITS.maxTaskLength);
	if (!isObject(task)) throw new InvalidList(`${path} must be a string or an object with "text".`);
	const text = requiredText(task.text, `${path}.text`, LIMITS.maxTaskLength);
	const details = optionalText(task.details, `${path}.details`, LIMITS.maxDetailsLength);
	if (task.done !== undefined && typeof task.done !== "boolean") {
		throw new InvalidList(`"${path}.done" must be true or false when present.`);
	}
	if (!details && !task.done) return text;
	return { text, ...(details ? { details } : {}), ...(task.done ? { done: true as const } : {}) };
}

function requiredText(value: unknown, path: string, max: number): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new InvalidList(`${path} must be a non-empty string.`);
	}
	return checkLength(value.trim(), path, max);
}

function optionalText(value: unknown, path: string, max: number): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new InvalidList(`"${path}" must be a string when present.`);
	return checkLength(value.trim(), path, max) || undefined;
}

function checkLength(value: string, path: string, max: number): string {
	if (value.length > max) throw new InvalidList(`${path} must be at most ${max} characters.`);
	return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
