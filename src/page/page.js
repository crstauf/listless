"use strict";

// Listless page. Everything here runs locally: the list arrives in the URL
// fragment (never sent to the server), is saved to localStorage, and the
// Content-Security-Policy forbids this page from making any network request.

(() => {
	const STORAGE_PREFIX = "listless:";
	const FORMAT_PREFIX = "#v1.";
	const ID_LENGTH = 12;
	const MAX_TASKS = 500;
	const MAX_SECTIONS = 50;
	const MAX_TASK_LENGTH = 1000;
	const MAX_DETAILS_LENGTH = 2000;
	const MAX_TITLE_LENGTH = 200;

	const $ = (id) => document.getElementById(id);
	const els = {
		bar: document.querySelector(".bar"),
		title: $("title"),
		progressText: $("progress-text"),
		progressFill: $("progress-fill"),
		copy: $("copy"),
		toggleDone: $("toggle-done"),
		toggleUpcoming: $("toggle-upcoming"),
		toggleDetails: $("toggle-details"),
		reset: $("reset"),
		del: $("delete"),
		notice: $("notice"),
		list: $("list"),
		upcomingHidden: $("upcoming-hidden"),
		allDone: $("all-done"),
		message: $("message"),
		messageTitle: $("message-title"),
		messageBody: $("message-body"),
	};

	let id = null;
	let persistent = true;
	// state: { title, ordered, sections: [{ title, tasks: [{ text, details }] }],
	//          checked: number[], hideCompleted, hideUpcoming, hideDetails, createdAt }
	// Task numbers in `checked` count across all sections, in order.
	let state = null;
	let rows = []; // one { li, box } per task, in the same order
	let groupViews = []; // one { group, rows, count } per section

	// ---- list format -----------------------------------------------------------

	const clip = (text, max) => text.trim().slice(0, max);

	function normalizeTask(task) {
		if (typeof task === "string" && task.trim()) return { text: clip(task, MAX_TASK_LENGTH), details: "" };
		if (task && typeof task === "object" && typeof task.text === "string" && task.text.trim()) {
			const details = typeof task.details === "string" ? clip(task.details, MAX_DETAILS_LENGTH) : "";
			return { text: clip(task.text, MAX_TASK_LENGTH), details };
		}
		return null;
	}

	function normalizeTasks(tasks) {
		if (!Array.isArray(tasks) || tasks.length === 0) return null;
		const cleaned = tasks.map(normalizeTask);
		return cleaned.includes(null) ? null : cleaned;
	}

	// Accepts the link format ({tasks} or {sections}) and returns the shape the
	// page works with, or null if the value isn't a usable list.
	function normalizeList(value) {
		if (!value || typeof value !== "object") return null;
		if (value.title !== undefined && typeof value.title !== "string") return null;

		let sections;
		if (Array.isArray(value.sections)) {
			if (value.sections.length === 0 || value.sections.length > MAX_SECTIONS) return null;
			sections = value.sections.map((section) => {
				const tasks = section && normalizeTasks(section.tasks);
				const title = section && typeof section.title === "string" ? clip(section.title, MAX_TITLE_LENGTH) : "";
				return tasks && { title, tasks };
			});
			if (sections.includes(null)) return null;
		} else {
			const tasks = normalizeTasks(value.tasks);
			if (!tasks) return null;
			sections = [{ title: "", tasks }];
		}

		const total = sections.reduce((sum, section) => sum + section.tasks.length, 0);
		if (total > MAX_TASKS) return null;

		return {
			title: clip(value.title || "", MAX_TITLE_LENGTH),
			ordered: value.ordered === true,
			sections,
		};
	}

	function totalTasks() {
		return state.sections.reduce((sum, section) => sum + section.tasks.length, 0);
	}

	// ---- storage -------------------------------------------------------------

	function storageKey(listId) {
		return STORAGE_PREFIX + listId;
	}

	function load(listId) {
		try {
			const raw = localStorage.getItem(storageKey(listId));
			return raw ? fromStored(JSON.parse(raw)) : null;
		} catch {
			return null;
		}
	}

	function save() {
		if (!persistent) return;
		try {
			localStorage.setItem(storageKey(id), JSON.stringify(state));
		} catch {
			persistent = false;
			showNotice("Your browser isn't letting this page save. Checks will be lost when you close it.");
		}
	}

	function remove() {
		try {
			localStorage.removeItem(storageKey(id));
		} catch {
			// Nothing was saved, so there's nothing to remove.
		}
	}

	function storageAvailable() {
		try {
			const probe = STORAGE_PREFIX + "probe";
			localStorage.setItem(probe, "1");
			localStorage.removeItem(probe);
			return true;
		} catch {
			return false;
		}
	}

	function fromStored(value) {
		const list = normalizeList(value);
		if (!list) return null;
		const total = list.sections.reduce((sum, section) => sum + section.tasks.length, 0);
		let checked = Array.isArray(value.checked)
			? [...new Set(value.checked.filter((i) => Number.isInteger(i) && i >= 0 && i < total))].sort((a, b) => a - b)
			: [];
		// Ordered lists are always completed from the top: keep only the
		// unbroken run of checks from the first task.
		if (list.ordered) checked = checked.filter((i, position) => i === position);
		return {
			...list,
			checked,
			hideCompleted: value.hideCompleted === true,
			hideUpcoming: value.hideUpcoming === true,
			hideDetails: value.hideDetails === true,
			createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
		};
	}

	function freshState(list) {
		return {
			...list,
			checked: [],
			hideCompleted: false,
			hideUpcoming: false,
			hideDetails: false,
			createdAt: new Date().toISOString(),
		};
	}

	// ---- decoding --------------------------------------------------------------

	function fromBase64Url(text) {
		const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
		return Uint8Array.from(binary, (c) => c.charCodeAt(0));
	}

	function toBase64Url(bytes) {
		let binary = "";
		for (const byte of bytes) binary += String.fromCharCode(byte);
		return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	}

	async function decodeFragment(fragment) {
		const compressed = fromBase64Url(fragment.slice(FORMAT_PREFIX.length));
		const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
		const text = await new Response(stream).text();
		return normalizeList(JSON.parse(text));
	}

	// The ID is derived from the list's content, so reopening the same link
	// finds the same saved list (and its checks) instead of creating a copy.
	async function listId(list) {
		const canonical = JSON.stringify({ title: list.title, ordered: list.ordered, sections: list.sections });
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
		return toBase64Url(new Uint8Array(digest)).slice(0, ID_LENGTH);
	}

	// ---- rendering -------------------------------------------------------------

	function displayTitle() {
		return state.title || "Checklist";
	}

	// Text is plain except for `backtick` spans, which become <code>.
	function renderInline(target, text) {
		const parts = text.split(/(`[^`\n]+`)/);
		target.replaceChildren(
			...parts
				.filter((part) => part !== "")
				.map((part) => {
					if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
						const code = document.createElement("code");
						code.textContent = part.slice(1, -1);
						return code;
					}
					return document.createTextNode(part);
				}),
		);
	}

	function el(tag, className) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		return node;
	}

	const SVG_NS = "http://www.w3.org/2000/svg";

	// The visible checkbox: a styled box with a check mark that draws itself
	// in when the (visually hidden) real checkbox before it is checked.
	function checkmark() {
		const box = el("span", "box");
		const svg = document.createElementNS(SVG_NS, "svg");
		const path = document.createElementNS(SVG_NS, "path");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("aria-hidden", "true");
		path.setAttribute("d", "M6 12.5l4 4 8-9");
		path.setAttribute("pathLength", "1");
		svg.append(path);
		box.append(svg);
		return box;
	}

	function render() {
		els.message.hidden = true;
		els.bar.hidden = false;
		els.list.hidden = false;
		renderInline(els.title, displayTitle());
		document.title = displayTitle().replace(/`/g, "") + " · Listless";

		const hasDetails = state.sections.some((section) => section.tasks.some((task) => task.details));
		els.toggleUpcoming.hidden = !state.ordered;
		els.toggleDetails.hidden = !hasDetails;
		els.list.classList.toggle("ordered", state.ordered);

		rows = [];
		const groups = state.sections.map((section, sectionIndex) => {
			const group = el("section", "group");
			const groupRows = [];
			if (section.title) {
				const head = el("div", "group-head");
				const heading = el("h2");
				const count = el("span", "group-count");
				renderInline(heading, section.title);
				head.append(heading, count);
				group.append(head);
				group.dataset.hasHead = "true";
			}

			const list = el(state.ordered ? "ol" : "ul", "tasks");
			for (const task of section.tasks) {
				const index = rows.length;
				const li = el("li", "task");
				const label = el("label");
				const box = el("input");
				const body = el("span", "body");
				const text = el("span", "text");
				box.type = "checkbox";
				box.className = "visually-hidden";
				box.dataset.index = String(index);
				renderInline(text, task.text);
				if (state.ordered) {
					const step = el("span", "step");
					step.textContent = `Step ${index + 1}`;
					body.append(step);
				}
				body.append(text);
				if (task.details) {
					const details = el("span", "details");
					renderInline(details, task.details);
					body.append(details);
				}
				label.append(box, checkmark(), body);
				li.append(label);
				list.append(li);
				const row = { li, box, sectionIndex };
				rows.push(row);
				groupRows.push(row);
			}
			group.append(list);
			return { group, rows: groupRows, count: group.querySelector(".group-count") };
		});

		els.list.replaceChildren(...groups.map((g) => g.group));
		groupViews = groups;
		update();
	}

	function currentIndex() {
		// The first unchecked task; in an ordered list it's the only one that
		// can be checked next.
		const checked = new Set(state.checked);
		for (let i = 0; i < rows.length; i++) if (!checked.has(i)) return i;
		return -1;
	}

	function update() {
		const checked = new Set(state.checked);
		const total = rows.length;
		const done = state.checked.length;
		const current = currentIndex();
		let upcomingHidden = 0;

		rows.forEach(({ li, box }, index) => {
			const isDone = checked.has(index);
			const upcoming = state.ordered && !isDone && index !== current;
			box.checked = isDone;
			box.disabled = upcoming;
			li.classList.toggle("done", isDone);
			li.classList.toggle("current", state.ordered && index === current);
			li.classList.toggle("upcoming", upcoming);
			const hide = (isDone && state.hideCompleted) || (upcoming && state.hideUpcoming);
			li.hidden = hide;
			if (upcoming && state.hideUpcoming) upcomingHidden++;
		});

		for (const view of groupViews) {
			const doneHere = view.rows.filter(({ box }) => box.checked).length;
			if (view.count) {
				view.count.textContent = doneHere === view.rows.length ? "✓" : `${doneHere}/${view.rows.length}`;
			}
			view.group.classList.toggle("complete", doneHere === view.rows.length);
			view.group.hidden = view.rows.every(({ li }) => li.hidden);
		}

		els.progressText.textContent = `${done} of ${total} done`;
		els.progressFill.style.transform = `scaleX(${total ? done / total : 0})`;
		els.list.classList.toggle("hide-details", state.hideDetails);
		setToggle(els.toggleDone, state.hideCompleted, "Show completed", "Hide completed");
		setToggle(els.toggleUpcoming, state.hideUpcoming, "Show upcoming", "Hide upcoming");
		setToggle(els.toggleDetails, state.hideDetails, "Show details", "Hide details");

		els.upcomingHidden.hidden = upcomingHidden === 0;
		els.upcomingHidden.textContent =
			upcomingHidden === 1 ? "1 upcoming task hidden · Show" : `${upcomingHidden} upcoming tasks hidden · Show`;
		els.allDone.hidden = !(done === total && total > 0);
	}

	function setToggle(button, pressed, pressedLabel, label) {
		button.setAttribute("aria-pressed", String(pressed));
		const text = pressed ? pressedLabel : label;
		button.setAttribute("aria-label", text);
		button.title = text;
	}

	function showMessage(title, body) {
		els.bar.hidden = true;
		els.list.hidden = true;
		els.upcomingHidden.hidden = true;
		els.allDone.hidden = true;
		els.notice.hidden = true;
		els.message.hidden = false;
		els.messageTitle.textContent = title;
		els.messageBody.textContent = body;
		document.title = "Listless";
	}

	function showNotice(text) {
		els.notice.textContent = text;
		els.notice.hidden = false;
	}

	// ---- actions ---------------------------------------------------------------

	els.list.addEventListener("change", (event) => {
		const box = event.target;
		if (!(box instanceof HTMLInputElement)) return;
		const index = Number(box.dataset.index);

		if (box.checked) {
			state.checked = [...new Set([...state.checked, index])].sort((a, b) => a - b);
		} else if (state.ordered) {
			// Unchecking a step reopens it and everything after it.
			const later = state.checked.filter((i) => i > index).length;
			if (later > 0 && !confirm(`Uncheck this step and the ${later === 1 ? "step" : `${later} steps`} after it?`)) {
				box.checked = true;
				return;
			}
			state.checked = state.checked.filter((i) => i < index);
		} else {
			state.checked = state.checked.filter((i) => i !== index);
		}
		save();
		update();
	});

	// One click selects a whole code span (to copy it) without toggling the
	// task it sits in.
	els.list.addEventListener("click", (event) => {
		const code = event.target instanceof Element && event.target.closest("code");
		if (!code) return;
		event.preventDefault();
		const range = document.createRange();
		range.selectNodeContents(code);
		const selection = getSelection();
		selection.removeAllRanges();
		selection.addRange(range);
	});

	els.toggleDone.addEventListener("click", () => {
		state.hideCompleted = !state.hideCompleted;
		save();
		update();
	});

	els.toggleUpcoming.addEventListener("click", () => {
		state.hideUpcoming = !state.hideUpcoming;
		save();
		update();
	});

	els.upcomingHidden.addEventListener("click", () => {
		state.hideUpcoming = false;
		save();
		update();
	});

	els.toggleDetails.addEventListener("click", () => {
		state.hideDetails = !state.hideDetails;
		save();
		update();
	});

	els.reset.addEventListener("click", () => {
		if (state.checked.length === 0) return;
		if (!confirm("Uncheck every task?")) return;
		state.checked = [];
		save();
		update();
	});

	els.del.addEventListener("click", () => {
		if (!confirm("Delete this list from this browser? This can't be undone, but the original link can import it again.")) return;
		remove();
		state = null;
		showMessage("List deleted", "It has been removed from this browser. Opening the original link again will import a fresh copy.");
	});

	els.copy.addEventListener("click", async () => {
		const ok = await copyText(toMarkdown());
		flash(els.copy, ok ? "Copied" : "Copy failed");
	});

	function toMarkdown() {
		const checked = new Set(state.checked);
		const oneLine = (text) => text.replace(/\s*\n\s*/g, " ");
		const lines = [`# ${oneLine(displayTitle())}`];
		let index = 0;
		for (const section of state.sections) {
			lines.push("");
			if (section.title) lines.push(`## ${oneLine(section.title)}`, "");
			for (const task of section.tasks) {
				const marker = state.ordered ? `${index + 1}.` : "-";
				const indent = " ".repeat(marker.length + 1);
				lines.push(`${marker} [${checked.has(index) ? "x" : " "}] ${oneLine(task.text)}`);
				if (task.details) {
					for (const line of task.details.split("\n")) lines.push(indent + line.trim());
				}
				index++;
			}
		}
		return lines.join("\n") + "\n";
	}

	async function copyText(text) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			const area = document.createElement("textarea");
			area.value = text;
			area.setAttribute("readonly", "");
			area.className = "offscreen";
			document.body.append(area);
			area.select();
			let ok = false;
			try {
				ok = document.execCommand("copy");
			} catch {
				ok = false;
			}
			area.remove();
			return ok;
		}
	}

	function flash(button, text) {
		const original = button.dataset.label || button.getAttribute("aria-label");
		button.dataset.label = original;
		button.setAttribute("aria-label", text);
		button.title = text;
		button.classList.add("flash");
		clearTimeout(Number(button.dataset.timer));
		button.dataset.timer = String(
			setTimeout(() => {
				button.setAttribute("aria-label", original);
				button.title = original;
				button.classList.remove("flash");
			}, 1500),
		);
	}

	// Keep other open tabs of the same list in sync.
	window.addEventListener("storage", (event) => {
		if (!id || event.key !== storageKey(id)) return;
		if (event.newValue === null) {
			state = null;
			showMessage("List deleted", "This list was deleted in another tab.");
			return;
		}
		const next = load(id);
		if (next) {
			state = next;
			render();
		}
	});

	// ---- startup ---------------------------------------------------------------

	async function start() {
		persistent = storageAvailable();

		if (location.hash.startsWith(FORMAT_PREFIX)) {
			let list;
			try {
				list = await decodeFragment(location.hash);
			} catch {
				list = null;
			}
			if (!list) {
				showMessage("This link is damaged", "The list in this link couldn't be read. It may have been cut off when it was copied. Ask the agent for the link again.");
				return;
			}

			id = await listId(list);
			state = (persistent && load(id)) || freshState(list);

			if (persistent) {
				save();
				// Swap the long link for a short one; the list now lives here.
				history.replaceState(null, "", "/l/" + id);
			} else {
				showNotice("Your browser isn't letting this page save. Keep the original link; checks will be lost when you close it.");
			}
			render();
			return;
		}

		const match = location.pathname.match(/^\/l\/([A-Za-z0-9_-]+)$/);
		if (!match) {
			showMessage("No list here", "Listless lists are created from a link an agent gives you. Open that link to get started.");
			return;
		}

		id = match[1];
		state = persistent ? load(id) : null;
		if (!state) {
			showMessage("This list isn't saved in this browser", "Lists live only in the browser that opened them. Open the original link here to import it.");
			return;
		}
		render();
	}

	// A new link pasted into this tab only changes the fragment, which doesn't
	// reload the page.
	window.addEventListener("hashchange", () => {
		if (location.hash.startsWith(FORMAT_PREFIX)) start();
	});

	start();
})();
