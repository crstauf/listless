import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { ID_URL, ORIGIN, linkFor, useBrowser } from "./helpers.ts";

const session = useBrowser();

const input = (page: Page, index: number) => page.locator("#list input[type=checkbox]").nth(index);
const toggle = (page: Page, index: number) => page.locator("#list .task .box").nth(index).click();
const texts = (page: Page) => page.locator("#list .text").allTextContents();
const checks = (page: Page) => page.locator("#list input[type=checkbox]").evaluateAll((boxes) => boxes.map((box) => (box as HTMLInputElement).checked));

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
	});

	it("finds the same list, and its check marks, when the link is opened again", async () => {
		const { open } = await session();
		const first = await open(linkFor(groceries));
		await first.waitForURL(ID_URL);
		await toggle(first, 1);
		const second = await open(linkFor(groceries));
		await second.waitForURL(ID_URL);
		expect(second.url()).toBe(first.url());
		expect(await checks(second)).toEqual([false, true, false]);
	});

	it("says so when the link is damaged", async () => {
		const { open } = await session();
		const page = await open(`${ORIGIN}/l/#v1.not-a-list!`);
		expect(await page.locator("#message-title").textContent()).toBe("This link is damaged");
	});

	it("starts done tasks checked, and drops a gap in an ordered list", async () => {
		const { open } = await session();
		const plain = await open(linkFor({ tasks: ["A", { text: "B", done: true }, "C"] }));
		expect(await checks(plain)).toEqual([false, true, false]);
		const ordered = await open(linkFor({ ordered: true, tasks: ["A", { text: "B", done: true }] }));
		expect(await checks(ordered)).toEqual([false, false]);
	});
});

describe("ordered lists", () => {
	it("locks later steps until the one before is checked", async () => {
		const { open } = await session();
		const page = await open(linkFor(steps));
		expect(await Promise.all([0, 1, 2].map((i) => input(page, i).isDisabled()))).toEqual([false, true, true]);
		await toggle(page, 0);
		expect(await Promise.all([0, 1, 2].map((i) => input(page, i).isDisabled()))).toEqual([false, false, true]);
	});

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
	});

	it("unchecks the last step without asking", async () => {
		const { open } = await session();
		const page = await open(linkFor(steps));
		await toggle(page, 0);
		await toggle(page, 0);
		expect(await checks(page)).toEqual([false, false, false]);
	});
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
	});

	it("only gives handles to sections that aren't ordered", async () => {
		const { open } = await session();
		const page = await open(linkFor(setup));
		expect(await page.locator("#list .handle").count()).toBe(2);
	});

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
	});

	it("leaves the tasks of an unordered list's sections free when only the list is ordered", async () => {
		const { open } = await session();
		const page = await open(linkFor({ ordered: true, sections: [{ title: "A", tasks: ["a", "b"] }, { title: "B", tasks: ["c"] }] }));
		expect(await Promise.all([0, 1, 2].map((i) => input(page, i).isDisabled()))).toEqual([false, false, true]);
		await toggle(page, 1);
		await toggle(page, 0);
		expect(await checks(page)).toEqual([true, true, false]);
	});

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
	});

	it("carries section ordering into the Markdown and the share link", async () => {
		const { open } = await session();
		const page = await open(linkFor(setup));
		await page.locator("#copy").click();
		await page.locator("#copy.flash").waitFor();
		const markdown = await page.evaluate(() => navigator.clipboard.readText());
		expect(markdown).toBe("# Setup\n\n## Gather\n\n- [ ] Key\n- [ ] Token\n\n## Install\n\n1. [ ] Clone\n2. [ ] Build\n3. [ ] Test\n");

		await page.locator("#share").click();
		await page.locator("#share.flash").waitFor();
		const shared = await page.evaluate(() => navigator.clipboard.readText());
		const other = await (await session()).open(shared);
		await other.waitForURL(ID_URL);
		expect(await other.locator("#list .step").count()).toBe(3);
	});

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
	});

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
	});

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
	});

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
	});
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
	});
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
	});
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
	});

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
	});
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
	});

	it("says there's no list when nothing is saved", async () => {
		const { open } = await session();
		const page = await open(`${ORIGIN}/l/`);
		expect(await page.locator("#message-title").textContent()).toBe("No list here");
	});
});

