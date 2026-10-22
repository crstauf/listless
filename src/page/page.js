"use strict";

// Listless page. Everything here runs locally: the list arrives in the URL
// fragment (never sent to the server), is saved to localStorage, and the
// Content-Security-Policy forbids this page from making any network request.

(() => {
	const STORAGE_PREFIX = "listless:";
	const FORMAT_PREFIX = "#v1.";
	const ID_LENGTH = 12;
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
	// state: { title, description, ordered, sections: [{ title, tasks: [{ text, details, copy? }] }],
	//          checked: number[], hideCompleted, hideUpcoming, hideDetails, hideCopy, createdAt }
	// Task numbers in `checked` count across all sections, in order.
	let state = null;
	let rows = []; // one { li, box } per task, in the same order
	let groupViews = []; // one { group, rows, count } per section

	// ---- list format -----------------------------------------------------------

	const clip = (text, max) => text.trim().slice(0, max);

	function normalizeTask(task) {
		if (typeof task === "string" && task.trim()) return { text: clip(task, LIMITS.maxTaskLength), details: "", copy: "", done: false };
		if (task && typeof task === "object" && typeof task.text === "string" && task.text.trim()) {
			const details = typeof task.details === "string" ? clip(task.details, LIMITS.maxDetailsLength) : "";
			const copy = typeof task.copy === "string" ? clip(task.copy, LIMITS.maxCopyLength) : "";
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
				return tasks && { title, tasks };
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
		for (const section of sections) {
			for (const task of section.tasks) {
				if (task.done) initialChecked.push(index);
				index++;
			}
			section.tasks = section.tasks.map(({ text, details, copy }) => ({ text, details, ...(copy ? { copy } : {}) }));
		}
		if (ordered) initialChecked = leadingRun(initialChecked);

		return {
			title: clip(value.title || "", LIMITS.maxTitleLength),
			description: clip(value.description || "", LIMITS.maxDescriptionLength),
			ordered,
			sections,
			initialChecked,
		};
	}

	// Ordered lists are always completed from the top: keep only the unbroken
	// run of checks from the first task.
	function leadingRun(checked) {
		return checked.filter((i, position) => i === position);
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
		if (list.ordered) checked = leadingRun(checked);
		return {
			...list,
			checked,
			hideCompleted: value.hideCompleted === true,
			hideUpcoming: value.hideUpcoming === true,
			hideDetails: value.hideDetails === true,
			hideCopy: value.hideCopy === true,
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

	async function encodeFragment(value) {
		const json = new TextEncoder().encode(JSON.stringify(value));
		const stream = new Blob([json]).stream().pipeThrough(new CompressionStream("deflate-raw"));
		return FORMAT_PREFIX + toBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
	}

	// The ID is derived from the list's content, so reopening the same link
	// finds the same saved list (and its checks) instead of creating a copy.
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

		els.toggleUpcoming.hidden = !state.ordered;
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
				renderInline(heading, section.title);
				head.append(heading, count);
				group.append(head);
				group.dataset.hasHead = "true";
			}

			const list = el(state.ordered ? "ol" : "ul", "tasks");
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
				if (state.ordered) {
					const step = el("span", "step");
					step.textContent = `Step ${index + 1}`;
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
				if (task.copy) {
					const value = el("span", "copy-value");
					const button = el("button", "icon");
					const copy = el("div", "copy");
					drawer = el("div", "drawer");
					value.id = `task-${index}-copy`;
					value.textContent = task.copy;
					button.type = "button";
					button.setAttribute("aria-label", "Copy value");
					button.title = "Copy value";
					button.append(copyIcon());
					button.addEventListener("click", async () => {
						flash(button, (await copyText(task.copy)) ? "Copied" : "Copy failed");
					});
					copy.append(value, button);
					drawer.append(copy);
				}
				label.append(box, checkmark());
				card.append(label, body);
				li.append(card);
				if (drawer) li.append(drawer);
				list.append(li);
				if (!state.ordered) card.append(dragHandle(task.text));
				const row = {
					li,
					box,
					sectionIndex,
					detailsId: task.details ? `task-${index}-details` : "",
					copyId: task.copy ? `task-${index}-copy` : "",
				};
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

		rows.forEach(({ li, box, detailsId, copyId }, index) => {
			const isDone = checked.has(index);
			const upcoming = state.ordered && !isDone && index !== current;
			box.checked = isDone;
			box.disabled = upcoming;
			li.classList.toggle("done", isDone);
			li.classList.toggle("current", state.ordered && index === current);
			li.classList.toggle("upcoming", upcoming);
			const hide = (isDone && state.hideCompleted) || (upcoming && state.hideUpcoming);
			li.hidden = hide;
			// Hidden details and copy values (and a done task's) aren't read out either.
			const described = [state.hideDetails ? "" : detailsId, state.hideCopy || isDone ? "" : copyId].filter(Boolean).join(" ");
			if (described) box.setAttribute("aria-describedby", described);
			else box.removeAttribute("aria-describedby");
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

	els.list.addEventListener("change", (event) => {
		const box = event.target;
		if (!(box instanceof HTMLInputElement)) return;
		const index = Number(box.dataset.index);
		const row = box.closest(".task");
		if (armed && armed.target !== row) disarm();

		if (box.checked) {
			clearToast();
			state.checked = [...new Set([...state.checked, index])].sort((a, b) => a - b);
		} else if (state.ordered) {
			// Unchecking a step reopens it and everything after it, so it asks first:
			// the step is armed, and unchecking it again goes ahead.
			const later = state.checked.filter((i) => i > index).length;
			if (later > 0) {
				if (armed?.target !== row) {
					const prompt = `Uncheck again to reopen this step and the ${later === 1 ? "step" : `${later} steps`} after it`;
					box.checked = true;
					row.classList.add("armed");
					arm(row, prompt, () => row.classList.remove("armed"));
					return;
				}
				disarm();
				const before = state.checked;
				undoable(
					`Reopened this step and the ${later === 1 ? "step" : `${later} steps`} after it`,
					() => {
						state.checked = before.filter((i) => i < index);
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
			state.checked = state.checked.filter((i) => i < index);
		} else {
			clearToast();
			state.checked = state.checked.filter((i) => i !== index);
		}
		save();
		update();
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

	els.copy.addEventListener("click", async () => {
		const ok = await copyText(toMarkdown());
		flash(els.copy, ok ? "Copied" : "Copy failed");
	});

	// The list as it is now, in link format: current order and check marks, but
	// not view settings.
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
			return { ...(section.title ? { title: section.title } : {}), tasks };
		});
		const body = { v: 1 };
		if (state.title) body.title = state.title;
		if (state.description) body.description = state.description;
		if (state.ordered) body.ordered = true;
		if (sections.length === 1 && !state.sections[0].title) body.tasks = sections[0].tasks;
		else body.sections = sections;
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
		const to = from + (event.key === "ArrowUp" ? -1 : 1);
		if (to < 0 || to >= view.rows.length) return;
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
			for (const task of section.tasks) {
				const marker = state.ordered ? `${index + 1}.` : "-";
				const indent = " ".repeat(marker.length + 1);
				lines.push(`${marker} [${checked.has(index) ? "x" : " "}] ${oneLine(task.text)}`);
				if (task.details) {
					for (const line of task.details.split("\n")) lines.push(indent + line.trim());
				}
				if (task.copy) {
					// A fence or span longer than any backtick run in the value can't be closed early by it.
					const ticks = (min) => "`".repeat(Math.max(min, ...(task.copy.match(/`+/g) || []).map((run) => run.length + 1)));
					if (/[`\n]/.test(task.copy)) {
						const fence = ticks(3);
						lines.push(indent + fence, ...task.copy.split("\n").map((line) => indent + line), indent + fence);
					} else {
						lines.push(indent + "`" + task.copy + "`");
					}
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

	// The saved copy wins when a link opens a list this browser already has. If
	// the link marks tasks done that the saved copy hasn't checked, offer them.
	// Tasks are matched by section and content, since the saved copy may have
	// been reordered.
	function offerLinkChecks(list) {
		const key = (task) => task.text + "\0" + task.details + "\0" + (task.copy || "");
		const pending = state.sections.map((section) => {
			const queues = new Map();
			return { section, queues, add: (k, i) => queues.set(k, [...(queues.get(k) || []), i]) };
		});
		let index = 0;
		pending.forEach(({ section, add }) => section.tasks.forEach((task) => add(key(task), index++)));

		let linkIndex = 0;
		const wanted = new Set(list.initialChecked);
		let mapped = [];
		list.sections.forEach((section, s) => {
			for (const task of section.tasks) {
				if (wanted.has(linkIndex++)) {
					const match = pending[s]?.queues.get(key(task))?.shift();
					if (match !== undefined) mapped.push(match);
				}
			}
		});
		mapped.sort((a, b) => a - b);
		if (state.ordered) mapped = leadingRun(mapped);

		const have = new Set(state.checked);
		if (mapped.every((i) => have.has(i))) return;
		showNotice("This link has check marks your saved copy doesn't.", {
			label: "Use the link's check marks",
			run: () => {
				state.checked = mapped;
				save();
				update();
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
			if (saved) offerLinkChecks(list);
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
		if (location.hash.startsWith(FORMAT_PREFIX)) start();
	});

	start();
})();
