import { inflateRawSync } from "node:zlib";
import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { ID_URL, ORIGIN, linkFor, plainLinkFor, useBrowser } from "./helpers.ts";

const session = useBrowser();

const input = (page: Page, index: number) => page.locator("#list input[type=checkbox]").nth(index);
const toggle = (page: Page, index: number) => page.locator("#list .task .box").nth(index).click();
const texts = (page: Page) => page.locator("#list .text").allTextContents();
const checks = (page: Page) => page.locator("#list input[type=checkbox]").evaluateAll((boxes) => boxes.map((box) => (box as HTMLInputElement).checked));

const shareLink = async (page: Page) => {
	await page.locator("#share").click();
	await page.locator("#share.flash").waitFor(); // building the link is asynchronous
	return page.evaluate(() => navigator.clipboard.readText());
};
// The Markdown the Copy as Markdown button copies, without the note for agents after it.
const listMarkdown = (markdown: string) => markdown.split("\n\n---\n")[0] + "\n";
const decodeLink = (url: string) => JSON.parse(inflateRawSync(Buffer.from(url.split("#v1.")[1], "base64url")).toString());

const groceries = { title: "Groceries", tasks: ["Milk", "Eggs", "Bread"] };
const steps = { title: "Steps", ordered: true, tasks: ["One", "Two", "Three"] };

describe("opening a link", () => {
	it("shows the list and swaps the address for a short one", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		await page.waitForURL(ID_URL);
		expect(await page.locator("#title").textContent()).toBe("Groceries");
		expect(await texts(page)).toEqual(["Milk", "Eggs", "Bread"]);
		expect(await page.locator("#progress-text").textContent()).toBe("0 of 3 done");
	}, 296);

	it("finds the same list, and its check marks, when the link is opened again", async () => {
		const { open } = await session();
		const first = await open(linkFor(groceries));
		await first.waitForURL(ID_URL);
		await toggle(first, 1);
		const second = await open(linkFor(groceries));
		await second.waitForURL(ID_URL);
		expect(second.url()).toBe(first.url());
		expect(await checks(second)).toEqual([false, true, false]);
	}, 377);

	it("says so when the link is damaged", async () => {
		const { open } = await session();
		const page = await open(`${ORIGIN}/l/#v1.not-a-list!`);
		expect(await page.locator("#message-title").textContent()).toBe("This link is damaged");
	}, 159);

	it("starts done tasks checked, and drops a gap in an ordered list", async () => {
		const { open } = await session();
		const plain = await open(linkFor({ tasks: ["A", { text: "B", done: true }, "C"] }));
		expect(await checks(plain)).toEqual([false, true, false]);
		const ordered = await open(linkFor({ ordered: true, tasks: ["A", { text: "B", done: true }] }));
		expect(await checks(ordered)).toEqual([false, false]);
	}, 294);
});

describe("ordered lists", () => {
	it("locks later steps until the one before is checked", async () => {
		const { open } = await session();
		const page = await open(linkFor(steps));
		expect(await Promise.all([0, 1, 2].map((i) => input(page, i).isDisabled()))).toEqual([false, true, true]);
		await toggle(page, 0);
		expect(await Promise.all([0, 1, 2].map((i) => input(page, i).isDisabled()))).toEqual([false, false, true]);
	}, 221);

	it("reopens every later step when a step is unchecked, after asking", async () => {
		const { open } = await session();
		const page = await open(linkFor(steps));
		await toggle(page, 0);
		await toggle(page, 1);

		await toggle(page, 0); // the first uncheck only arms the step
		expect(await checks(page)).toEqual([true, true, false]);
		expect(await page.locator("#list .task").nth(0).getAttribute("class")).toContain("armed");
		expect(await page.locator("#announce").textContent()).toContain("Uncheck again to reopen this step and the step after it");

		await toggle(page, 0); // the second goes ahead
		expect(await checks(page)).toEqual([false, false, false]);
		expect(await page.locator("#toast-text").textContent()).toBe("Reopened this step and the step after it");
		await page.locator("#toast-undo").click();
		expect(await checks(page)).toEqual([true, true, false]);
		expect(await page.locator("#toast").isHidden()).toBe(true);
	}, 446);

	it("unchecks the last step without asking", async () => {
		const { open } = await session();
		const page = await open(linkFor(steps));
		await toggle(page, 0);
		await toggle(page, 0);
		expect(await checks(page)).toEqual([false, false, false]);
	}, 272);
});

