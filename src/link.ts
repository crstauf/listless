// The list travels in the URL fragment as "v1." + base64url(deflate-raw(JSON)).
// The fragment is never sent to the server, so this module only runs for the
// convenience POST endpoint; agents can produce the same string themselves.

import { LIMITS } from "./limits";

export { LIMITS };

export const FORMAT_PREFIX = "v1.";

// A task is plain text, or text plus muted details. Backtick spans in any text
// are shown as code on the page; nothing else is interpreted. `copy` is one or
// more values the user will paste elsewhere, shown literally with a copy button
// each. A value may carry a short label. A single unlabeled value is always a
// plain string. `done` marks a task that starts out checked off.
export type CopyValue = string | { label: string; value: string };
export type Task = string | { text: string; details?: string; copy?: string | CopyValue[]; done?: true };

export interface Section {
	title: string;
	// The tasks in this section are done in sequence.
	ordered?: true;
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
		if (ordered) checkDoneFirst(cleaned, "list");
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
		if (section.ordered !== undefined && typeof section.ordered !== "boolean") {
			throw new InvalidList(`"${path}.ordered" must be true or false when present.`);
		}
		const sectionTasks = taskList(section.tasks, `${path}.tasks`);
		countTasks(sectionTasks.length);
		return { title: sectionTitle, ...(section.ordered ? { ordered: true as const } : {}), tasks: sectionTasks };
	});
	checkDoneSections(cleanedSections, ordered === true);
	return { ...head, sections: cleanedSections };
}

// An ordered list is completed section by section, and an ordered section task
// by task, so a task can only start out done if what comes before it does too.
function checkDoneSections(sections: Section[], ordered: boolean): void {
	let incomplete = false;
	for (const section of sections) {
		const flags = section.tasks.map(isDone);
		if (ordered && incomplete && flags.includes(true)) {
			throw new InvalidList('In an ordered list, a section can only have "done" tasks once every section before it is done.');
		}
		if (section.ordered) checkDoneFirst(section.tasks, "section");
		if (flags.includes(false)) incomplete = true;
	}
}

// Without sections, an ordered list is one sequence of tasks.
function checkDoneFirst(tasks: Task[], kind: "list" | "section"): void {
	let open = false;
	for (const task of tasks) {
		if (isDone(task) && open) throw new InvalidList(`In an ordered ${kind}, "done" tasks must come before all others.`);
		if (!isDone(task)) open = true;
	}
}

function isDone(task: Task): boolean {
	return typeof task !== "string" && task.done === true;
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
	const copy = copyValues(task.copy, `${path}.copy`);
	if (!details && !copy && !task.done) return text;
	return {
		text,
		...(details ? { details } : {}),
		...(copy ? { copy } : {}),
		...(task.done ? { done: true as const } : {}),
	};
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

// A string, or an array of strings and { label, value } objects. Blank values
// are dropped, blank labels are ignored, and one unlabeled value collapses to a
// string so lists that never used several values keep their form (and ID).
function copyValues(value: unknown, path: string): string | CopyValue[] | undefined {
	if (typeof value === "string" || value === undefined) return optionalText(value, path, LIMITS.maxCopyLength);
	if (!Array.isArray(value)) throw new InvalidList(`"${path}" must be a string or an array when present.`);
	if (value.length > LIMITS.maxCopyValues) {
		throw new InvalidList(`"${path}" may contain at most ${LIMITS.maxCopyValues} values.`);
	}
	const items: CopyValue[] = [];
	value.forEach((item, i) => {
		const at = `${path}[${i}]`;
		if (typeof item === "string") {
			const text = optionalText(item, at, LIMITS.maxCopyLength);
			if (text) items.push(text);
		} else if (isObject(item)) {
			const text = optionalText(item.value, `${at}.value`, LIMITS.maxCopyLength);
			const label = optionalText(item.label, `${at}.label`, LIMITS.maxCopyLabelLength);
			if (text) items.push(label ? { label, value: text } : text);
		} else {
			throw new InvalidList(`${at} must be a string or an object with "value".`);
		}
	});
	if (items.length === 0) return undefined;
	return items.length === 1 && typeof items[0] === "string" ? items[0] : items;
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
