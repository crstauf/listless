import { describe, expect, it } from "vitest";
import { LIMITS, decodeList } from "../src/link";
import { ORIGIN, get, post } from "./helpers";

async function createLink(body: unknown) {
	const res = await post("/api/lists", JSON.stringify(body), { "content-type": "application/json" });
	return { res, data: (await res.json()) as { url?: string; error?: string } };
}

describe("POST /api/lists", () => {
	it("returns a link whose fragment decodes back to the list", async () => {
		const { res, data } = await createLink({ title: "  Groceries ", tasks: ["Milk", "  Eggs  ", "Bread\nwhole wheat"] });
		expect(res.status).toBe(201);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(data.url).toMatch(new RegExp(`^${ORIGIN}/l/#v1\\.[A-Za-z0-9_-]+$`));

		const fragment = data.url!.split("#")[1];
		expect(await decodeList(fragment)).toEqual({ v: 1, title: "Groceries", tasks: ["Milk", "Eggs", "Bread\nwhole wheat"] });
	});

	it("omits a missing or blank title", async () => {
		for (const title of [undefined, "   "]) {
			const { data } = await createLink({ title, tasks: ["One"] });
			expect(await decodeList(data.url!.split("#")[1])).toEqual({ v: 1, tasks: ["One"] });
		}
	});

	it("keeps a trimmed description, line breaks included, and omits a blank one", async () => {
		const description = "From https://claude.ai/code/session_123\nSecond line";
		const { data } = await createLink({ title: "T", description: `  ${description} `, tasks: ["One"] });
		expect(await decodeList(data.url!.split("#")[1])).toEqual({ v: 1, title: "T", description, tasks: ["One"] });

		const blank = await createLink({ description: "  ", tasks: ["One"] });
		expect(await decodeList(blank.data.url!.split("#")[1])).toEqual({ v: 1, tasks: ["One"] });
	});

	it("round-trips ordered lists, sections and task details", async () => {
		const list = {
			title: "Ship it",
			ordered: true,
			sections: [
				{ title: " Setup ", tasks: ["Review the PR", { text: "Create a token ", details: " Use the `Edit Workers` template. " }] },
				{ title: "Deploy", tasks: [{ text: "Run `npm run deploy`" }] },
			],
		};
		const { res, data } = await createLink(list);
		expect(res.status).toBe(201);
		expect(await decodeList(data.url!.split("#")[1])).toEqual({
			v: 1,
			title: "Ship it",
			ordered: true,
			sections: [
				{ title: "Setup", tasks: ["Review the PR", { text: "Create a token", details: "Use the `Edit Workers` template." }] },
				{ title: "Deploy", tasks: ["Run `npm run deploy`"] },
			],
		});
	});

	it("keeps ordered on a section, and drops it when false", async () => {
		const { res, data } = await createLink({
			sections: [
				{ title: "Gather", ordered: false, tasks: ["a"] },
				{ title: "Install", ordered: true, tasks: ["b", "c"] },
			],
		});
		expect(res.status).toBe(201);
		expect(await decodeList(data.url!.split("#")[1])).toEqual({
			v: 1,
			sections: [
				{ title: "Gather", tasks: ["a"] },
				{ title: "Install", ordered: true, tasks: ["b", "c"] },
			],
		});
	});

	it("keeps a trimmed copy value and drops a blank one", async () => {
		const { data } = await createLink({
			tasks: [{ text: "Email Dana", copy: " dana@example.com " }, { text: "One", copy: "  " }, { text: "Two", copy: "a\nb", details: "d" }],
		});
		expect(await decodeList(data.url!.split("#")[1])).toEqual({
			v: 1,
			tasks: [{ text: "Email Dana", copy: "dana@example.com" }, "One", { text: "Two", details: "d", copy: "a\nb" }],
		});
	});

	it("omits ordered when false and blank details", async () => {
		const { data } = await createLink({ ordered: false, tasks: [{ text: "One", details: "  " }] });
		expect(await decodeList(data.url!.split("#")[1])).toEqual({ v: 1, tasks: ["One"] });
	});

	it("keeps done on tasks and drops done: false", async () => {
		const { res, data } = await createLink({
			tasks: [{ text: "One", done: true }, { text: "Two", done: false }, { text: "Three", details: "d", done: true }],
		});
		expect(res.status).toBe(201);
		expect(await decodeList(data.url!.split("#")[1])).toEqual({
			v: 1,
			tasks: [{ text: "One", done: true }, "Two", { text: "Three", details: "d", done: true }],
		});
	});

	it("accepts done tasks first in an ordered list, across sections", async () => {
		const { res } = await createLink({
			ordered: true,
			sections: [
				{ title: "A", tasks: [{ text: "1", done: true }, { text: "2", done: true }] },
				{ title: "B", tasks: [{ text: "3", done: true }, "4"] },
			],
		});
		expect(res.status).toBe(201);
	});

	it("accepts done tasks across sections that are only ordered one way", async () => {
		const { res } = await createLink({
			sections: [
				{ title: "A", ordered: true, tasks: [{ text: "1", done: true }, "2"] },
				{ title: "B", tasks: ["3", { text: "4", done: true }] },
			],
		});
		expect(res.status).toBe(201);
		const gated = await createLink({
			ordered: true,
			sections: [
				{ title: "A", tasks: [{ text: "1", done: true }, "2"] },
				{ title: "B", tasks: ["3"] },
			],
		});
		expect(gated.res.status).toBe(201);
	});

	it.each([
		["a non-boolean done", { tasks: [{ text: "a", done: "yes" }] }],
		["a done task after an open one in an ordered list", { ordered: true, tasks: ["a", { text: "b", done: true }] }],
		[
			"a done task after an open one across ordered sections",
			{ ordered: true, sections: [{ title: "A", tasks: ["a"] }, { title: "B", tasks: [{ text: "b", done: true }] }] },
		],
		[
			"a done task after an open one in an ordered section",
			{ sections: [{ title: "A", ordered: true, tasks: ["a", { text: "b", done: true }] }] },
		],
		["a non-boolean section ordered", { sections: [{ title: "A", ordered: "yes", tasks: ["a"] }] }],
	])("rejects %s", async (_, body) => {
		expect((await createLink(body)).res.status).toBe(400);
	});

	it("keeps 50 tasks to a reasonable link length", async () => {
		const tasks = Array.from({ length: 50 }, (_, i) => `Task ${i + 1}: do the thing that needs doing next`);
		const { data } = await createLink({ title: "Fifty", tasks });
		expect(data.url!.length).toBeLessThan(3000);
		expect(await decodeList(data.url!.split("#")[1])).toEqual({ v: 1, title: "Fifty", tasks });
	});

	it.each([
		["not JSON", "nope"],
		["an array", "[]"],
		["missing tasks", JSON.stringify({ title: "x" })],
		["empty tasks", JSON.stringify({ tasks: [] })],
		["a non-string task", JSON.stringify({ tasks: ["ok", 3] })],
		["a blank task", JSON.stringify({ tasks: ["ok", "  "] })],
		["a non-string title", JSON.stringify({ title: 1, tasks: ["ok"] })],
		["too many tasks", JSON.stringify({ tasks: Array(LIMITS.maxTasks + 1).fill("t") })],
		["a task that is too long", JSON.stringify({ tasks: ["t".repeat(LIMITS.maxTaskLength + 1)] })],
		["a non-string description", JSON.stringify({ description: ["x"], tasks: ["ok"] })],
		["a description that is too long", JSON.stringify({ description: "d".repeat(LIMITS.maxDescriptionLength + 1), tasks: ["ok"] })],
		["a title that is too long", JSON.stringify({ title: "t".repeat(LIMITS.maxTitleLength + 1), tasks: ["ok"] })],
		["both tasks and sections", JSON.stringify({ tasks: ["ok"], sections: [{ title: "s", tasks: ["ok"] }] })],
		["empty sections", JSON.stringify({ sections: [] })],
		["a section without tasks", JSON.stringify({ sections: [{ title: "s", tasks: [] }] })],
		["a section without a title", JSON.stringify({ sections: [{ tasks: ["ok"] }] })],
		["too many sections", JSON.stringify({ sections: Array(LIMITS.maxSections + 1).fill({ title: "s", tasks: ["ok"] }) })],
		["too many tasks across sections", JSON.stringify({ sections: Array(2).fill({ title: "s", tasks: Array(LIMITS.maxTasks / 2 + 1).fill("t") }) })],
		["a task object without text", JSON.stringify({ tasks: [{ details: "d" }] })],
		["details that are too long", JSON.stringify({ tasks: [{ text: "ok", details: "d".repeat(LIMITS.maxDetailsLength + 1) }] })],
		["a copy value that is not a string", JSON.stringify({ tasks: [{ text: "ok", copy: 5 }] })],
		["a copy value that is too long", JSON.stringify({ tasks: [{ text: "ok", copy: "c".repeat(LIMITS.maxCopyLength + 1) }] })],
		["a non-boolean ordered", JSON.stringify({ ordered: "yes", tasks: ["ok"] })],
	])("rejects %s with 400", async (_, body) => {
		const res = await post("/api/lists", body);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBeTruthy();
	});

	it("rejects an oversized body with 413", async () => {
		const res = await post("/api/lists", JSON.stringify({ tasks: ["x".repeat(LIMITS.maxBodyBytes)] }));
		expect(res.status).toBe(413);
	});

	it("only accepts POST", async () => {
		const res = await get("/api/lists");
		expect(res.status).toBe(405);
		expect(res.headers.get("allow")).toBe("POST");
	});
});

describe("GET /", () => {
	it("serves plain-text docs using the request origin", async () => {
		const res = await get("/");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		const text = await res.text();
		expect(text).toContain("No off-site storage: everything is local");
		expect(text).toContain(`${ORIGIN}/l/#v1.`);
		expect(text).toContain(`curl -s -X POST ${ORIGIN}/api/lists`);
	});
});

describe("unknown paths", () => {
	it("return 404", async () => {
		expect((await get("/nope")).status).toBe(404);
	});
});
