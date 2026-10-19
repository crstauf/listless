import { LIMITS } from "./link";

// Plain-text usage docs served at GET /. Written for agents first, people second.
export function docs(origin: string): string {
	return `# Listless

Turn a list of tasks into a checklist page that lives only in the user's browser.

## No off-site storage: everything is local

- Lists, check marks and preferences are stored only in the browser that
  opens the link (localStorage). Nothing is stored anywhere else: not on this
  Worker, not in any database or cache, not in logs, and not with any third
  party. There are no accounts and no syncing.
- Deleting a list, or clearing this site's data in the browser, removes it
  for good. Opening the original link again imports a fresh copy.
- The checklist page's Content-Security-Policy forbids it from making any
  network request, so the browser itself guarantees nothing is sent anywhere.

## Making a link

A link looks like:

    ${origin}/l/#v1.<data>

<data> is the list, compressed and encoded:

    base64url( deflate-raw( UTF-8 JSON ) )   # base64url without "=" padding

and the JSON is:

    {"v": 1, "title": "Optional title", "tasks": ["First task", "Second task"]}

The list sits after "#", which browsers never send to a server. When the page
opens, it saves the list in the browser and shortens the address to
${origin}/l/<id>.

### Option 1 (preferred): build the link yourself

Nothing is sent anywhere. Pipe the JSON (title and tasks) into either command.

Python:

    echo '{"title":"Groceries","tasks":["Milk","Eggs"]}' | python3 -c 'import base64,json,sys,zlib; c=zlib.compressobj(9,zlib.DEFLATED,-15); d=json.dumps({"v":1,**json.load(sys.stdin)},separators=(",",":")).encode(); print("${origin}/l/#v1."+base64.urlsafe_b64encode(c.compress(d)+c.flush()).decode().rstrip("="))'

Node.js:

    echo '{"title":"Groceries","tasks":["Milk","Eggs"]}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log("${origin}/l/#v1."+require("zlib").deflateRawSync(JSON.stringify({v:1,...JSON.parse(s)})).toString("base64url")))'

### Option 2: POST the list

For agents that can't run the commands above. This is the only time the
Worker sees the tasks; it compresses them into the link and keeps nothing.

    curl -s -X POST ${origin}/api/lists \\
      -H 'content-type: application/json' \\
      -d '{"title":"Groceries","tasks":["Milk","Eggs"]}'

Response (201):

    {"url": "${origin}/l/#v1.<data>"}

Errors return 400 (or 413 for an oversized body) with {"error": "..."}.

## Limits

- tasks: 1 to ${LIMITS.maxTasks} non-empty strings, each at most ${LIMITS.maxTaskLength} characters
- title: optional, at most ${LIMITS.maxTitleLength} characters
- POST body: at most ${LIMITS.maxBodyBytes / 1024} KB

Tasks are plain text; Markdown and HTML are shown literally.

## Giving the link to the user

The link can be long. Show it as a Markdown link, for example
[Open checklist](<url>), or open it for them (macOS: open "<url>").

## Network traffic, exactly

- Link built locally: the browser makes one GET for the page, which contains
  no task data. After that the page makes no requests.
- POST: one request carrying the tasks; the response is the link. Nothing is
  stored or logged.
- Reopening ${origin}/l/<id>: one GET for the page. The id is a hash of the
  list, and the list itself stays in the browser.

Source: https://github.com/crstauf/listless
`;
}