describe("ordered sections", () => {
	const setup = {
		title: "Setup",
		ordered: true,
		sections: [
			{ title: "Gather", tasks: ["Key", "Token"] },
			{ title: "Install", ordered: true, tasks: ["Clone", "Build", "Test"] },
		],
	};
	const locked = (page: Page) => Promise.all([0, 1, 2, 3, 4].map((i) => input(page, i).isDisabled()));

	it("locks a section until the ones before it are done, then runs its steps in order", async () => {
		const { open } = await session();
		const page = await open(linkFor(setup));
		expect(await locked(page)).toEqual([false, false, true, true, true]);
		await toggle(page, 1); // tasks within an unordered section go in any order
		await toggle(page, 0);
		expect(await locked(page)).toEqual([false, false, false, true, true]);
		expect(await page.locator("#list .step").allTextContents()).toEqual(["Step 1", "Step 2", "Step 3"]);
	}, 293);

	it("only gives handles to sections that aren't ordered", async () => {
		const { open } = await session();
		const page = await open(linkFor(setup));
		expect(await page.locator("#list .handle").count()).toBe(2);
	}, 147);

	it("reopens later sections when an earlier task is unchecked, after asking", async () => {
		const { open } = await session();
		const page = await open(linkFor(setup));
		for (const i of [0, 1, 2, 3]) await toggle(page, i);
		expect(await checks(page)).toEqual([true, true, true, true, false]);

		await toggle(page, 0);
		expect(await checks(page)).toEqual([true, true, true, true, false]);
		expect(await page.locator("#announce").textContent()).toContain("Uncheck again to reopen this task and the 2 tasks after it");
		await toggle(page, 0);
		expect(await checks(page)).toEqual([false, true, false, false, false]);
		await page.locator("#toast-undo").click();
		expect(await checks(page)).toEqual([true, true, true, true, false]);
	}, 534);

	it("leaves the tasks of an unordered list's sections free when only the list is ordered", async () => {
		const { open } = await session();
		const page = await open(linkFor({ ordered: true, sections: [{ title: "A", tasks: ["a", "b"] }, { title: "B", tasks: ["c"] }] }));
		expect(await Promise.all([0, 1, 2].map((i) => input(page, i).isDisabled()))).toEqual([false, false, true]);
		await toggle(page, 1);
		await toggle(page, 0);
		expect(await checks(page)).toEqual([true, true, false]);
	}, 290);

	it("starts done tasks checked only where the ordering allows", async () => {
		const { open } = await session();
		const page = await open(
			linkFor({
				ordered: true,
				sections: [
					{ title: "A", tasks: [{ text: "a", done: true }, "b"] },
					{ title: "B", tasks: [{ text: "c", done: true }] },
				],
			}),
		);
		expect(await checks(page)).toEqual([true, false, false]);
	}, 146);

	it("carries section ordering into the Markdown and the share link", async () => {
		const { open } = await session();
		const page = await open(linkFor(setup));
		await page.locator("#copy").click();
		await page.locator("#copy.flash").waitFor();
		const copied = await page.evaluate(() => navigator.clipboard.readText());
		const markdown = listMarkdown(copied);
		expect(markdown).toBe("# Setup\n\n## Gather\n\n- [ ] Key\n- [ ] Token\n\n## Install\n\n1. [ ] Clone\n2. [ ] Build\n3. [ ] Test\n");

		await page.locator("#share").click();
		await page.locator("#share.flash").waitFor();
		const shared = await page.evaluate(() => navigator.clipboard.readText());
		const other = await (await session()).open(shared);
		await other.waitForURL(ID_URL);
		expect(await other.locator("#list .step").count()).toBe(3);
	}, 473);

	it("keeps check marks when reloaded, and drops saved ones the ordering doesn't allow", async () => {
		const { open } = await session();
		const page = await open(linkFor(setup));
		for (const i of [0, 1, 2]) await toggle(page, i);
		await page.reload();
		await page.locator("#list .task").first().waitFor();
		expect(await checks(page)).toEqual([true, true, true, false, false]);

		// Checks saved for Install while Gather is unfinished can't be honored.
		await page.evaluate(() => {
			for (const key of Object.keys(localStorage)) {
				const list = JSON.parse(localStorage.getItem(key)!);
				if (Array.isArray(list.checked)) localStorage.setItem(key, JSON.stringify({ ...list, checked: [1, 3, 4] }));
			}
		});
		await page.reload();
		await page.locator("#list .task").first().waitFor();
		expect(await checks(page)).toEqual([false, true, false, false, false]);
	}, 506);

	it("offers a link's check marks only where the ordering allows them", async () => {
		const { open } = await session();
		const first = await open(linkFor(setup));
		await first.waitForURL(ID_URL);

		const done = (...marked: number[]) => ({
			...setup,
			sections: setup.sections.map((section, s) => ({
				...section,
				tasks: section.tasks.map((text, k) => (marked.includes(s * 2 + k) ? { text, done: true } : text)),
			})),
		});

		// Install's first step can't start out done while Gather is unfinished.
		const early = await open(linkFor(done(2)));
		await early.waitForURL(ID_URL);
		expect(await early.locator("#notice").isHidden()).toBe(true);

		const allowed = await open(linkFor(done(0, 1, 2)));
		await allowed.waitForURL(ID_URL);
		expect(await allowed.locator("#notice").textContent()).toContain("check marks your saved copy doesn't");
		await allowed.locator("#notice button").click();
		expect(await checks(allowed)).toEqual([true, true, true, false, false]);
	}, 549);

	it("offers Hide upcoming when only a section is ordered, and hides just its locked steps", async () => {
		const { open } = await session();
		const plain = await open(linkFor(groceries));
		expect(await plain.locator("#toggle-upcoming").isHidden()).toBe(true);

		const page = await open(
			linkFor({ sections: [{ title: "A", tasks: ["a", "b"] }, { title: "B", ordered: true, tasks: ["c", "d", "e"] }] }),
		);
		expect(await page.locator("#toggle-upcoming").isVisible()).toBe(true);
		await page.locator("#toggle-upcoming").click();
		expect(await page.locator("#list .task:not([hidden]) .text").allTextContents()).toEqual(["a", "b", "c"]);
		expect(await page.locator("#upcoming-hidden").textContent()).toBe("2 upcoming tasks hidden · Show");
	}, 408);

	it("keeps a list without headings ordered when shared", async () => {
		const first = await session();
		for (const list of [{ ordered: true, tasks: ["a", "b", "c"] }, { sections: [{ ordered: true, tasks: ["a", "b", "c"] }] }]) {
			const page = await first.open(linkFor(list));
			await toggle(page, 0);
			await page.locator("#share").click();
			await page.locator("#share.flash").waitFor();
			const shared = await page.evaluate(() => navigator.clipboard.readText());

			const other = await (await session()).open(shared);
			await other.waitForURL(ID_URL);
			expect(await other.locator("#list .step").count()).toBe(3);
			expect(await checks(other)).toEqual([true, false, false]);
			expect(await Promise.all([1, 2].map((i) => input(other, i).isDisabled()))).toEqual([false, true]);
		}
	}, 932);
});

describe("reordering", () => {
	it("moves a task with the arrow keys, and its check mark with it", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		await toggle(page, 0);
		await page.locator(".handle").nth(0).focus();
		await page.keyboard.press("ArrowDown");
		expect(await texts(page)).toEqual(["Eggs", "Milk", "Bread"]);
		expect(await checks(page)).toEqual([false, true, false]);
	}, 236);

	it("skips tasks that are hidden, so a key press always moves something you can see", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		await toggle(page, 1);
		await page.locator("#toggle-done").click(); // hides Eggs
		await page.locator(".handle").nth(2).focus();
		await page.keyboard.press("ArrowUp");
		expect(await texts(page)).toEqual(["Bread", "Milk", "Eggs"]);
		expect(await checks(page)).toEqual([false, false, true]);
	}, 273);
});

