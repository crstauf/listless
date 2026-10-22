# Listless

Turn a list of tasks into a checklist page that lives only in your browser.

Give an agent a wall of text, let it pull out the tasks, and get back a link to a clean checklist: one checkbox per task. It works at any screen size and follows your system's light or dark setting.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/preview-dark.png">
  <img src="docs/preview-light.png" width="800" alt="A Listless checklist titled “Release v2.4”, with a description linking to the release thread. Step 1 is checked off, step 2, “Publish to npm”, is highlighted as up next, and step 3 is locked until it’s done. A row of toolbar buttons sits at the top right.">
</picture>

## No off-site storage: everything is local

- Lists, check marks and preferences are stored **only in the browser that opens the link** (`localStorage`).
- Nothing is stored anywhere else: not on the Worker, not in KV, D1, R2 or Durable Objects, not in logs, not in a cache, and not with any third party.
- There are no accounts and no syncing.
- The page's Content-Security-Policy forbids it from making **any** network request, so your browser itself enforces that nothing leaves the page.
- Deleting a list, or clearing this site's data, removes it for good. Opening the original link again imports a fresh copy.

## How it works

1. An agent builds a link that carries the list after the `#`:

   ```
   https://<host>/l/#v1.<data>
   ```

   `<data>` is `base64url(deflate-raw(JSON))`, and the JSON is a list such as `{"v":1,"title":"…","tasks":["…","…"]}` (see [List format](#list-format)). Browsers never send the part after `#` to a server.

2. You open the link. The page reads the list from the address, saves it in your browser, and swaps the address for a short one: `https://<host>/l/<id>`. The id is a hash of the list's contents, so opening the same original link again finds the same list and keeps your check marks and any reordering, because the id is fixed when you first open the list. Check marks never affect it, but a link whose tasks are in a different order (such as a share link from a list someone reordered) is a different list. If the link marks tasks done that your saved copy hasn't checked, the page tells you and offers to use the link's check marks; your saved copy is never changed without you asking.

3. You check things off. Everything is saved in your browser as you go. Opening `https://<host>/l/` lists every list saved in this browser, with its progress, so you can find one again or delete it.

The page shows progress overall and per section. In unordered lists, tasks can be reordered within their section by dragging the handle beside them, or with the arrow keys when it's focused. Its toolbar has **Copy as Markdown** (to paste your progress back to an agent), **Copy share link** (a full link carrying the list as it is now, with its order and check marks; building it happens in your browser and sends nothing), **Hide completed**, **Hide upcoming** (ordered lists), a **Display** button (hover it, or tap it, for **Hide details** and **Hide copy text**), **Uncheck all**, and **Delete**. Those last two, and unchecking an ordered step that has later steps checked, don't use pop-up dialogs: the first click turns the control red with a check mark, and a second click goes ahead (clicking anywhere else, pressing Escape, or waiting a few seconds cancels). Afterwards, an **Undo** button (or Ctrl/⌘+Z) brings the change back until you change something else; a deleted list can be restored the same way. Only the checkbox toggles a task, so the text can be selected like any other text. Web addresses in it are links, and clicking a code span or a copy value selects all of it, ready to copy.

## List format

```json
{
  "v": 1,
  "title": "Ship the release",
  "description": "From https://claude.ai/chat/…",
  "ordered": true,
  "sections": [
    { "title": "Prepare", "tasks": ["Review the PR", { "text": "Bump the version", "details": "Edit `package.json`." }, { "text": "Email Dana the invoice", "copy": "dana@example.com" }] },
    { "title": "Release", "tasks": ["Merge to `main`", "Run `npm publish`"] }
  ]
}
```

- **`title`**: optional.
- **`description`**: optional. It's shown under the title, which makes it a good place for a link back to the conversation the list came from.
- **`ordered`**: optional. When `true`, tasks are done in sequence: only the next unfinished task can be checked off, and the ones after it stay locked. Unchecking a step reopens it and every step after it.
- **`tasks`**: an array of tasks. A task is a string, or `{ "text", "details", "copy", "done" }` when it needs extra explanation, a value to paste elsewhere, or is already complete. Details show in smaller, muted text, and the reader can hide them. `copy` is one value (an email address, an order number, a confirmation code) shown exactly as written in its own box, selected whole with one click, with a copy button beside it; it stays visible when details are hidden. Add `"done": true` to a task that is already complete and it starts out checked off (in an ordered list, done tasks must come before all others).
- **`sections`**: use this instead of `tasks` to group tasks under headings.
- **Text** is plain, with two exceptions: `` `backtick` `` spans show as code, and web addresses (`http://` or `https://`) in task text, details and the description become links. Only the checkbox toggles a task, so clicking text, code or a link never checks it off.

## For agents

`GET /` on any Listless host returns plain-text instructions written for agents. In short, there are two ways to make a link:

**Build it locally (preferred).** Nothing is sent anywhere:

```sh
echo '{"title":"Groceries","tasks":["Milk","Eggs"]}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("https://<host>/l/#v1."+require("zlib").deflateRawSync(JSON.stringify({v:1,...JSON.parse(s)})).toString("base64url")))'
```

`GET /` also includes a Python version.

**Or POST it.** This is the only time the Worker sees the tasks. It compresses them into the link and keeps nothing:

```sh
curl -s -X POST https://<host>/api/lists \
  -H 'content-type: application/json' \
  -d '{"title":"Groceries","tasks":["Milk","Eggs"]}'
# {"url":"https://<host>/l/#v1.…"}
```

Limits:
- Up to 500 tasks in total, and up to 50 sections.
- Task text up to 1,000 characters, details up to 2,000, and a copy value up to 500.
- List and section titles up to 200 characters.
- Description up to 2,000 characters.
- POST bodies up to 256 KB.

## Network traffic, exactly

| Situation | Requests |
|---|---|
| Opening a locally built link | One `GET /l/` for the page, which contains no task data. Nothing after that. |
| Using `POST /api/lists` | One `POST` with the tasks; the response is the link. Nothing is stored or logged. |
| Reopening `/l/<id>` | One `GET` for the page. The list stays in your browser. |
| Copy share link | None. The link is built in your browser and copied to the clipboard; opening it somewhere else is the same as opening any other link. |
| Clicking a link in a list | The linked site opens in a new tab, with no referrer, so it doesn't learn which list you came from. Nothing happens until you click. |

## How to verify

You don't have to take this README's word for it:

1. **View the page source.** The `<meta http-equiv="Content-Security-Policy">` tag includes `default-src 'none'` and `connect-src 'none'`. Together they block every fetch, XHR, WebSocket, beacon, form submission and external resource. The same policy is sent as a response header.
2. **Watch the Network tab** in your browser's developer tools while you open a list and check things off. After the page loads, there are no requests, unless you click a link in the list, which opens in a new tab.
3. **Read the code.** The whole page is [`src/page/`](src/page/), and the Worker is [`src/index.ts`](src/index.ts). The tests check that the policy forbids network access, that its hashes match the page's only inline script and style, and that the Worker has no storage bindings.
4. **Check the deploy.** The hosted Worker is deployed only by [this repository's workflow](.github/workflows/deploy.yml) from `master`, and Workers logging is turned off in [`wrangler.jsonc`](wrangler.jsonc).

Or run it yourself (see below).

## Run it yourself

Requires Node.js 24 or newer.

```sh
npm ci
npm run dev        # http://localhost:8787
```

Under `wrangler dev`, everything stays on your machine.

To deploy to your own Cloudflare account:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/crstauf/listless)

Or run `npx wrangler login && npm run deploy`. No KV namespaces or other resources are needed.

## Development

```sh
npm run build      # rebuild src/page.generated.ts from src/page/
npm run typecheck
npm test           # the Worker: headers, CSP, API
npm run test:page  # the page, driven in Chromium (npx playwright install chromium, once)
```

The page source lives in `src/page/` (`page.html`, `page.css`, `page.js`). `npm run build` inlines the CSS and JS into the HTML, computes the SHA-256 hashes the Content-Security-Policy needs, and writes `src/page.generated.ts`. That file is committed so the deployed page can be reviewed in the repository. CI rebuilds it and fails if it differs.

After changing how the page looks, run `npm run screenshots` to recapture the README preview (`docs/preview-light.png` and `docs/preview-dark.png`). It needs Playwright's Chromium, which you can install once with `npx playwright install chromium`. No server is needed.

### Deploying from GitHub Actions

Two workflows live in `.github/workflows/`. `check.yml` runs the checks on every pull request and has no access to secrets. `deploy.yml` runs on pushes to `master`: it calls `check.yml` first, then deploys. The deploy needs two repository (or `production` environment) secrets:

- `CLOUDFLARE_API_TOKEN`: an API token with the **Workers Scripts: Edit** permission
- `CLOUDFLARE_ACCOUNT_ID`

## License

[MIT](LICENSE)
