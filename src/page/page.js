"use strict";

// Listless page. Everything here runs locally: the list arrives in the URL
// fragment (never sent to the server), is saved to localStorage, and the
// Content-Security-Policy forbids this page from making any network request.

(() => {
	const STORAGE_PREFIX = "listless:";
	const FORMAT_PREFIX = "#v1.";
	// The same list as plain JSON, percent-encoded, for agents that can't run code to compress it.
	const PLAIN_PREFIX = "#json=";
	const ID_LENGTH = 12;
	const ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${ID_LENGTH}}$`);
	// Filled in at build time from src/limits.ts.
	const LIMITS = "{{LIMITS}}";

	const hoverable = matchMedia("(hover: hover)");

	const $ = (id) => document.getElementById(id);
	const els = {
		bar: document.querySelector(".bar"),
		title: $("title"),
		description: $("description"),
		progressText: $("progress-text"),
		progressFill: $("progress-fill"),
		copy: $("copy"),
		share: $("share"),
		announce: $("announce"),
		toggleDone: $("toggle-done"),
		toggleUpcoming: $("toggle-upcoming"),
		displayMenu: $("display-menu"),
		display: $("display"),
		toggleDetails: $("toggle-details"),
		toggleCopy: $("toggle-copy"),
		reset: $("reset"),
		del: $("delete"),
		notice: $("notice"),
		list: $("list"),
		upcomingHidden: $("upcoming-hidden"),
		allDone: $("all-done"),
		index: $("index"),
		indexList: $("index-list"),
		message: $("message"),
		messageTitle: $("message-title"),
		messageBody: $("message-body"),
		messageAction: $("message-action"),
		toast: $("toast"),
		toastText: $("toast-text"),
		toastUndo: $("toast-undo"),
	};

	let id = null;
	let persistent = true;
	// state: { title, description, ordered, sections: [{ title, ordered?, tasks: [{ text, details, copy? }] }],
	//          checked: number[], hideCompleted, hideUpcoming, hideDetails, hideCopy,
	//          collapsed: number[] (section indices, saved here only, never in a link), createdAt }
	// Task numbers in `checked` count across all sections, in order.
	let state = null;
	let rows = []; // one { li, box, index, sequential } per task, in the same order
	let groupViews = []; // one { group, rows, count } per section

	// ---- list format -----------------------------------------------------------

	const clip = (text, max) => text.trim().slice(0, max);

	// A copy value is a string or an array of strings and { label, value } objects.
	// Mirrors the Worker's rules, but clips instead of rejecting. One unlabeled
	// value stays a string, so a list's ID doesn't depend on which form it used.
	function normalizeCopy(copy) {
		if (typeof copy === "string") return clip(copy, LIMITS.maxCopyLength);
		if (!Array.isArray(copy)) return "";
		const items = [];
		for (const item of copy.slice(0, LIMITS.maxCopyValues)) {
			const value = typeof item === "string" ? item : item && typeof item === "object" && typeof item.value === "string" ? item.value : "";
			const text = clip(value, LIMITS.maxCopyLength);
			if (!text) continue;
			const label = item && typeof item.label === "string" ? clip(item.label, LIMITS.maxCopyLabelLength) : "";
			items.push(label ? { label, value: text } : text);
		}
		if (items.length === 0) return "";
		return items.length === 1 && typeof items[0] === "string" ? items[0] : items;
	}

	// The copy values of a task as [{ label, value }] ("" when unlabeled).
	function copyItems(copy) {
		if (!copy) return [];
		return (Array.isArray(copy) ? copy : [copy]).map((item) => (typeof item === "string" ? { label: "", value: item } : item));
	}

	function normalizeTask(task) {
		if (typeof task === "string" && task.trim()) return { text: clip(task, LIMITS.maxTaskLength), details: "", copy: "", done: false };
		if (task && typeof task === "object" && typeof task.text === "string" && task.text.trim()) {
			const details = typeof task.details === "string" ? clip(task.details, LIMITS.maxDetailsLength) : "";
			const copy = normalizeCopy(task.copy);
			return { text: clip(task.text, LIMITS.maxTaskLength), details, copy, done: task.done === true };
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
		if (value.description !== undefined && typeof value.description !== "string") return null;

		let sections;
		if (Array.isArray(value.sections)) {
			if (value.sections.length === 0 || value.sections.length > LIMITS.maxSections) return null;
			sections = value.sections.map((section) => {
				const tasks = section && normalizeTasks(section.tasks);
				const title = section && typeof section.title === "string" ? clip(section.title, LIMITS.maxTitleLength) : "";
				return tasks && { title, ...(section.ordered === true ? { ordered: true } : {}), tasks };
			});
			if (sections.includes(null)) return null;
		} else {
			const tasks = normalizeTasks(value.tasks);
			if (!tasks) return null;
			sections = [{ title: "", tasks }];
		}

		const total = sections.reduce((sum, section) => sum + section.tasks.length, 0);
		if (total > LIMITS.maxTasks) return null;

		// Tasks marked done start out checked. That's progress, not content, so it
		// is split off here and never becomes part of the list (or its id).
		const ordered = value.ordered === true;
		let initialChecked = [];
		let index = 0;
		const list = { ordered, sections };
		for (const section of sections) {
			for (const task of section.tasks) {
				if (task.done) initialChecked.push(index);
				index++;
			}
			section.tasks = section.tasks.map(({ text, details, copy }) => ({ text, details, ...(copy ? { copy } : {}) }));
		}
		initialChecked = validChecks(list, initialChecked);

		return {
			title: clip(value.title || "", LIMITS.maxTitleLength),
			description: clip(value.description || "", LIMITS.maxDescriptionLength),
			ordered,
			sections,
			initialChecked,
		};
	}

	// A list without headings is one group: its `ordered` means the tasks are
	// done in sequence. With headings, it means the sections are.
	function isSingleGroup(list) {
		return list.sections.length === 1 && !list.sections[0].title;
	}

	// Whether the tasks in a section are done one after another.
	function tasksOrdered(list, section) {
		return section.ordered === true || (list.ordered && isSingleGroup(list));
	}

	// Whether a section stays locked until every section before it is done.
	function sectionsOrdered(list) {
		return list.ordered && !isSingleGroup(list);
	}

	// Keep only the checks the list's ordering allows: nothing in a section
	// until the sections before it are done, and in an ordered section only the
	// unbroken run of checks from its first task.
	function validChecks(list, checked) {
		const have = new Set(checked);
		const gated = sectionsOrdered(list);
		const valid = [];
		let offset = 0;
		let incomplete = false;
		for (const section of list.sections) {
			let kept = 0;
			if (!(gated && incomplete)) {
				const ordered = tasksOrdered(list, section);
				for (let k = 0; k < section.tasks.length; k++) {
					if (!have.has(offset + k)) {
						if (ordered) break;
						continue;
					}
					valid.push(offset + k);
					kept++;
				}
			}
			if (kept < section.tasks.length) incomplete = true;
			offset += section.tasks.length;
		}
		return valid;
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

	// Every list saved in this browser, newest first.
	function savedLists() {
		const lists = [];
		try {
			for (let i = 0; i < localStorage.length; i++) {
				const key = localStorage.key(i);
				if (!key || !key.startsWith(STORAGE_PREFIX)) continue;
				const listId = key.slice(STORAGE_PREFIX.length);
				const list = load(listId);
				if (list) lists.push({ id: listId, list });
			}
		} catch {
			return [];
		}
		return lists.sort((a, b) => b.list.createdAt.localeCompare(a.list.createdAt));
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
		const { initialChecked, ...list } = normalizeList(value) || {};
		if (!list.sections) return null;
		const total = list.sections.reduce((sum, section) => sum + section.tasks.length, 0);
		let checked = Array.isArray(value.checked)
			? [...new Set(value.checked.filter((i) => Number.isInteger(i) && i >= 0 && i < total))].sort((a, b) => a - b)
			: [];
		checked = validChecks(list, checked);
		return {
			...list,
			checked,
			hideCompleted: value.hideCompleted === true,
			hideUpcoming: value.hideUpcoming === true,
			hideDetails: value.hideDetails === true,
			hideCopy: value.hideCopy === true,
			collapsed: Array.isArray(value.collapsed)
				? [...new Set(value.collapsed.filter((i) => Number.isInteger(i) && list.sections[i]?.title))].sort((a, b) => a - b)
				: [],
			createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
		};
	}

	function freshState({ initialChecked, ...list }) {
		return {
			...list,
			checked: initialChecked,
			hideCompleted: false,
			hideUpcoming: false,
			hideDetails: false,
			hideCopy: false,
			collapsed: [],
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

	function isLinkHash(hash) {
		return hash.startsWith(FORMAT_PREFIX) || hash.startsWith(PLAIN_PREFIX);
	}

	// The list, plus `linkId` when the link names the saved list it updates (a
	// share link does). Like `done`, that's not content, so a malformed one is
	// ignored and the list's own id applies.
	async function decodeFragment(fragment) {
		let text;
		if (fragment.startsWith(PLAIN_PREFIX)) {
			// Written by hand, so a "%" that doesn't start an escape is taken literally
			// rather than rejected.
			const raw = fragment.slice(PLAIN_PREFIX.length);
			try {
				text = decodeURIComponent(raw.replace(/%(?![0-9A-Fa-f]{2})/g, "%25"));
			} catch {
				text = raw;
			}
		} else {
			const compressed = fromBase64Url(fragment.slice(FORMAT_PREFIX.length));
			const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
			text = await new Response(stream).text();
		}
		const value = JSON.parse(text);
		const list = normalizeList(value);
		if (!list) return null;
		return typeof value.id === "string" && ID_PATTERN.test(value.id) ? { ...list, linkId: value.id } : list;
	}

	async function encodeFragment(value) {
		const json = new TextEncoder().encode(JSON.stringify(value));
		const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("deflate-raw"));
		return FORMAT_PREFIX + toBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
	}

	// A list's ID is derived from its content, so reopening the same link finds
	// the same saved list (and its checks) instead of creating a copy. It is the
	// ID only when the link doesn't name one: a link with an `id` (a share link)
	// opens that saved list whatever its content. Once a list is saved its ID is
	// fixed, even if its content later changes.
	// (A list without a description hashes as it did before descriptions existed.)
	async function listId(list) {
		const { title, description, ordered, sections } = list;
		const canonical = JSON.stringify(description ? { title, description, ordered, sections } : { title, ordered, sections });
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
		return toBase64Url(new Uint8Array(digest)).slice(0, ID_LENGTH);
	}

	// ---- rendering -------------------------------------------------------------

	function displayTitle() {
		return state.title || "Checklist";
	}

	// Text is plain except for `backtick` spans, which become <code>. With
	// `links`, bare http(s) addresses outside code also become links.
	function renderInline(target, text, links = false) {
		const parts = text.split(/(`[^`\n]+`)/);
		target.replaceChildren(
			...parts
				.filter((part) => part !== "")
				.flatMap((part) => {
					if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
						const code = document.createElement("code");
						code.textContent = part.slice(1, -1);
						return [code];
					}
					return links ? linkify(part) : [document.createTextNode(part)];
				}),
		);
	}

	// Punctuation at the end of an address (a full stop, or a closing bracket
	// that the address didn't open) is left out of the link.
	function trimAddress(address) {
		const count = (char) => address.split(char).length - 1;
		for (;;) {
			const end = address.at(-1);
			const unopened = (end === ")" && count(")") > count("(")) || (end === "]" && count("]") > count("["));
			if (!unopened && !".,;:!?'\"".includes(end)) return address;
			address = address.slice(0, -1);
		}
	}

	function linkify(text) {
		const nodes = [];
		let last = 0;
		for (const match of text.matchAll(/https?:\/\/[^\s<>"]+/g)) {
			const href = trimAddress(match[0]);
			let url;
			try {
				url = new URL(href);
			} catch {
				continue;
			}
			if (match.index > last) nodes.push(document.createTextNode(text.slice(last, match.index)));
			const link = document.createElement("a");
			link.href = url.href;
			link.textContent = href;
			link.target = "_blank";
			link.rel = "noopener noreferrer";
			nodes.push(link);
			last = match.index + href.length;
		}
		if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
		return nodes;
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

	function chevron() {
		const svg = document.createElementNS(SVG_NS, "svg");
		const path = document.createElementNS(SVG_NS, "path");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("aria-hidden", "true");
		path.setAttribute("d", "M6 9l6 6 6-6");
		svg.append(path);
		return svg;
	}

	// Same icon as the Copy as Markdown button: idle, then a check while flashing.
	const copyIcon = () => els.copy.querySelector("svg").cloneNode(true);

	// Reordering starts from this handle only, so the task text stays selectable.
	function dragHandle(label) {
		const handle = el("button", "icon handle");
		handle.type = "button";
		handle.setAttribute("aria-label", `Move: ${label.replace(/`/g, "")}`);
		handle.title = "Drag to reorder, or use the arrow keys";
		const svg = document.createElementNS(SVG_NS, "svg");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("aria-hidden", "true");
		for (const cx of [9, 15]) {
			for (const cy of [6, 12, 18]) {
				const dot = document.createElementNS(SVG_NS, "circle");
				dot.setAttribute("cx", String(cx));
				dot.setAttribute("cy", String(cy));
				dot.setAttribute("r", "1.25");
				svg.append(dot);
			}
		}
		handle.append(svg);
		return handle;
	}

	function render() {
		disarm(); // the controls it was waiting on are about to be replaced
		els.message.hidden = true;
		els.index.hidden = true;
		els.bar.hidden = false;
		els.list.hidden = false;
		renderInline(els.title, displayTitle());
		document.title = displayTitle().replace(/`/g, "") + " · Listless";
		renderInline(els.description, state.description, true);
		els.description.hidden = !state.description;

		els.toggleUpcoming.hidden = !(state.ordered || state.sections.some((section) => section.ordered));
		const hasDetails = state.sections.some((section) => section.tasks.some((task) => task.details));
		const hasCopy = state.sections.some((section) => section.tasks.some((task) => task.copy));
		els.displayMenu.hidden = !hasDetails && !hasCopy;
		els.displayMenu.classList.toggle("single", hasDetails !== hasCopy);
		els.toggleDetails.hidden = !hasDetails;
		els.toggleCopy.hidden = !hasCopy;
		els.list.classList.toggle("ordered", state.ordered);

		rows = [];
		const groups = state.sections.map((section, sectionIndex) => {
			const group = el("section", "group");
			const groupRows = [];
			if (section.title) {
				const head = el("div", "group-head");
				const heading = el("h2");
				const count = el("span", "group-count");
				const toggle = el("button", "icon collapse");
				toggle.type = "button";
				toggle.dataset.section = String(sectionIndex);
				toggle.setAttribute("aria-controls", `section-${sectionIndex}-tasks`);
				toggle.append(chevron());
				renderInline(heading, section.title);
				head.append(heading, toggle, count);
				group.append(head);
				group.dataset.hasHead = "true";
			}

			const sequential = tasksOrdered(state, section);
			const list = el(sequential ? "ol" : "ul", "tasks");
			list.id = `section-${sectionIndex}-tasks`;
			for (const task of section.tasks) {
				const index = rows.length;
				// Only the checkbox toggles the task; the text is ordinary text
				// that can be selected, and its links followed.
				const li = el("li", "task");
				const card = el("div", "card");
				const label = el("label", "check");
				const box = el("input");
				const body = el("div", "body");
				const text = el("span", "text");
				box.type = "checkbox";
				box.className = "visually-hidden";
				box.dataset.index = String(index);
				text.id = `task-${index}`;
				box.setAttribute("aria-labelledby", text.id);
				renderInline(text, task.text, true);
				if (sequential) {
					const step = el("span", "step");
					step.textContent = `Step ${groupRows.length + 1}`;
					body.append(step);
				}
				body.append(text);
				if (task.details) {
					const details = el("span", "details");
					details.id = `task-${index}-details`;
					renderInline(details, task.details, true);
					body.append(details);
				}
				// A value to paste elsewhere hangs below the card as a drawer.
				let drawer = null;
				const copies = copyItems(task.copy);
				if (copies.length) {
					drawer = el("div", "drawer");
					const stack = el("div", "copies");
					drawer.append(stack);
					copies.forEach(({ label: name, value: text }, k) => {
						const copy = el("div", "copy");
						const value = el("span", "copy-value");
						const button = el("button", "icon");
						value.id = `task-${index}-copy-${k}`;
						value.textContent = text;
						const what = name ? `Copy ${name}` : "Copy value";
						button.type = "button";
						button.setAttribute("aria-label", what);
						button.title = what;
						button.append(copyIcon());
						button.addEventListener("click", async () => {
							flash(button, (await copyText(text)) ? "Copied" : "Copy failed");
						});
						if (name) {
							const tag = el("span", "copy-label");
							tag.textContent = name;
							copy.append(tag);
						}
						copy.append(value, button);
						stack.append(copy);
					});
				}
				label.append(box, checkmark());
				card.append(label, body);
				li.append(card);
				if (drawer) li.append(drawer);
				list.append(li);
				if (!sequential) card.append(dragHandle(task.text));
				const row = {
					li,
					box,
					index,
					sequential,
					sectionIndex,
					label,
					detailsId: task.details ? `task-${index}-details` : "",
					copyId: copies.map((_, k) => `task-${index}-copy-${k}`).join(" "),
				};
				rows.push(row);
				groupRows.push(row);
			}
			// The wrapper is what collapses; the list inside keeps its own layout.
			const body = el("div", "group-body");
			body.append(list);
			group.append(body);
			return {
				group,
				rows: groupRows,
				count: group.querySelector(".group-count"),
				toggle: group.querySelector(".collapse"),
			};
		});

		els.list.replaceChildren(...groups.map((g) => g.group));
		groupViews = groups;
		update();
	}

	const FINISH_HINT = `${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌥" : "Alt"}-click to check off and collapse`;

	function update() {
		const checked = new Set(state.checked);
		const total = rows.length;
		const done = state.checked.length;
		const gated = sectionsOrdered(state);
		let upcomingHidden = 0;
		let incomplete = false; // an earlier section isn't done yet
		const locked = [];

		groupViews.forEach((view, sectionIndex) => {
			const sectionLocked = gated && incomplete;
			locked[sectionIndex] = sectionLocked;
			// In a sequential section, the first unchecked task is the only one that
			// can be checked next.
			let currentFound = false;
			for (const { li, box, index, sequential, detailsId, copyId } of view.rows) {
				const isDone = checked.has(index);
				const current = sequential && !sectionLocked && !isDone && !currentFound;
				if (current) currentFound = true;
				const upcoming = !isDone && (sectionLocked || (sequential && !current));
				box.checked = isDone;
				box.disabled = upcoming;
				li.classList.toggle("done", isDone);
				li.classList.toggle("current", current);
				li.classList.toggle("upcoming", upcoming);
				li.hidden = (isDone && state.hideCompleted) || (upcoming && state.hideUpcoming);
				// Hidden details and copy values (and a done task's) aren't read out either.
				const described = [state.hideDetails ? "" : detailsId, state.hideCopy || isDone ? "" : copyId].filter(Boolean).join(" ");
				if (described) box.setAttribute("aria-describedby", described);
				else box.removeAttribute("aria-describedby");
				if (upcoming && state.hideUpcoming) upcomingHidden++;
			}
			if (view.rows.some(({ index }) => !checked.has(index))) incomplete = true;
		});

		groupViews.forEach((view, sectionIndex) => {
			const doneHere = view.rows.filter(({ box }) => box.checked).length;
			if (view.count) {
				view.count.textContent = doneHere === view.rows.length ? "✓" : `${doneHere}/${view.rows.length}`;
			}
			view.group.classList.toggle("complete", doneHere === view.rows.length);
			view.group.classList.toggle("locked", locked[sectionIndex]);
			if (view.toggle) {
				const collapsed = state.collapsed.includes(sectionIndex);
				const name = collapsed ? "Expand section" : "Collapse section";
				view.group.classList.toggle("collapsed", collapsed);
				view.toggle.setAttribute("aria-expanded", String(!collapsed));
				view.toggle.setAttribute("aria-label", name);
				view.toggle.title = name;
			}
			// When one task is all that's left in a section, its checkbox hints that
			// an Alt-click finishes it and folds the section away.
			const open = view.rows.filter(({ box }) => !box.checked);
			const finishing = view.toggle && view.rows.length > 1 && open.length === 1 && !open[0].box.disabled ? open[0] : null;
			for (const row of view.rows) {
				if (row === finishing) row.label.dataset.hint = FINISH_HINT;
				else delete row.label.dataset.hint;
			}
			view.group.hidden = view.rows.every(({ li }) => li.hidden);
		});

		els.progressText.textContent = `${done} of ${total} done`;
		els.progressFill.style.transform = `scaleX(${total ? done / total : 0})`;
		els.list.classList.toggle("hide-details", state.hideDetails);
		els.list.classList.toggle("hide-copy", state.hideCopy);
		setToggle(els.toggleDone, state.hideCompleted, "Show completed", "Hide completed");
		setToggle(els.toggleUpcoming, state.hideUpcoming, "Show upcoming", "Hide upcoming");
		setToggle(els.toggleDetails, state.hideDetails, "Show details", "Hide details");
		setToggle(els.toggleCopy, state.hideCopy, "Show copy text", "Hide copy text");
		syncDisplayButton();
		els.display.dataset.hideDetails = String(state.hideDetails);
		els.display.dataset.hideCopy = String(state.hideCopy);

		els.upcomingHidden.hidden = upcomingHidden === 0;
		els.upcomingHidden.textContent =
			upcomingHidden === 1 ? "1 upcoming task hidden · Show" : `${upcomingHidden} upcoming tasks hidden · Show`;
		els.allDone.hidden = !(done === total && total > 0);
	}

	// With hover, the Display button toggles details and copy text together, and its
	// label says which way. Without it, the button opens the options, so it's a menu
	// button instead. It has no aria-pressed: that would give it the pressed circle.
	function syncDisplayButton() {
		if (!state) return; // no list is showing (an index or a message)
		const button = els.display;
		let label = "Display options";
		if (hoverable.matches) {
			label = state.hideDetails && state.hideCopy ? "Show details and copy text" : "Hide details and copy text";
			button.removeAttribute("aria-haspopup");
			button.removeAttribute("aria-expanded");
		} else {
			button.setAttribute("aria-haspopup", "true");
			button.setAttribute("aria-expanded", String(els.displayMenu.classList.contains("open")));
		}
		button.setAttribute("aria-label", label);
		button.title = label;
	}

	function setToggle(button, pressed, pressedLabel, label) {
		button.setAttribute("aria-pressed", String(pressed));
		const text = pressed ? pressedLabel : label;
		button.setAttribute("aria-label", text);
		button.title = text;
	}

	// An optional action adds a button below the text: { label, run }.
	function showMessage(title, body, action) {
		els.messageAction.hidden = !action;
		els.messageAction.onclick = action ? action.run : null;
		if (action) els.messageAction.textContent = action.label;
		els.bar.hidden = true;
		els.description.hidden = true;
		els.list.hidden = true;
		els.upcomingHidden.hidden = true;
		els.allDone.hidden = true;
		els.notice.hidden = true;
		els.index.hidden = true;
		els.message.hidden = false;
		els.messageTitle.textContent = title;
		els.messageBody.textContent = body;
		document.title = "Listless";
	}

	// The index, or a message when it has run out of lists.
	function redrawIndex() {
		if (!showIndex()) showMessage("No lists saved", "Lists you open in this browser appear here. Open a list's link to get started.");
	}

	// The lists saved in this browser, for /l/ when there's no list to show.
	function showIndex() {
		const lists = savedLists();
		if (lists.length === 0) return false;

		const items = lists.map(({ id: listId, list }) => {
			const li = el("li");
			const entry = el("div", "entry");
			const link = el("a");
			const meta = el("span");
			const del = el("button", "icon danger");
			const total = list.sections.reduce((sum, section) => sum + section.tasks.length, 0);
			const opened = new Date(list.createdAt);
			link.href = "/l/" + listId;
			renderInline(link, list.title || "Checklist");
			meta.textContent = `${list.checked.length} of ${total} done` + (isNaN(opened) ? "" : ` · opened ${opened.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`);
			del.type = "button";
			del.setAttribute("aria-label", `Delete list: ${(list.title || "Checklist").replace(/`/g, "")}`);
			del.title = "Delete list";
			del.append(els.del.querySelector("svg").cloneNode(true));
			confirmable(del, "Click again to delete this list", () => {
				const key = storageKey(listId);
				let saved = null;
				try {
					saved = localStorage.getItem(key);
					localStorage.removeItem(key);
				} catch {
					// Nothing was saved, so there's nothing to remove.
				}
				redrawIndex();
				showToast("List deleted", () => {
					try {
						if (saved !== null) localStorage.setItem(key, saved);
					} catch {
						// The browser won't save it back.
					}
					redrawIndex();
				});
			});
			entry.append(link, meta);
			li.append(entry, del);
			return li;
		});

		els.bar.hidden = true;
		els.description.hidden = true;
		els.list.hidden = true;
		els.upcomingHidden.hidden = true;
		els.allDone.hidden = true;
		els.notice.hidden = true;
		els.message.hidden = true;
		els.indexList.replaceChildren(...items);
		els.index.hidden = false;
		document.title = "Your lists · Listless";
		return true;
	}

	// An optional action adds a button after the text: { label, run }.
	function showNotice(text, action) {
		els.notice.textContent = text;
		if (action) {
			const button = el("button");
			button.type = "button";
			button.textContent = action.label;
			button.addEventListener("click", () => {
				els.notice.hidden = true;
				action.run();
			});
			els.notice.append(" ", button);
		}
		els.notice.hidden = false;
	}

	// ---- confirming and undoing --------------------------------------------------

	// A destructive control waits for a second click: the first one arms it (red,
	// with a check mark) and the second carries out the action. Anything else
	// disarms it without doing anything. Only one control is armed at a time.
	const ARM_MS = 4000;
	let armed = null; // { target, timer, reset }

	function disarm() {
		if (!armed) return;
		clearTimeout(armed.timer);
		armed.reset();
		armed = null;
	}

	function arm(target, prompt, reset) {
		disarm();
		els.announce.textContent = prompt;
		armed = { target, timer: setTimeout(disarm, ARM_MS), reset };
	}

	// `run` happens on the second click; `canArm` skips arming when there's nothing to do.
	function confirmable(button, prompt, run, canArm = () => true) {
		button.addEventListener("click", () => {
			if (armed?.target === button) {
				disarm();
				run();
				return;
			}
			if (!canArm()) return disarm();
			const label = button.getAttribute("aria-label");
			const title = button.title;
			button.classList.add("armed");
			button.setAttribute("aria-label", prompt);
			button.title = prompt;
			arm(button, prompt, () => {
				button.classList.remove("armed");
				button.setAttribute("aria-label", label);
				button.title = title;
			});
		});
	}

	document.addEventListener("click", (event) => {
		if (armed && !armed.target.contains(event.target)) disarm();
	});
	// Tabbing away disarms too. (Focus going nowhere is a click on plain text,
	// which the click handler above deals with; pressing a row's check box does
	// this once before the click lands.)
	document.addEventListener("focusout", (event) => {
		if (armed && event.relatedTarget && !armed.target.contains(event.relatedTarget)) disarm();
	});

	// The last undoable change stays on offer until something else changes.
	let undo = null;

	function showToast(text, restore) {
		els.toastText.textContent = text;
		undo = restore;
		els.toast.hidden = false;
	}

	function clearToast() {
		undo = null;
		els.toast.hidden = true;
	}

	function runUndo() {
		const restore = undo;
		clearToast();
		if (restore) restore();
	}

	// Makes a change to the open list now and offers to take it back. The list can't
	// have changed underneath the offer: it is dropped if the page moved to another list.
	function undoable(text, change, restore) {
		const listId = id;
		clearToast();
		change();
		showToast(text, () => {
			if (id === listId) restore();
		});
	}

	els.toastUndo.addEventListener("click", runUndo);
	document.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			if (armed) disarm();
			else clearToast();
		} else if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "z" && undo) {
			event.preventDefault();
			runUndo();
		}
	});

	// ---- actions ---------------------------------------------------------------

	// Whether Alt was held when the checkbox was pressed: the change event doesn't say.
	let altPress = false;
	els.list.addEventListener("pointerdown", (event) => (altPress = event.altKey), true);
	els.list.addEventListener("keydown", () => (altPress = false), true);

	els.list.addEventListener("click", (event) => {
		// Firefox doesn't pass a label's click on to its checkbox while a modifier
		// key is held, so an Alt-click toggles the checkbox itself.
		const label = event.altKey && event.target instanceof Element && event.target.closest(".check");
		if (label && event.target !== label.querySelector("input")) {
			event.preventDefault();
			label.querySelector("input").click();
			return;
		}
		const button = event.target instanceof Element && event.target.closest(".collapse");
		if (!button) return;
		const index = Number(button.dataset.section);
		const collapse = !state.collapsed.includes(index);
		// Alt applies the same change to every titled section.
		const targets = event.altKey ? state.sections.flatMap((section, i) => (section.title ? [i] : [])) : [index];
		const rest = state.collapsed.filter((i) => !targets.includes(i));
		state.collapsed = collapse ? [...rest, ...targets].sort((a, b) => a - b) : rest;
		// Focus inside a section that just folded away would be lost.
		if (collapse && button.closest(".group").contains(document.activeElement)) button.focus();
		save();
		update();
	});

	els.list.addEventListener("change", (event) => {
		const box = event.target;
		if (!(box instanceof HTMLInputElement)) return;
		const alt = altPress;
		altPress = false;
		const index = Number(box.dataset.index);
		const row = box.closest(".task");
		if (armed && armed.target !== row) disarm();

		if (box.checked) {
			clearToast();
			state.checked = [...new Set([...state.checked, index])].sort((a, b) => a - b);
		} else {
			// Unchecking a step in an ordered section, or a task in an ordered list's
			// section, can reopen what follows it (the steps after it, and any later
			// sections that lock again), so that asks first: the task is armed, and
			// unchecking it again goes ahead.
			const rest = state.checked.filter((i) => i !== index);
			const kept = validChecks(state, rest);
			const later = rest.length - kept.length;
			if (later > 0) {
				const noun = rows[index].sequential ? "step" : "task";
				const after = later === 1 ? noun : `${later} ${noun}s`;
				if (armed?.target !== row) {
					box.checked = true;
					row.classList.add("armed");
					arm(row, `Uncheck again to reopen this ${noun} and the ${after} after it`, () => row.classList.remove("armed"));
					return;
				}
				disarm();
				const before = state.checked;
				undoable(
					`Reopened this ${noun} and the ${after} after it`,
					() => {
						state.checked = kept;
						save();
						update();
					},
					() => {
						state.checked = before;
						save();
						update();
					},
				);
				return;
			}
			clearToast();
			state.checked = rest;
		}
		save();
		update();

		// Alt-checking the last open task of a titled section folds it away, a beat
		// later so the check mark shows first.
		const { sectionIndex } = rows[index];
		const view = groupViews[sectionIndex];
		if (alt && box.checked && view.toggle && view.rows.every(({ box }) => box.checked) && !state.collapsed.includes(sectionIndex)) {
			setTimeout(() => {
				if (!state || groupViews[sectionIndex] !== view || state.collapsed.includes(sectionIndex)) return;
				state.collapsed = [...state.collapsed, sectionIndex].sort((a, b) => a - b);
				save();
				update();
			}, 300);
		}
	});

	// One click selects a whole code span or copy value, ready to copy.
	function selectWhole(event) {
		const code = event.target instanceof Element && event.target.closest("code, .copy-value");
		if (!code) return;
		event.preventDefault();
		const range = document.createRange();
		range.selectNodeContents(code);
		const selection = getSelection();
		selection.removeAllRanges();
		selection.addRange(range);
	}
	els.list.addEventListener("click", selectWhole);
	els.description.addEventListener("click", selectWhole);

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

	els.toggleCopy.addEventListener("click", () => {
		state.hideCopy = !state.hideCopy;
		save();
		update();
	});

	// The display options appear on hover or keyboard focus. Tapping the button
	// opens them too, for screens without hover.
	function setMenuOpen(open) {
		els.displayMenu.classList.toggle("open", open);
		if (open) els.displayMenu.classList.remove("dismissed");
		syncDisplayButton();
	}
	// With a mouse, clicking the button hides both parts (or shows both once
	// they're all hidden). A tap, or a device without hover, opens the options.
	els.display.addEventListener("click", (event) => {
		if (!hoverable.matches || event.pointerType === "touch" || event.pointerType === "pen") {
			return setMenuOpen(!els.displayMenu.classList.contains("open"));
		}
		const hide = !state.hideDetails || !state.hideCopy;
		state.hideDetails = hide;
		state.hideCopy = hide;
		save();
		update();
	});
	hoverable.addEventListener("change", () => {
		setMenuOpen(false);
		if (state) update();
	});
	document.addEventListener("click", (event) => {
		if (!els.displayMenu.contains(event.target)) setMenuOpen(false);
	});
	// Escape closes the options even though the button keeps focus, which would
	// otherwise hold them open; they come back once focus or the pointer leaves.
	els.displayMenu.addEventListener("keydown", (event) => {
		if (event.key !== "Escape") return;
		setMenuOpen(false);
		els.displayMenu.classList.add("dismissed");
		els.display.focus();
	});
	els.displayMenu.addEventListener("focusout", (event) => {
		if (!els.displayMenu.contains(event.relatedTarget)) els.displayMenu.classList.remove("dismissed");
	});
	els.displayMenu.addEventListener("pointerleave", () => {
		if (!els.displayMenu.contains(document.activeElement)) els.displayMenu.classList.remove("dismissed");
	});

	confirmable(
		els.reset,
		"Click again to uncheck all",
		() => {
			const before = state.checked;
			undoable(
				`Unchecked ${before.length === 1 ? "1 task" : `${before.length} tasks`}`,
				() => {
					state.checked = [];
					save();
					update();
				},
				() => {
					state.checked = before;
					save();
					update();
				},
			);
		},
		() => state.checked.length > 0,
	);

	confirmable(els.del, "Click again to delete this list", () => {
		const listId = id;
		const snapshot = state;
		const restore = () => {
			if (id !== listId) return;
			clearToast();
			state = snapshot;
			save();
			render();
		};
		clearToast();
		remove();
		state = null;
		showMessage("List deleted", "It has been removed from this browser. Opening the original link again will import a fresh copy.", {
			label: "Restore",
			run: restore,
		});
		showToast("List deleted", restore);
	});

	// What goes after the Markdown, so an agent that is handed it knows what this
	// is and how to answer with an updated list. The share link is the exact list,
	// for agents that can run code; the rest is for ones that can't.
	async function agentFooter() {
		const fragment = await encodeFragment(toLinkJson());
		const base = location.origin;
		return [
			"",
			"---",
			`Listless list. To report progress, reply with an updated link: edit the list in the link below ("done": true on finished tasks, keep "id": "${id}"), or, if you can't run code, write ${base}/l/${PLAIN_PREFIX} followed by the list as URL-encoded JSON, including that id. Instructions: ${base}/`,
			`${base}/l/${fragment}`,
			"",
		].join("\n");
	}

	els.copy.addEventListener("click", async () => {
		const ok = await copyText(toMarkdown() + (await agentFooter()));
		flash(els.copy, ok ? "Copied" : "Copy failed");
	});

	// The list as it is now, in link format: current order and check marks, but
	// not view settings. It names this list's id, so a link an agent edits and
	// hands back updates this list instead of becoming a new one.
	function toLinkJson() {
		const checked = new Set(state.checked);
		let index = 0;
		const sections = state.sections.map((section) => {
			const tasks = section.tasks.map((task) => {
				const done = checked.has(index++);
				if (!task.details && !task.copy && !done) return task.text;
				return {
					text: task.text,
					...(task.details ? { details: task.details } : {}),
					...(task.copy ? { copy: task.copy } : {}),
					...(done ? { done: true } : {}),
				};
			});
			return { ...(section.title ? { title: section.title } : {}), ...(section.ordered ? { ordered: true } : {}), tasks };
		});
		const body = { v: 1, id };
		if (state.title) body.title = state.title;
		if (state.description) body.description = state.description;
		if (isSingleGroup(state)) {
			// Without headings, only the list can be ordered.
			if (tasksOrdered(state, state.sections[0])) body.ordered = true;
			body.tasks = sections[0].tasks;
		} else {
			if (state.ordered) body.ordered = true;
			body.sections = sections;
		}
		return body;
	}

	els.share.addEventListener("click", async () => {
		const fragment = await encodeFragment(toLinkJson());
		const ok = await copyText(`${location.origin}/l/${fragment}`);
		flash(els.share, ok ? "Copied" : "Copy failed");
	});

	// ---- reordering --------------------------------------------------------------

	function moveTask(sectionIndex, from, to) {
		if (from === to) return;
		const offset = state.sections.slice(0, sectionIndex).reduce((sum, section) => sum + section.tasks.length, 0);
		const section = state.sections[sectionIndex];
		const done = new Set(state.checked);
		const items = section.tasks.map((task, k) => ({ task, done: done.has(offset + k) }));
		items.splice(to, 0, ...items.splice(from, 1));
		clearToast(); // an undo would put check marks back by position, which just changed
		section.tasks = items.map((item) => item.task);
		state.checked = state.checked
			.filter((i) => i < offset || i >= offset + items.length)
			.concat(items.flatMap((item, k) => (item.done ? [offset + k] : [])))
			.sort((a, b) => a - b);
		save();
		render();
		const moved = groupViews[sectionIndex].rows[to];
		moved.li.querySelector(".handle").focus();
		els.announce.textContent = `Moved to position ${to + 1} of ${items.length}`;
	}

	function rowPosition(handle) {
		const li = handle.closest(".task");
		const view = groupViews.find((v) => v.rows.some((row) => row.li === li));
		return { sectionIndex: groupViews.indexOf(view), view, from: view.rows.findIndex((row) => row.li === li) };
	}

	els.list.addEventListener("keydown", (event) => {
		const handle = event.target instanceof Element && event.target.closest(".handle");
		if (!handle || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
		event.preventDefault();
		const { sectionIndex, view, from } = rowPosition(handle);
		// Step to the nearest row that's showing, so a hidden one isn't moved past unseen.
		const step = event.key === "ArrowUp" ? -1 : 1;
		let to = from + step;
		while (view.rows[to]?.li.hidden) to += step;
		if (!view.rows[to]) return;
		moveTask(sectionIndex, from, to);
	});

	// Dragging only transforms rows; the DOM changes once, on release.
	els.list.addEventListener("pointerdown", (event) => {
		const handle = event.target instanceof Element && event.target.closest(".handle");
		if (!handle || (event.pointerType === "mouse" && event.button !== 0)) return;
		// Preventing the default stops text selection while dragging, but also stops
		// the click from focusing the handle, so focus it here for the arrow keys.
		event.preventDefault();
		handle.focus();
		const { sectionIndex, view, from } = rowPosition(handle);
		const visible = view.rows.filter(({ li }) => !li.hidden);
		const self = visible.findIndex((row) => row === view.rows[from]);
		// Mark the rows before measuring them: .shifting snaps a peeked-open drawer
		// shut, so the measurements match the layout the drag will move through.
		for (const { li } of visible) li.classList.add("shifting");
		const rects = visible.map(({ li }) => li.getBoundingClientRect());
		const gap = rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 8;
		const shift = rects[self].height + gap;
		const startY = event.clientY;
		let target = self;

		handle.setPointerCapture(event.pointerId);
		const dragged = visible[self].li;
		dragged.classList.add("dragging");

		const place = () => {
			visible.forEach(({ li }, k) => {
				if (k === self) return;
				const moves = (self < target && k > self && k <= target) ? -shift : (self > target && k >= target && k < self) ? shift : 0;
				li.style.transform = moves ? `translateY(${moves}px)` : "";
			});
		};
		const onMove = (e) => {
			const dy = e.clientY - startY;
			dragged.style.transform = `translateY(${dy}px)`;
			const center = rects[self].top + rects[self].height / 2 + dy;
			target = rects.reduce((count, rect, k) => (k !== self && rect.top + rect.height / 2 < center ? count + 1 : count), 0);
			place();
		};
		const finish = (commit) => {
			handle.removeEventListener("pointermove", onMove);
			handle.removeEventListener("pointerup", onUp);
			handle.removeEventListener("pointercancel", onCancel);
			for (const { li } of visible) {
				li.classList.remove("shifting");
				li.style.transform = "";
			}
			dragged.classList.remove("dragging");
			if (commit && target !== self) moveTask(sectionIndex, from, view.rows.indexOf(visible[target]));
		};
		const onUp = () => finish(true);
		const onCancel = () => finish(false);
		handle.addEventListener("pointermove", onMove);
		handle.addEventListener("pointerup", onUp);
		handle.addEventListener("pointercancel", onCancel);
	});

	function toMarkdown() {
		const checked = new Set(state.checked);
		const oneLine = (text) => text.replace(/\s*\n\s*/g, " ");
		const lines = [`# ${oneLine(displayTitle())}`];
		if (state.description) lines.push("", ...state.description.split("\n").map((line) => line.trim()));
		let index = 0;
		for (const section of state.sections) {
			lines.push("");
			if (section.title) lines.push(`## ${oneLine(section.title)}`, "");
			const sequential = tasksOrdered(state, section);
			section.tasks.forEach((task, k) => {
				const marker = sequential ? `${k + 1}.` : "-";
				const indent = " ".repeat(marker.length + 1);
				lines.push(`${marker} [${checked.has(index) ? "x" : " "}] ${oneLine(task.text)}`);
				if (task.details) {
					for (const line of task.details.split("\n")) lines.push(indent + line.trim());
				}
				for (const { label: name, value } of copyItems(task.copy)) {
					// A fence or span longer than any backtick run in the value can't be closed early by it.
					const ticks = (min) => "`".repeat(Math.max(min, ...(value.match(/`+/g) || []).map((run) => run.length + 1)));
					const prefix = name ? `${oneLine(name)}: ` : "";
					if (/[`\n]/.test(value)) {
						const fence = ticks(3);
						if (prefix) lines.push(indent + prefix.trim());
						lines.push(indent + fence, ...value.split("\n").map((line) => indent + line), indent + fence);
					} else {
						lines.push(indent + prefix + "`" + value + "`");
					}
				}
				index++;
			});
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
		if (!els.index.hidden) {
			if (event.key === null || event.key.startsWith(STORAGE_PREFIX)) {
				clearToast();
				redrawIndex();
			}
			return;
		}
		if (!id || event.key !== storageKey(id)) return;
		clearToast(); // another tab changed this list, so an undo here could clobber that
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

	// Tasks are matched by their content, since the saved copy may have been
	// reordered.
	function taskKey(task) {
		return task.text + "\0" + task.details + "\0" + JSON.stringify(task.copy || "");
	}

	// Whether two lists say the same thing. Tasks that can be reordered may be in
	// a different order; the steps of an ordered section may not.
	function sameContent(a, b) {
		const shape = (list) =>
			JSON.stringify([
				list.title,
				list.description,
				list.ordered,
				list.sections.map((section) => {
					const keys = section.tasks.map(taskKey);
					return [section.title, section.ordered === true, tasksOrdered(list, section) ? keys : keys.sort()];
				}),
			]);
		return shape(a) === shape(b);
	}

	// The saved copy wins when a link opens a list this browser already has. If
	// the link marks tasks done that the saved copy hasn't checked, offer them,
	// on top of the ones it has. Tasks are matched by section and content.
	function offerLinkChecks(list) {
		const pending = state.sections.map((section) => {
			const queues = new Map();
			return { section, queues, add: (k, i) => queues.set(k, [...(queues.get(k) || []), i]) };
		});
		let index = 0;
		pending.forEach(({ section, add }) => section.tasks.forEach((task) => add(taskKey(task), index++)));

		let linkIndex = 0;
		const wanted = new Set(list.initialChecked);
		let mapped = [];
		list.sections.forEach((section, s) => {
			for (const task of section.tasks) {
				if (wanted.has(linkIndex++)) {
					const match = pending[s]?.queues.get(taskKey(task))?.shift();
					if (match !== undefined) mapped.push(match);
				}
			}
		});
		mapped.sort((a, b) => a - b);
		mapped = validChecks(state, mapped);

		const have = new Set(state.checked);
		if (mapped.every((i) => have.has(i))) return;
		showNotice("This link has check marks your saved copy doesn't.", {
			label: "Use the link's check marks",
			run: () => {
				state.checked = validChecks(state, [...new Set([...state.checked, ...mapped])].sort((a, b) => a - b));
				save();
				update();
			},
		});
	}

	// A link that names a list this browser has, but says something different: an
	// agent edited a share link and handed it back. As with check marks, the saved
	// copy stays as it is until the user takes the new version. It brings the
	// link's check marks, and keeps the user's on tasks it still has.
	function offerLinkVersion(list) {
		if (sameContent(state, list)) return offerLinkChecks(list);

		showNotice("This link has a different version of this list.", {
			label: "Use this version",
			run: () => {
				const queues = new Map();
				let index = 0;
				for (const section of list.sections) {
					for (const task of section.tasks) {
						const key = taskKey(task);
						queues.set(key, [...(queues.get(key) || []), index++]);
					}
				}
				const have = new Set(state.checked);
				const kept = [];
				index = 0;
				for (const section of state.sections) {
					for (const task of section.tasks) {
						if (!have.has(index++)) continue;
						const match = queues.get(taskKey(task))?.shift();
						if (match !== undefined) kept.push(match);
					}
				}
				const next = {
					title: list.title,
					description: list.description,
					ordered: list.ordered,
					sections: list.sections,
					checked: validChecks(list, [...new Set([...kept, ...list.initialChecked])].sort((a, b) => a - b)),
					collapsed: state.collapsed.filter((i) => list.sections[i]?.title && list.sections[i].title === state.sections[i]?.title),
				};
				const before = Object.fromEntries(Object.keys(next).map((name) => [name, state[name]]));
				const apply = (values) => {
					Object.assign(state, values);
					save();
					render();
				};
				undoable("Updated this list from the link", () => apply(next), () => apply(before));
			},
		});
	}

	async function start() {
		// A notice, an armed button or an undo belongs to the list that raised it;
		// none of them may outlive that list.
		els.notice.hidden = true;
		els.notice.replaceChildren();
		disarm();
		clearToast();
		persistent = storageAvailable();

		if (isLinkHash(location.hash)) {
			let decoded;
			try {
				decoded = await decodeFragment(location.hash);
			} catch {
				decoded = null;
			}
			if (!decoded) {
				showMessage("This link is damaged", "The list in this link couldn't be read. It may have been cut off when it was copied. Ask the agent for the link again.");
				return;
			}

			const { linkId, ...list } = decoded;
			id = linkId || (await listId(list));
			const saved = persistent ? load(id) : null;
			state = saved || freshState(list);

			if (persistent) {
				save();
				// Swap the long link for a short one; the list now lives here.
				history.replaceState(null, "", "/l/" + id);
			} else {
				showNotice("Your browser isn't letting this page save. Keep the original link; checks will be lost when you close it.");
			}
			render();
			if (saved) (linkId ? offerLinkVersion : offerLinkChecks)(list);
			return;
		}

		const match = location.pathname.match(/^\/l\/([A-Za-z0-9_-]+)$/);
		if (!match) {
			if (location.pathname === "/l/" && persistent && showIndex()) return;
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
		if (isLinkHash(location.hash)) start();
	});

	start();
})();