describe("share links", () => {
	it("carries the current order and check marks to another browser", async () => {
		const first = await session();
		const page = await first.open(linkFor(groceries));
		await toggle(page, 2);
		await page.locator(".handle").nth(2).focus();
		await page.keyboard.press("ArrowUp");
		await page.locator("#share").click();
		await page.locator("#share.flash").waitFor(); // building the link is asynchronous
		const shared = await page.evaluate(() => navigator.clipboard.readText());
		expect(shared).toMatch(new RegExp(`^${ORIGIN}/l/#v1\\.`));

		const second = await session();
		const other = await second.open(shared);
		await other.waitForURL(ID_URL);
		expect(await texts(other)).toEqual(["Milk", "Bread", "Eggs"]);
		expect(await checks(other)).toEqual([false, true, false]);
	}, 467);
});

describe("link check marks", () => {
	const withMark = { ...groceries, tasks: [{ text: "Milk", done: true }, "Eggs", "Bread"] };

	it("offers a link's check marks without applying them", async () => {
		const { open } = await session();
		const first = await open(linkFor(groceries));
		await first.waitForURL(ID_URL);
		const second = await open(linkFor(withMark));
		await second.waitForURL(ID_URL);
		expect(await second.locator("#notice").textContent()).toContain("check marks your saved copy doesn't");
		expect(await checks(second)).toEqual([false, false, false]);
		await second.locator("#notice button").click();
		expect(await checks(second)).toEqual([true, false, false]);
		expect(await second.locator("#notice").isHidden()).toBe(true);
	}, 326);

	it("adds a link's check marks to the saved ones instead of replacing them", async () => {
		const { open } = await session();
		const first = await open(linkFor(groceries));
		await first.waitForURL(ID_URL);
		await toggle(first, 1);
		const second = await open(linkFor(withMark));
		await second.waitForURL(ID_URL);
		await second.locator("#notice button").click();
		expect(await checks(second)).toEqual([true, true, false]);
	}, 458);

	it("drops the offer when another link is pasted into the same tab", async () => {
		const { open } = await session();
		const first = await open(linkFor(groceries));
		await first.waitForURL(ID_URL);
		const page = await open(linkFor(withMark));
		await page.waitForURL(ID_URL);
		await page.locator("#notice button").waitFor();

		const other = new URL(linkFor({ title: "Other", tasks: ["Only"] }));
		await page.evaluate((hash) => (location.hash = hash), other.hash);
		await expect.poll(() => page.locator("#title").textContent()).toBe("Other");
		expect(await page.locator("#notice").isHidden()).toBe(true);
		expect(await page.locator("#notice button").count()).toBe(0);
	}, 284);
});

describe("links with an id", () => {
	it("is what a share link carries, so it names the list it came from", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		await page.waitForURL(ID_URL);
		expect(decodeLink(await shareLink(page)).id).toBe(page.url().split("/").pop());
	}, 240);

	it("opens the same list when an agent has edited it, and takes the edit only when asked", async () => {
		const { open } = await session();
		const first = await open(linkFor(groceries));
		await first.waitForURL(ID_URL);
		const shared = decodeLink(await shareLink(first));
		await toggle(first, 1); // checked after the link was shared

		// The agent marked Milk done and reworded the last task.
		const edited = { ...shared, tasks: [{ text: "Milk", done: true }, "Eggs", "Rye bread"] };
		const second = await open(linkFor(edited));
		await second.waitForURL(ID_URL);
		expect(second.url()).toBe(first.url());
		expect(await second.locator("#notice").textContent()).toContain("different version");
		expect(await texts(second)).toEqual(["Milk", "Eggs", "Bread"]);
		expect(await checks(second)).toEqual([false, true, false]);

		await second.locator("#notice button").click();
		expect(await texts(second)).toEqual(["Milk", "Eggs", "Rye bread"]);
		expect(await checks(second)).toEqual([true, true, false]); // Eggs is still checked
		expect(await second.locator("#notice").isHidden()).toBe(true);

		await second.locator("#toast-undo").click();
		expect(await texts(second)).toEqual(["Milk", "Eggs", "Bread"]);
		expect(await checks(second)).toEqual([false, true, false]);
	}, 549);

	it("only offers check marks when the tasks are the same, whatever order they are in", async () => {
		const { open } = await session();
		const first = await open(linkFor(groceries));
		await first.waitForURL(ID_URL);
		await first.locator(".handle").nth(0).focus();
		await first.keyboard.press("ArrowDown");
		expect(await texts(first)).toEqual(["Eggs", "Milk", "Bread"]);

		const id = first.url().split("/").pop();
		const second = await open(linkFor({ ...groceries, id, tasks: [{ text: "Milk", done: true }, "Eggs", "Bread"] }));
		await second.waitForURL(ID_URL);
		expect(second.url()).toBe(first.url());
		expect(await second.locator("#notice").textContent()).toContain("check marks your saved copy doesn't");
		await second.locator("#notice button").click();
		expect(await texts(second)).toEqual(["Eggs", "Milk", "Bread"]); // still in the saved order
		expect(await checks(second)).toEqual([false, true, false]);
	}, 434);

	it("opens a reordered share link as the same list, with nothing to offer", async () => {
		const { open } = await session();
		const first = await open(linkFor(groceries));
		await first.waitForURL(ID_URL);
		await first.locator(".handle").nth(0).focus();
		await first.keyboard.press("ArrowDown");
		const second = await open(await shareLink(first));
		await second.waitForURL(ID_URL);
		expect(second.url()).toBe(first.url());
		expect(await second.locator("#notice").isHidden()).toBe(true);
	}, 380);

	it("opens a list this browser doesn't have under the link's id", async () => {
		const { open } = await session();
		const page = await open(linkFor({ ...groceries, id: "AAAAAAAAAAAA" }));
		await page.waitForURL(`${ORIGIN}/l/AAAAAAAAAAAA`);
		expect(await texts(page)).toEqual(["Milk", "Eggs", "Bread"]);
		expect(await page.locator("#notice").isHidden()).toBe(true);
	}, 177);

	it("ignores an id that isn't one", async () => {
		const { open } = await session();
		const plain = await open(linkFor(groceries));
		await plain.waitForURL(ID_URL);
		for (const id of ["short", "AAAAAAAAAAAA/", 5]) {
			const page = await open(linkFor({ ...groceries, id }));
			await page.waitForURL(ID_URL);
			expect(page.url()).toBe(plain.url());
		}
	}, 431);
});