describe("other tabs", () => {
	it("follows check marks made in another tab of the same list", async () => {
		const { open } = await session();
		const first = await open(linkFor(groceries));
		await first.waitForURL(ID_URL);
		const second = await open(first.url());
		await toggle(first, 0);
		await expect.poll(() => input(second, 0).isChecked()).toBe(true);
	});
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
	});

	it("uncheck all does nothing when nothing is checked", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		await page.locator("#reset").click();
		expect(await armedOf(page, "#reset")).toBe(false);
	});

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
	});

	it("arms one button at a time", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		await toggle(page, 0);
		await page.locator("#reset").click();
		await page.locator("#delete").click();
		expect(await armedOf(page, "#reset")).toBe(false);
		expect(await armedOf(page, "#delete")).toBe(true);
	});

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
	});

	it("restores a deleted list from the toast too, with the keyboard", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		await page.waitForURL(ID_URL);
		await page.locator("#delete").click();
		await page.locator("#delete").click();
		await page.keyboard.press("ControlOrMeta+Z");
		expect(await page.locator("#title").textContent()).toBe("Groceries");
		expect(await page.locator("#toast").isHidden()).toBe(true);
	});

	it("drops an undo when the check marks have changed since", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		await toggle(page, 0);
		await page.locator("#reset").click();
		await page.locator("#reset").click();
		await toggle(page, 1);
		expect(await page.locator("#toast").isHidden()).toBe(true);
	});

	it("drops an undo when another list is opened in the tab", async () => {
		const { open } = await session();
		const page = await open(linkFor(groceries));
		await toggle(page, 0);
		await page.locator("#reset").click();
		await page.locator("#reset").click();
		await page.evaluate((hash) => (location.hash = hash), new URL(linkFor({ title: "Other", tasks: ["Only"] })).hash);
		await expect.poll(() => page.locator("#title").textContent()).toBe("Other");
		expect(await page.locator("#toast").isHidden()).toBe(true);
	});
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
	});

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
	});

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
	});
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
	});
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
		const markdown = await page.evaluate(() => navigator.clipboard.readText());
		expect(markdown).toBe(
			["# Trip", "", "Plan", "", "## Pack", "", "- [ ] Passport", "- [x] Charger", "  USB-C", "- [ ] Email Dana", "  `dana@example.com`"].join("\n") + "\n",
		);
	});

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
		const markdown = await page.evaluate(() => navigator.clipboard.readText());
		expect(markdown).toBe(["# DNS", "", "- [ ] Add the record", "  Name: `_acme`", "  `abc123`"].join("\n") + "\n");
	});

	it("numbers the steps of an ordered list", async () => {
		const { open } = await session();
		const page = await open(linkFor(steps));
		await toggle(page, 0);
		await page.locator("#copy").click();
		await page.locator("#copy.flash").waitFor();
		const markdown = await page.evaluate(() => navigator.clipboard.readText());
		expect(markdown).toBe(["# Steps", "", "1. [x] One", "2. [ ] Two", "3. [ ] Three"].join("\n") + "\n");
	});
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
	});

	it("keeps the saved list when a single value is written as an array", async () => {
		const { open } = await session();
		const first = await open(linkFor({ tasks: [{ text: "A", copy: "x" }] }));
		await first.waitForURL(ID_URL);
		const id = first.url();
		const second = await open(linkFor({ tasks: [{ text: "A", copy: ["x"] }] }));
		await second.waitForURL(ID_URL);
		expect(second.url()).toBe(id);
	});
});

describe("the display options", () => {
	const detailed = { tasks: [{ text: "A", details: "More about A", copy: "value-a" }, "B"] };
	const hasClass = (page: Page, name: string) => page.locator("#list").evaluate((list, cls) => list.classList.contains(cls), name);

	it("only shows the menu when there is something to hide", async () => {
		const { open } = await session();
		expect(await (await open(linkFor(groceries))).locator("#display-menu").isHidden()).toBe(true);
		expect(await (await open(linkFor(detailed))).locator("#display-menu").isVisible()).toBe(true);
	});

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
	});

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
	});

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
	});
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
	});

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
	});

	it("has no handles in an ordered list", async () => {
		const { open } = await session();
		const page = await open(linkFor(steps));
		expect(await page.locator(".handle").count()).toBe(0);
	});
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
	});
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
	});

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
	});
});
