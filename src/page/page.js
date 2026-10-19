"use strict";

// Listless page. Everything here runs locally: the list arrives in the URL
// fragment (never sent to the server), is saved to localStorage, and the
// Content-Security-Policy forbids this page from making any network request.

(() => {
	const STORAGE_PREFIX = "listless:";
	const FORMAT_PREFIX = "#v1.";
	const ID_LENGTH = 12;
	const MAX_TASKS = 500;
	const MAX_TASK_LENGTH = 1000;
	const MAX_TITLE_LENGTH = 200;

	const $ = (id) => document.getElementById(id);
	const els = {
		bar: document.querySelector(".bar"),
		title: $("title"),
		progressText: $("progress-text"),
		progressFill: $("progress-fill"),
		copy: $("copy"),
		toggleDone: $("toggle-done"),
		reset: $("reset"),
		del: $("delete"),
		notice: $("notice"),
		tasks: $("tasks"),
		allDone: $("all-done"),
		message: $("message"),
		messageTitle: $("message-title"),
		messageBody: $("message-body"),
	};

	let id = null;
	let state = null; // { title, tasks, checked: number[], hideCompleted, createdAt }
	let persistent = true;

	// ---- storage -------------------------------------------------------------

	function storageKey(listId) {
		return STORAGE_PREFIX + listId;
	}

	function load(listId) {
		try {
			const raw = localStorage.getItem(storageKey(listId));
			return raw ? normalizeStored(JSON.parse(raw)) : null;
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

	function normalizeStored(value) {
		const list = validateList(value);
		if (!list) return null;
		const checked = Array.isArray(value.checked)
			? [...new Set(value.checked.filter((i) => Number.isInteger(i) && i >= 0 && i < list.tasks.length))]
			: [];
		return {
			title: list.title,
			tasks: list.tasks,
			checked,
			hideCompleted: value.hideCompleted === true,
			createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
		};
	}

	// ---- decoding --------------------------------------------------------------

	function validateList(value) {
		if (typeof value !== "object" || value === null) return null;
		const { title, tasks } = value;
		if (title !== undefined && typeof title !== "string") return null;
		if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > MAX_TASKS) return null;
		const cleaned = [];
		for (const task of tasks) {
			if (typeof task !== "string" || task.trim() === "") return null;
			cleaned.push(task.trim().slice(0, MAX_TASK_LENGTH));
		}
		const cleanTitle = (title || "").trim().slice(0, MAX_TITLE_LENGTH);
		return { title: cleanTitle, tasks: cleaned };
	}

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
		return validateList(JSON.parse(text));
	}

	// The ID is derived from the list's content, so reopening the same link
	// finds the same saved list (and its checks) instead of creating a copy.
	async function listId(list) {
		const canonical = JSON.stringify({ title: list.title, tasks: list.tasks });
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
		return toBase64Url(new Uint8Array(digest)).slice(0, ID_LENGTH);
	}

	// ---- rendering -------------------------------------------------------------

	function displayTitle() {
		return state.title || "Checklist";
	}

	function render() {
		els.message.hidden = true;
		els.bar.hidden = false;
		els.tasks.hidden = false;
		els.title.textContent = displayTitle();
		document.title = displayTitle() + " · Listless";

		const checked = new Set(state.checked);
		const items = state.tasks.map((task, index) => {
			const li = document.createElement("li");
			const label = document.createElement("label");
			const box = document.createElement("input");
			const text = document.createElement("span");
			box.type = "checkbox";
			box.checked = checked.has(index);
			box.dataset.index = String(index);
			text.className = "text";
			text.textContent = task;
			label.append(box, text);
			li.append(label);
			li.classList.toggle("done", box.checked);
			return li;
		});
		els.tasks.replaceChildren(...items);
		updateSummary();
	}

	function updateSummary() {
		const done = state.checked.length;
		const total = state.tasks.length;
		els.progressText.textContent = `${done} of ${total} done`;
		els.progressFill.style.transform = `scaleX(${total ? done / total : 0})`;
		els.tasks.classList.toggle("hide-done", state.hideCompleted);
		els.toggleDone.setAttribute("aria-pressed", String(state.hideCompleted));
		els.toggleDone.textContent = state.hideCompleted ? "Show completed" : "Hide completed";
		els.allDone.hidden = !(done === total && total > 0);
	}

	function showMessage(title, body) {
		els.bar.hidden = true;
		els.tasks.hidden = true;
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

	els.tasks.addEventListener("change", (event) => {
		const box = event.target;
		if (!(box instanceof HTMLInputElement)) return;
		const index = Number(box.dataset.index);
		const checked = new Set(state.checked);
		if (box.checked) checked.add(index);
		else checked.delete(index);
		state.checked = [...checked].sort((a, b) => a - b);
		box.closest("li").classList.toggle("done", box.checked);
		save();
		updateSummary();
	});

	els.toggleDone.addEventListener("click", () => {
		state.hideCompleted = !state.hideCompleted;
		save();
		updateSummary();
	});

	els.reset.addEventListener("click", () => {
		if (state.checked.length === 0) return;
		if (!confirm("Uncheck every task?")) return;
		state.checked = [];
		save();
		render();
	});

	els.del.addEventListener("click", () => {
		if (!confirm("Delete this list from this browser? This can't be undone, but the original link can import it again.")) return;
		remove();
		state = null;
		showMessage("List deleted", "It has been removed from this browser. Opening the original link again will import a fresh copy.");
	});

	els.copy.addEventListener("click", async () => {
		const checked = new Set(state.checked);
		const lines = [`# ${displayTitle()}`, ""];
		state.tasks.forEach((task, index) => {
			lines.push(`- [${checked.has(index) ? "x" : " "}] ${task.replace(/\s*\n\s*/g, " ")}`);
		});
		const ok = await copyText(lines.join("\n") + "\n");
		flash(els.copy, ok ? "Copied" : "Copy failed");
	});

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
		const original = button.dataset.label || button.textContent;
		button.dataset.label = original;
		button.textContent = text;
		clearTimeout(Number(button.dataset.timer));
		button.dataset.timer = String(setTimeout(() => (button.textContent = original), 1500));
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
			state = (persistent && load(id)) || {
				title: list.title,
				tasks: list.tasks,
				checked: [],
				hideCompleted: false,
				createdAt: new Date().toISOString(),
			};

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