describe("plain links", () => {
	it("open like a compressed link, as the same list", async () => {
		const { open } = await session();
		const plain = await open(plainLinkFor(groceries));
		await plain.waitForURL(ID_URL);
		expect(await texts(plain)).toEqual(["Milk", "Eggs", "Bread"]);
		const compressed = await open(linkFor(groceries));
		await compressed.waitForURL(ID_URL);
		expect(compressed.url()).toBe(plain.url());
	}, 237);

	it("take a hand-written % literally, and carry an id and done tasks", async () => {
		const { open } = await session();
		const page = await open(`${ORIGIN}/l/#json={"id":"AAAAAAAAAAAA","title":"Sale","tasks":[{"text":"50% off","done":true},"Pay"]}`);
		await page.waitForURL(`${ORIGIN}/l/AAAAAAAAAAAA`);
		expect(await texts(page)).toEqual(["50% off", "Pay"]);
		expect(await checks(page)).toEqual([true, false]);
	}, 150);

	it("say so when the JSON is broken", async () => {
		const { open } = await session();
		const page = await open(`${ORIGIN}/l/#json=%7B%22tasks%22%3A`);
		expect(await page.locator("#message-title").textContent()).toBe("This link is damaged");
	}, 144);
});

describe("the note for agents in copied Markdown", () => {
	it("says how to answer, names the list, and ends with a share link that opens it", async () => {
		const first = await session();
		const page = await first.open(linkFor(groceries));
		await page.waitForURL(ID_URL);
		await toggle(page, 0);
		const id = page.url().split("/").pop();
		await page.locator("#copy").click();
		await page.locator("#copy.flash").waitFor();
		const copied = await page.evaluate(() => navigator.clipboard.readText());

		expect(listMarkdown(copied)).toBe("# Groceries\n\n- [x] Milk\n- [ ] Eggs\n- [ ] Bread\n");
		const footer = copied.split("\n\n---\n")[1];
		expect(footer).toContain("reply with an updated link");
		expect(footer).toContain(`"id": "${id}"`);
		expect(footer).toContain(`${ORIGIN}/l/#json=`);
		expect(footer).toContain(`${ORIGIN}/\n`);

		// The last line is the exact list, so a code-running agent can edit it and hand it back.
		const link = copied.trimEnd().split("\n").pop()!;
		expect(decodeLink(link)).toMatchObject({ id, tasks: [{ text: "Milk", done: true }, "Eggs", "Bread"] });
		const other = await (await session()).open(link);
		await other.waitForURL(ID_URL);
		expect(await checks(other)).toEqual([true, false, false]);
	}, 422);
});

describe("the index at /l/", () => {
	it("lists saved lists with their progress, and deletes them", async () => {
		const { open } = await session();
		const a = await open(linkFor(groceries));
		await a.waitForURL(ID_URL);
		await toggle(a, 0);
		const b = await open(linkFor(steps));
		await b.waitForURL(ID_URL);

		const index = await open(`${ORIGIN}/l/`);
		const rows = index.locator("#index-list li");
		await rows.first().waitFor();
		expect(await rows.count()).toBe(2);
		expect(await index.locator("#index-list").textContent()).toContain("1 of 3 done");
		expect(await index.locator("#index-list a").allTextContents()).toEqual(expect.arrayContaining(["Groceries", "Steps"]));

		const remove = (name: string) => rows.filter({ hasText: name }).locator("button");
		await remove("Groceries").click();
		expect(await rows.count()).toBe(2); // the first click only arms the button
		await remove("Groceries").click();
		await expect.poll(() => rows.count()).toBe(1);
		await remove("Steps").click();
		await remove("Steps").click();
		await index.locator("#message-title").filter({ hasText: "No lists saved" }).waitFor();
		await index.locator("#toast-undo").click(); // brings the last one back
		await expect.poll(() => rows.count()).toBe(1);
	}, 753);

	it("says there's no list when nothing is saved", async () => {
		const { open } = await session();
		const page = await open(`${ORIGIN}/l/`);
		expect(await page.locator("#message-title").textContent()).toBe("No list here");
	}, 141);
});

describe("other tabs", () => {
	it("follows check marks made in another tab of the same list", async () => {
		const { open } = await session();
		const first = await open(linkFor(groceries));
		await first.waitForURL(ID_URL);
		const second = await open(first.url());
		await toggle(first, 0);
		await expect.poll(() => input(second, 0).isChecked()).toBe(true);
	}, 320);
});

