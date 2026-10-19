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
		["a title that is too long", JSON.stringify({ title: "t".repeat(LIMITS.maxTitleLength + 1), tasks: ["ok"] })],
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
