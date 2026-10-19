# Listless

Turn a list of tasks into a checklist page that lives only in your browser.

Give an agent a wall of text, let it pull out the tasks, and get back a link to a clean checklist: one checkbox per task. It works at any screen size and follows your system's light or dark setting.

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

2. You open the link. The page reads the list from the address, saves it in your browser, and swaps the address for a short one: `https://<host>/l/<id>`. The id is a hash of the list's contents, so opening the same original link again finds the same list and keeps your check marks.

3. You check things off. Everything is saved in your browser as you go.

The page shows progress overall and per section. Its toolbar has **Copy as Markdown** (to paste your progress back to an agent), **Hide completed**, **Hide upcoming** (ordered lists), **Hide details**, **Uncheck all**, and **Delete**. Clicking a code span selects all of it, ready to copy.

## List format

```json
{
  "v": 1,
  "title": "Ship the release",
  "ordered": true,
  "sections": [
    { "title": "Prepare", "tasks": ["Review the PR", { "text": "Bump the version", "details": "Edit `package.json`." }] },
    { "title": "Release", "tasks": ["Merge to `main`", "Run `npm publish`"] }
  ]
}
```

- **`title`**: optional.
- **`ordered`**: optional. When `true`, tasks are done in sequence: only the next unfinished task can be checked off, and the ones after it stay locked. Unchecking a step reopens it and every step after it.
- **`tasks`**: an array of tasks. A task is a string, or `{ "text", "details" }` when it needs extra explanation. Details show in smaller, muted text, and the reader can hide them.
- **`sections`**: use this instead of `tasks` to group tasks under headings.
- **Code:** text is plain, except that `` `backtick` `` spans show as code.

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
- Task text up to 1,000 characters, and details up to 2,000.
- List and section titles up to 200 characters.
- POST bodies up to 256 KB.

## Network traffic, exactly

| Situation | Requests |
|---|---|
| Opening a locally built link | One `GET /l/` for the page, which contains no task data. Nothing after that. |
| Using `POST /api/lists` | One `POST` with the tasks; the response is the link. Nothing is stored or logged. |
| Reopening `/l/<id>` | One `GET` for the page. The list stays in your browser. |

## How to verify

You don't have to take this README's word for it:

1. **View the page source.** The `<meta http-equiv="Content-Security-Policy">` tag includes `default-src 'none'` and `connect-src 'none'`. Together they block every fetch, XHR, WebSocket, beacon, form submission and external resource. The same policy is sent as a response header.
2. **Watch the Network tab** in your browser's developer tools while you open a list and check things off. After the page loads, there are no requests.
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
npm test
```

The page source lives in `src/page/` (`page.html`, `page.css`, `page.js`). `npm run build` inlines the CSS and JS into the HTML, computes the SHA-256 hashes the Content-Security-Policy needs, and writes `src/page.generated.ts`. That file is committed so the deployed page can be reviewed in the repository. CI rebuilds it and fails if it differs.

### Deploying from GitHub Actions

`.github/workflows/deploy.yml` runs the checks on every push and pull request, and deploys on pushes to `master`. It needs two repository (or `production` environment) secrets:

- `CLOUDFLARE_API_TOKEN`: an API token with the **Workers Scripts: Edit** permission
- `CLOUDFLARE_ACCOUNT_ID`

## License

[MIT](LICENSE)