describe("destructive buttons", () => {
	const armedOf = (page: Page, selector: string) => page.locator(selector).evaluate((button) => button.classList.contains("armed"));

	it("uncheck all needs a second click, then can be undone", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		await toggle(page, 0);
		await toggle(page, 2);

		await page.locator("#reset").click();
		expect(await armedOf(page, "#reset")).toBe(true);
		expect(await page.locator("#reset").getAttribute("aria-label")).toBe("Click again to uncheck all");
		expect(await checks(page)).toEqual([true, false, true]);

		await page.locator("#reset").click();
		expect(await checks(page)).toEqual([false, false, false]);
		expect(await armedOf(page, "#reset")).toBe(false);
		expect(await page.locator("#reset").getAttribute("aria-label")).toBe("Uncheck all");
		expect(await page.locator("#toast-text").textContent()).toBe("Unchecked 2 tasks");

		await page.locator("#toast-undo").click();
		expect(await checks(page)).toEqual([true, false, true]);
		expect(await page.locator("#progress-text").textContent()).toBe("2 of 3 done");
	}, 440);

	it("uncheck all does nothing when nothing is checked", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		await page.locator("#reset").click();
		expect(await armedOf(page, "#reset")).toBe(false);
	}, 224);

	it("disarms without acting on Escape, a click elsewhere, and a timeout", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		await toggle(page, 0);

		await page.locator("#reset").click();
		await page.keyboard.press("Escape");
		expect(await armedOf(page, "#reset")).toBe(false);

		await page.locator("#reset").click();
		await page.locator("#title").click();
		expect(await armedOf(page, "#reset")).toBe(false);

		await page.locator("#reset").click();
		await expect.poll(() => armedOf(page, "#reset"), { timeout: 6000 }).toBe(false);

		expect(await checks(page)).toEqual([true, false, false]);
		expect(await page.locator("#toast").isHidden()).toBe(true);
	}, 6480);

	it("arms one button at a time", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		await toggle(page, 0);
		await page.locator("#reset").click();
		await page.locator("#delete").click();
		expect(await armedOf(page, "#reset")).toBe(false);
		expect(await armedOf(page, "#delete")).toBe(true);
	}, 329);

	it("delete needs a second click, then can be restored", async () => {
		const { open } = await session();
		const first = await open(linkFor(groceries));
		await first.waitForURL(ID_URL);
		await toggle(first, 1);

		await first.locator("#delete").click();
		expect(await first.locator("#message").isHidden()).toBe(true);
		await first.locator("#delete").click();
		expect(await first.locator("#message-title").textContent()).toBe("List deleted");

		const other = await open(first.url());
		expect(await other.locator("#message-title").textContent()).toBe("This list isn't saved in this browser");

		await first.locator("#message-action").click();
		expect(await first.locator("#title").textContent()).toBe("Groceries");
		expect(await checks(first)).toEqual([false, true, false]);
		const again = await open(first.url());
		expect(await checks(again)).toEqual([false, true, false]);
	}, 624);

	it("restores a deleted list from the toast too, with the keyboard", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		await page.waitForURL(ID_URL);
		await page.locator("#delete").click();
		await page.locator("#delete").click();
		await page.keyboard.press("ControlOrMeta+Z");
		expect(await page.locator("#title").textContent()).toBe("Groceries");
		expect(await page.locator("#toast").isHidden()).toBe(true);
	}, 246);

	it("drops an undo when the check marks have changed since", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		await toggle(page, 0);
		await page.locator("#reset").click();
		await page.locator("#reset").click();
		await toggle(page, 1);
		expect(await page.locator("#toast").isHidden()).toBe(true);
	}, 345);

	it("drops an undo when another list is opened in the tab", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		await toggle(page, 0);
		await page.locator("#reset").click();
		await page.locator("#reset").click();
		await page.evaluate((hash) => (location.hash = hash), new URL(linkFor({ title: "Other", tasks: ["Only"] })).hash);
		await expect.poll(() => page.locator("#title").textContent()).toBe("Other");
		expect(await page.locator("#toast").isHidden()).toBe(true);
	}, 336);
});

describe("more on the destructive buttons", () => {
	const isArmed = (page: Page, selector: string) => page.locator(selector).evaluate((button) => button.classList.contains("armed"));

	it("tabbing away disarms a button without acting", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		await toggle(page, 0);
		await page.locator("#reset").click();
		expect(await isArmed(page, "#reset")).toBe(true);
		await page.keyboard.press("Tab");
		expect(await isArmed(page, "#reset")).toBe(false);
		expect(await checks(page)).toEqual([true, false, false]);
		expect(await page.locator("#toast").isHidden()).toBe(true);
	}, 293);

	it("undoes uncheck all with Ctrl/Cmd+Z, and Escape dismisses the offer", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		await toggle(page, 0);
		await toggle(page, 1);
		await page.locator("#reset").click();
		await page.locator("#reset").click();
		await page.keyboard.press("ControlOrMeta+Z");
		expect(await checks(page)).toEqual([true, true, false]);

		await page.locator("#reset").click();
		await page.locator("#reset").click();
		expect(await page.locator("#toast").isVisible()).toBe(true);
		await page.keyboard.press("Escape");
		expect(await page.locator("#toast").isHidden()).toBe(true);
		await page.keyboard.press("ControlOrMeta+Z"); // nothing left to undo
		expect(await checks(page)).toEqual([false, false, false]);
	}, 465);

	it.each([
		["light", "rgb(176, 60, 46)"],
		["dark", "rgb(240, 144, 127)"],
	] as const)("shows the armed button in the %s danger colour", async (colorScheme, color) => {
		const { open } = await session({ colorScheme });
		const page = await open(linkFor(groceries));
		await toggle(page, 0);
		await page.locator("#delete").click();
		await expect.poll(() => page.locator("#delete").evaluate((button) => getComputedStyle(button).color)).toBe(color);
		expect(await page.locator("#delete .when-armed").isVisible()).toBe(true);
		expect(await page.locator("#delete .when-idle").isVisible()).toBe(false);
	}, 278);
});

describe("pages with no list", () => {
	it("can be clicked anywhere without an error", async () => {
		const { open } = await session();
		const empty = await open(`${ORIGIN}/l/`);
		await empty.locator("#message-title").click();
		await empty.locator("body").click({ position: { x: 5, y: 5 } });
		expect(await empty.locator("#message-title").textContent()).toBe("No list here");

		const unsaved = await open(`${ORIGIN}/l/abcDEF123_-x`);
		await unsaved.locator("#message-title").click();
		expect(await unsaved.locator("#message-title").textContent()).toBe("This list isn't saved in this browser");

		const other = await open(linkFor(groceries));
		await other.waitForURL(ID_URL);
		const index = await open(`${ORIGIN}/l/`);
		await index.locator("#index-list li").first().waitFor();
		await index.locator("#index h1").click();
		await index.locator("body").click({ position: { x: 5, y: 5 } });
	}, 773);
});

