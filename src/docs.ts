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

and the JSON is a list (see "List format" below), for example:

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

## List format

    {
      "v": 1,
      "title": "Optional title",
      "description": "Optional context, e.g. a link back to this conversation",
      "ordered": false,
      "tasks": [ <task>, <task>, ... ]
    }

- title: optional.
- description: optional. Shown under the title, with line breaks kept. When
  you know the address of the conversation the list came from, put it here
  so the user can get back to it. Keep it to a sentence or two.
- ordered: optional, default false. In an ordered list, tasks must be done in
  sequence: only the next unfinished task can be checked off, and later ones
  are locked until it is. Use it when order matters (setup steps, a
  procedure); leave it out for a set of independent to-dos.
- tasks: each task is either a string, or an object with muted extra detail:

      "Buy milk"
      {"text": "Create an API token", "details": "Use the \`Edit Cloudflare Workers\` template."}

  Keep "text" short and actionable; put explanation, context or caveats in
  "details". The user can hide all details with one tap.

To group tasks under headings, use "sections" instead of "tasks":

    {
      "v": 1,
      "title": "Ship the release",
      "ordered": true,
      "sections": [
        {"title": "Prepare", "tasks": ["Review the PR", {"text": "Bump the version", "details": "Edit \`package.json\`."}]},
        {"title": "Release", "tasks": ["Merge to \`main\`", "Run \`npm publish\`"]}
      ]
    }

Order in an ordered list runs across all sections.

Text is plain: Markdown and HTML are shown literally, with two exceptions:

- \`backticks\` mark code. Wrap commands, file names, paths and identifiers
  in backticks; the user can select a code span with one click to copy it.
- Web addresses (http:// or https://) in task text, details and the
  description become links that open in a new tab. Write an address bare,
  not in backticks, when the user should be able to open it; in backticks it
  stays code, for copying.

Only the checkbox toggles a task, so links and code in a task are safe to
click.

## Limits

- tasks: 1 to ${LIMITS.maxTasks} in total; task text at most ${LIMITS.maxTaskLength} characters
- details: at most ${LIMITS.maxDetailsLength} characters
- sections: 1 to ${LIMITS.maxSections}, each with a title and at least one task
- titles (list and section): at most ${LIMITS.maxTitleLength} characters
- description: at most ${LIMITS.maxDescriptionLength} characters
- POST body: at most ${LIMITS.maxBodyBytes / 1024} KB

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