describe("section descriptions", () => {
	const described = {
		title: "Release",
		sections: [
			{ title: "Prepare", description: "Before the window opens.\nSee https://example.com/runbook.", tasks: ["Review", { text: "Bump", details: "Edit `package.json`." }] },
			{ title: "Ship", tasks: ["Publish"] },
		],
	};

	it("shows the description under its heading, with links, and folds it with the section", async () => {
		const { open } = await session();
		const page = await open(linkFor(described));
		await page.waitForURL(ID_URL);
		const description = page.locator("#list .group-description");
		expect(await description.count()).toBe(1);
		expect(await description.textContent()).toBe("Before the window opens.\nSee https://example.com/runbook.");
		expect(await description.locator("a").getAttribute("href")).toBe("https://example.com/runbook");
		await page.locator("#list .collapse").first().click();
		await description.waitFor({ state: "hidden" });
	}, 198);

	it("isn't hidden by Hide details", async () => {
		const { open } = await session();
		const page = await open(linkFor(described));
		await page.locator("#toggle-details").click({ force: true });
		expect(await page.locator("#list").evaluate((list) => list.classList.contains("hide-details"))).toBe(true);
		expect(await page.locator("#list .group-description").isVisible()).toBe(true);
	}, 182);

	it("is carried into the Markdown and the share link", async () => {
		const { open } = await session();
		const page = await open(linkFor(described));
		await page.locator("#copy").click();
		await page.locator("#copy.flash").waitFor();
		const markdown = listMarkdown(await page.evaluate(() => navigator.clipboard.readText()));
		expect(markdown).toBe(
			[
				"# Release",
				"",
				"## Prepare",
				"",
				"Before the window opens.",
				"See https://example.com/runbook.",
				"",
				"- [ ] Review",
				"- [ ] Bump",
				"  Edit `package.json`.",
				"",
				"## Ship",
				"",
				"- [ ] Publish",
			].join("\n") + "\n",
		);
		const shared = decodeLink(await shareLink(page));
		expect(shared.sections[0].description).toBe("Before the window opens.\nSee https://example.com/runbook.");
		expect(shared.sections[1]).not.toHaveProperty("description");
	}, 327);

	it("counts as a different version when an agent edits only a section description", async () => {
		const { open } = await session();
		const first = await open(linkFor(described));
		await first.waitForURL(ID_URL);
		const shared = decodeLink(await shareLink(first));
		shared.sections[0].description = "Changed.";
		const second = await open(linkFor(shared));
		await second.waitForURL(ID_URL);
		expect(second.url()).toBe(first.url());
		expect(await second.locator("#notice").textContent()).toContain("different version");
		await second.locator("#notice button").click();
		expect(await second.locator("#list .group-description").textContent()).toBe("Changed.");
	}, 428);

	it("leaves the id of a list without section descriptions as it was", async () => {
		const { open } = await session();
		const list = { title: "Plain", sections: [{ title: "A", tasks: ["a"] }] };
		const page = await open(linkFor(list));
		await page.waitForURL(ID_URL);
		const other = await open(linkFor({ ...list, sections: [{ title: "A", description: "  ", tasks: ["a"] }] }));
		await other.waitForURL(ID_URL);
		expect(other.url()).toBe(page.url());
	}, 210);
});

describe("copying as Markdown", () => {
	it("copies the list as it is now", async () => {
		const { open } = await session();
		const page = await open(
			linkFor({
				title: "Trip",
				description: "Plan",
				sections: [{ title: "Pack", tasks: ["Passport", { text: "Charger", details: "USB-C", done: true }, { text: "Email Dana", copy: "dana@example.com" }] }],
			}),
		);
		await page.locator("#copy").click();
		await page.locator("#copy.flash").waitFor();
		const copied = await page.evaluate(() => navigator.clipboard.readText());
		const markdown = listMarkdown(copied);
		expect(markdown).toBe(
			["# Trip", "", "Plan", "", "## Pack", "", "- [ ] Passport", "- [x] Charger", "  USB-C", "- [ ] Email Dana", "  `dana@example.com`"].join("\n") + "\n",
		);
	}, 249);

	it("lists several copy values, with their labels", async () => {
		const { open } = await session();
		const page = await open(
			linkFor({
				title: "DNS",
				tasks: [{ text: "Add the record", copy: [{ label: "Name", value: "_acme" }, "abc123"] }],
			}),
		);
		await page.locator("#copy").click();
		await page.locator("#copy.flash").waitFor();
		const copied = await page.evaluate(() => navigator.clipboard.readText());
		const markdown = listMarkdown(copied);
		expect(markdown).toBe(["# DNS", "", "- [ ] Add the record", "  Name: `_acme`", "  `abc123`"].join("\n") + "\n");
	}, 225);

	it("numbers the steps of an ordered list", async () => {
		const { open } = await session();
		const page = await open(linkFor(steps));
		await toggle(page, 0);
		await page.locator("#copy").click();
		await page.locator("#copy.flash").waitFor();
		const copied = await page.evaluate(() => navigator.clipboard.readText());
		const markdown = listMarkdown(copied);
		expect(markdown).toBe(["# Steps", "", "1. [x] One", "2. [ ] Two", "3. [ ] Three"].join("\n") + "\n");
	}, 273);
});

describe("several copy values", () => {
	const list = { tasks: [{ text: "Add the record", copy: [{ label: "Name", value: "_acme" }, "abc123"] }] };

	it("gives each value its own row and button, and copies that value", async () => {
		const { open } = await session();
		const page = await open(linkFor(list));
		expect(await page.locator(".copy").count()).toBe(2);
		expect(await page.locator(".copy-label").allTextContents()).toEqual(["Name"]);
		expect(await page.locator(".copy-value").allTextContents()).toEqual(["_acme", "abc123"]);
		await page.locator(".copy").nth(1).hover();
		const button = page.locator(".copy button").nth(1);
		expect(await button.getAttribute("aria-label")).toBe("Copy value");
		expect(await page.locator(".copy button").first().getAttribute("aria-label")).toBe("Copy Name");
		await button.click();
		await button.evaluate((el) => el.classList.contains("flash") || new Promise((r) => setTimeout(r, 50)));
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("abc123");
	}, 371);

	it("keeps the saved list when a single value is written as an array", async () => {
		const { open } = await session();
		const first = await open(linkFor({ tasks: [{ text: "A", copy: "x" }] }));
		await first.waitForURL(ID_URL);
		const id = first.url();
		const second = await open(linkFor({ tasks: [{ text: "A", copy: ["x"] }] }));
		await second.waitForURL(ID_URL);
		expect(second.url()).toBe(id);
	}, 203);
});

describe("collapsing sections", () => {
	const sectioned = {
		sections: [
			{ title: "Alpha", tasks: ["A1", "A2", "A3"] },
			{ title: "Beta", tasks: ["B1", "B2"] },
			{ title: "Gamma", tasks: ["G1"] },
		],
	};
	const chevron = (page: Page, index: number) => page.locator("#list .collapse").nth(index);
	const expanded = (page: Page) => page.locator("#list .collapse").evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-expanded")));
	const alt = (page: Page, index: number) => page.locator("#list .check").nth(index).click({ modifiers: ["Alt"] });

	it("folds a section with its chevron, and remembers it across a reload", async () => {
		const { open } = await session();
		const page = await open(linkFor(sectioned));
		await page.waitForURL(ID_URL);
		expect(await expanded(page)).toEqual(["true", "true", "true"]);
		await chevron(page, 1).click();
		expect(await expanded(page)).toEqual(["true", "false", "true"]);
		expect(await chevron(page, 1).getAttribute("aria-label")).toBe("Expand section");
		await page.locator("#section-1-tasks").waitFor({ state: "hidden" });
		await page.reload();
		await page.locator("#list .collapse").first().waitFor();
		expect(await expanded(page)).toEqual(["true", "false", "true"]);
		await chevron(page, 1).click();
		expect(await expanded(page)).toEqual(["true", "true", "true"]);
	}, 344);

	it("folds or opens every section with Alt", async () => {
		const { open } = await session();
		const page = await open(linkFor(sectioned));
		await chevron(page, 0).click({ modifiers: ["Alt"] });
		expect(await expanded(page)).toEqual(["false", "false", "false"]);
		await chevron(page, 2).click({ modifiers: ["Alt"] });
		expect(await expanded(page)).toEqual(["true", "true", "true"]);
	}, 254);

	it("has no chevrons for a list without sections", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		expect(await page.locator("#list .collapse").count()).toBe(0);
		expect(await page.locator("#list [data-hint]").count()).toBe(0);
	}, 135);

	it("hints on the last open checkbox of a section only", async () => {
		const { open } = await session();
		const page = await open(linkFor(sectioned));
		const hints = () => page.locator("#list .check").evaluateAll((labels) => labels.map((l) => (l as HTMLElement).dataset.hint ?? ""));
		expect((await hints()).filter(Boolean)).toEqual([]);
		await toggle(page, 0);
		await toggle(page, 1);
		expect((await hints()).map(Boolean)).toEqual([false, false, true, false, false, false]);
		await toggle(page, 3);
		expect((await hints()).map(Boolean)).toEqual([false, false, true, false, true, false]);
	}, 291);

	it("folds the section when Alt checks its last open task, but not for a plain click", async () => {
		const { open } = await session();
		const page = await open(linkFor(sectioned));
		await toggle(page, 0);
		await toggle(page, 1);
		await page.locator("#list .check").nth(2).click();
		await page.waitForTimeout(500);
		expect(await expanded(page)).toEqual(["true", "true", "true"]);
		await page.locator("#list .check").nth(2).click();
		await alt(page, 2);
		await page.waitForFunction(() => document.querySelector("#list .collapse")?.getAttribute("aria-expanded") === "false");
		expect(await expanded(page)).toEqual(["false", "true", "true"]);
		expect(await checks(page)).toEqual([true, true, true, false, false, false]);
	}, 1632);

	it("keeps the folded state out of the share link and the list's id", async () => {
		const { open, context } = await session();
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		const page = await open(linkFor(sectioned));
		await page.waitForURL(ID_URL);
		const id = page.url();
		await page.locator("#share").click();
		await page.locator("#share.flash").waitFor();
		const before = await page.evaluate(() => navigator.clipboard.readText());
		await chevron(page, 0).click();
		await page.locator("#share").click();
		await page.locator("#share.flash").waitFor();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(before);
		expect(page.url()).toBe(id);
	}, 362);
});

describe("the display options", () => {
	const detailed = { tasks: [{ text: "A", details: "More about A", copy: "value-a" }, "B"] };
	const hasClass = (page: Page, name: string) => page.locator("#list").evaluate((list, cls) => list.classList.contains(cls), name);

	it("only shows the menu when there is something to hide", async () => {
		const { open } = await session();
		expect(await (await open(linkFor(groceries))).locator("#display-menu").isHidden()).toBe(true);
		expect(await (await open(linkFor(detailed))).locator("#display-menu").isVisible()).toBe(true);
	}, 288);

	it("with a mouse, one click hides details and copy values together, and again shows them", async () => {
		const { open } = await session();
		const page = await open(linkFor(detailed));
		await page.locator("#display").click();
		expect(await hasClass(page, "hide-details")).toBe(true);
		expect(await hasClass(page, "hide-copy")).toBe(true);
		expect(await page.locator("#display").getAttribute("aria-label")).toBe("Show details and copy text");
		await page.locator("#display").click();
		expect(await hasClass(page, "hide-details")).toBe(false);
		expect(await hasClass(page, "hide-copy")).toBe(false);
	}, 278);

	it("with a mouse, hovering offers each part on its own, and the choice is kept", async () => {
		const { open } = await session();
		const page = await open(linkFor(detailed));
		await page.locator("#display").hover();
		await page.locator("#toggle-details").click();
		expect(await hasClass(page, "hide-details")).toBe(true);
		expect(await hasClass(page, "hide-copy")).toBe(false);
		await page.reload();
		await page.locator("#list .task").first().waitFor();
		expect(await hasClass(page, "hide-details")).toBe(true);
	}, 408);

	it("with touch, a tap opens the options instead", async () => {
		const { open } = await session({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 800 } });
		const page = await open(linkFor(detailed));
		expect(await page.locator("#display").getAttribute("aria-haspopup")).toBe("true");
		await page.locator("#display").tap();
		expect(await page.locator("#display").getAttribute("aria-expanded")).toBe("true");
		expect(await hasClass(page, "hide-details")).toBe(false);
		await page.locator("#toggle-copy").tap();
		expect(await hasClass(page, "hide-copy")).toBe(true);
		expect(await hasClass(page, "hide-details")).toBe(false);
		await page.locator("#title").tap();
		expect(await page.locator("#display").getAttribute("aria-expanded")).toBe("false");
	}, 437);
});

describe("dragging to reorder", () => {
	it("moves a task to where it is dropped, check mark included", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		await toggle(page, 0);
		const rows = page.locator("#list .task");
		const first = (await rows.nth(0).boundingBox())!;
		const last = (await rows.nth(2).boundingBox())!;
		const handle = (await page.locator(".handle").nth(0).boundingBox())!;
		const x = handle.x + handle.width / 2;
		const y = handle.y + handle.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x, y + (last.y + last.height / 2 - (first.y + first.height / 2)) + 10, { steps: 10 });
		await page.mouse.up();
		expect(await texts(page)).toEqual(["Eggs", "Bread", "Milk"]);
		expect(await checks(page)).toEqual([false, false, true]);
	}, 483);

	it("puts a task back when the drag is cancelled", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		const rows = page.locator("#list .task");
		const first = (await rows.nth(0).boundingBox())!;
		const last = (await rows.nth(2).boundingBox())!;
		const handle = (await page.locator(".handle").nth(0).boundingBox())!;
		const x = handle.x + handle.width / 2;
		const y = handle.y + handle.height / 2;
		await page.mouse.move(x, y);
		await page.mouse.down();
		await page.mouse.move(x, y + (last.y - first.y), { steps: 5 });
		await page.locator(".handle").nth(0).dispatchEvent("pointercancel");
		expect(await texts(page)).toEqual(["Milk", "Eggs", "Bread"]);
	}, 320);

	it("has no handles in an ordered list", async () => {
		const { open } = await session();
		const page = await open(linkFor(steps));
		expect(await page.locator(".handle").count()).toBe(0);
	}, 147);
});

describe("printing", () => {
	it("prints black on white without the controls, even from dark mode", async () => {
		const { open } = await session({ colorScheme: "dark" });
		const page = await open(linkFor(groceries));
		await toggle(page, 0);
		await page.locator("#reset").click();
		await page.locator("#reset").click(); // leaves the undo toast showing
		await toggle(page, 0);
		await page.emulateMedia({ media: "print", colorScheme: "dark" });

		const style = (selector: string, property: string) =>
			page.locator(selector).first().evaluate((node, prop) => getComputedStyle(node).getPropertyValue(prop), property);
		expect(await style("body", "background-color")).toBe("rgb(255, 255, 255)");
		expect(await style("#list .task:not(.done) .text", "color")).toBe("rgb(0, 0, 0)"); // a done task is muted, still dark enough
		for (const hidden of [".actions", ".progress-track", ".handle", "footer", "#toast"]) {
			expect(await style(hidden, "display"), hidden).toBe("none");
		}
		expect(await style(".bar", "position")).toBe("static");
		// The box eases between colours, so let the switch to print settle.
		await expect.poll(() => style("#list .task .box", "background-color")).toBe("rgba(0, 0, 0, 0)");
		await expect.poll(() => style("#list .task .box", "border-top-color")).toBe("rgb(0, 0, 0)");
		expect(await texts(page)).toEqual(["Milk", "Eggs", "Bread"]);
	}, 452);
});

describe("a phone-sized screen", () => {
	it("fits the toolbar, a long list and the toast with no sideways scrolling", async () => {
		const { open } = await session({ viewport: { width: 360, height: 640 } });
		const page = await open(
			linkFor({
				title: "A fairly long title for a list that someone made on their phone",
				description: "See https://example.com/a/very/long/address/that/keeps/going/and/going/and/going/on",
				sections: [
					{
						title: "A section with a rather long heading",
						tasks: [
							{ text: "Email Dana the invoice and the very long reference number", details: "Some details that wrap over a few lines on a narrow screen.", copy: "dana.the.accountant@a-long-example-domain.example.com" },
							"Short",
						],
					},
				],
			}),
		);
		await toggle(page, 0);
		await page.locator("#reset").click();
		await page.locator("#reset").click(); // shows the toast

		const fits = () =>
			page.evaluate(() => ({
				scrolls: document.documentElement.scrollWidth > document.documentElement.clientWidth,
				outside: [...document.querySelectorAll<HTMLElement>(".actions button:not([hidden]), #toast, #toast button")]
					.filter((node) => node.offsetParent !== null || node.id === "toast")
					.map((node) => node.getBoundingClientRect())
					.filter((rect) => rect.width > 0 && (rect.left < 0 || rect.right > innerWidth))
					.length,
			}));
		expect(await fits()).toEqual({ scrolls: false, outside: 0 });

		await page.locator("#delete").click(); // armed
		expect(await fits()).toEqual({ scrolls: false, outside: 0 });
	}, 347);

	it("keeps the index readable too", async () => {
		const { open } = await session({ viewport: { width: 360, height: 640 } });
		const page = await open(linkFor({ title: "A very long list title that has to wrap somewhere on a small screen", tasks: ["One"] }));
		await page.waitForURL(ID_URL);
		const index = await open(`${ORIGIN}/l/`);
		await index.locator("#index-list li").first().waitFor();
		expect(await index.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
		const row = (await index.locator("#index-list li").first().boundingBox())!;
		const del = (await index.locator("#index-list li button").first().boundingBox())!;
		expect(del.x + del.width).toBeLessThanOrEqual(row.x + row.width);
	}, 299);
});

// Everything above runs with animations off. These are the only tests that need
// them on, and only for behaviour that depends on them: the pop a check mark plays,
// and a folded section that must stay unreachable once its transition has finished.
describe("with motion", () => {
	const motion = { reducedMotion: "no-preference" } as const;
	const playing = (page: Page, name: string) =>
		page.locator("#list .box").first().evaluate((box, name) => box.getAnimations().some((a) => (a as CSSAnimation).animationName === name), name);

	it("pops a box when it is checked, and not at all with reduced motion", async () => {
		const { open } = await session(motion);
		const page = await open(linkFor(groceries));
		await page.waitForURL(ID_URL);
		expect(await playing(page, "pop")).toBe(false);
		await toggle(page, 0);
		expect(await playing(page, "pop")).toBe(true);

		const still = await (await session()).open(linkFor(groceries));
		await still.waitForURL(ID_URL);
		await toggle(still, 0);
		expect(await playing(still, "pop")).toBe(false);
	}, 471);

	it("keeps a folded section out of reach once it has finished folding, and brings it back", async () => {
		const { open } = await session(motion);
		const page = await open(linkFor({ sections: [{ title: "Alpha", tasks: ["A1", "A2"] }, { title: "Beta", tasks: ["B1"] }] }));
		await page.waitForURL(ID_URL);
		await page.locator("#list .collapse").first().click();
		await page.locator("#section-0-tasks").waitFor({ state: "hidden" });
		await page.locator("#list .collapse").first().focus();
		await page.keyboard.press("Tab");
		expect(await page.evaluate(() => document.activeElement?.closest("#section-0-tasks") === null)).toBe(true);

		await page.locator("#list .collapse").first().click();
		await page.locator("#section-0-tasks").waitFor({ state: "visible" });
		expect(await texts(page)).toEqual(["A1", "A2", "B1"]);
	}, 863);
});
