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
  for good (Delete can be undone only right away). Opening the original link
  again imports a fresh copy.
- ${origin}/l/ (with nothing after it) lists every list saved in the user's
  browser, so they can find or delete one.
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
${origin}/l/<id>. The id comes from the list's contents, so opening the same
link again finds the same list; a link can also name the list it updates (see
"Updating a list the user gave you").

### Option 1 (preferred): build the link yourself

Nothing is sent anywhere. Pipe the list as JSON (everything in "List format"
below except "v", which the commands add) into either command.

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

### Option 3: write the link by hand

For agents that can't run code or make requests. Write the list as JSON,
URL-encode it as encodeURIComponent would (a space is %20, " is %22, { is %7B,
} is %7D, : is %3A, "," is %2C, [ is %5B, ] is %5D, and "%" itself is %25), and
put it after "#json=":

    ${origin}/l/#json=%7B%22title%22%3A%22Groceries%22%2C%22tasks%22%3A%5B%22Milk%22%2C%22Eggs%22%5D%7D

The page treats it exactly like a compressed link, including "id" (see
"Updating a list the user gave you").
It is longer, so prefer Option 1 or 2 when you can.

## Updating a list the user gave you

${origin}/l/<id> has no list in it: the list lives in the user's browser, which
you can't read, so fetching that address shows you nothing. To work from a
list, ask the user for a share link instead: the "Copy share link" button
gives ${origin}/l/#v1.<data>, with the list as it is now, including its order,
check marks and id.

The user may instead paste the list as Markdown (their "Copy as Markdown"
button). It ends with a note about Listless, the list's id, and the same kind
of share link, so you can use either.

To report progress or change the list, decode the link (or read the Markdown),
edit the JSON, and encode it again with the commands in "Making a link". If
you can't run code, write the whole list as JSON, with the "id" from the
note, and build the link by hand (Option 3).

Python:

    echo '<the link>' | python3 -c 'import base64,json,sys,zlib; d=sys.stdin.read().strip().split("#v1.")[1]; print(json.dumps(json.loads(zlib.decompress(base64.urlsafe_b64decode(d+"="*(-len(d)%4)),-15))))'

Node.js:

    echo '<the link>' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(require("zlib").inflateRawSync(Buffer.from(s.trim().split("#v1.")[1],"base64url")).toString()))'

- Keep "id" exactly as it is. It names the list in the user's browser that the
  link updates. Never make one up; a link without it is an ordinary new link.
- Add "done": true to a task you finished (the same ordering rules apply: in
  an ordered list or section, done tasks come first), or edit the list.
- Always give the user the updated link when you report progress, as in
  "Giving the link to the user". POST keeps "id" too.

When the user opens it, they land on their existing list and nothing changes
until they say so. If only check marks differ, the page offers to add the
link's check marks to theirs. If the content differs, it offers to use the
new version; their own check marks on tasks it still has are kept, and they
can undo. If the link has no "id" (or you removed it), it opens the same list
only when the content is unchanged, and otherwise becomes a separate list.

## List format

    {
      "v": 1,
      "id": "Optional, only from a share link: keep it as it is",
      "title": "Optional title",
      "description": "Optional context, e.g. a link back to this conversation",
      "ordered": false,
      "tasks": [ <task>, <task>, ... ]
    }

- id: optional, 12 characters (letters, digits, "-" and "_"). Only a share
  link has one; leave it out of a new list, and keep it when updating one.
  It is not part of the list's content.
- title: optional.
- description: optional. Shown under the title, with line breaks kept. When
  you know the address of the conversation the list came from, put it here
  so the user can get back to it. Keep it to a sentence or two.
- ordered: optional, default false. Use it when order matters (setup steps, a
  procedure); leave it out for a set of independent to-dos. Without
  "sections", an ordered list's tasks must be done in sequence: only the next
  unfinished task can be checked off, and later ones are locked until it is.
  With "sections", it means the sections are done in order: a section stays
  locked until every section before it is done. Tasks inside a section are
  in any order unless that section is ordered too (see below).
- tasks: each task is either a string, or an object with muted extra detail:

      "Buy milk"
      {"text": "Create an API token", "details": "Use the \`Edit Cloudflare Workers\` template."}

  Keep "text" short and actionable; put explanation, context or caveats in
  "details". The user can hide all details with one tap.
  Add "copy" when the task hinges on a value the user will paste somewhere
  else: an email address, phone number, account or order number,
  confirmation code, street address, or a short phrase to type exactly. It
  is shown on its own, exactly as written (no backticks or links), and
  one tap selects all of it, and a button copies it. Keep each value alone, with no
  label or explanation inside it; those go in "text" or "details" (or, for
  several values, a "label" below). Use backticks for
  commands, file names and paths inside text instead.

      {"text": "Email Dana the invoice", "copy": "dana@example.com"}

  When a step needs several values, make "copy" an array. Each gets its own
  copy button. Give an item a short "label" (a field name, like "Name") when
  the values could be confused; otherwise use bare strings. The label is
  shown beside its value, in capitals, and is not copied. A single value
  is always just a string.

      {"text": "Add the DNS record", "copy": [{"label": "Name", "value": "_acme"}, {"label": "Value", "value": "abc123"}]}
      {"text": "Fill in the shipping form", "copy": ["12 Main St", "555-0100"]}

  Add "done": true to an object task that is already complete; it starts out
  checked off. Done tasks must come first in an ordered list without sections
  or in an ordered section, and a section of an ordered list can only have
  done tasks once the sections before it are done.

      {"text": "Draft the outline", "done": true}

To group tasks under headings, use "sections" instead of "tasks":

    {
      "v": 1,
      "title": "Ship the release",
      "ordered": true,
      "sections": [
        {"title": "Prepare", "description": "Do these before the release window opens.", "ordered": true, "tasks": ["Review the PR", {"text": "Bump the version", "details": "Edit \`package.json\`."}]},
        {"title": "Release", "ordered": true, "tasks": ["Merge to \`main\`", "Run \`npm publish\`"]}
      ]
    }

A section can have a "description", shown under its heading. Use it for
context that all of its tasks share, instead of repeating the same "details"
on every task: the user reads it once, where it applies, and the link gets
shorter too (most of all a plain "#json=" link, which isn't compressed). Like
the list's description, it keeps line breaks and turns web addresses into
links, and it is always shown (the user's "hide details" doesn't hide it).

A section can also be "ordered": true, which means its tasks are done in
sequence. The two are independent, so a list can mix them: sections that go in
any order or in order, each holding tasks in any order or in sequence.

    {
      "v": 1,
      "title": "Set up the project",
      "ordered": true,
      "sections": [
        {"title": "Gather", "tasks": ["Find the API key", "Find the deploy token"]},
        {"title": "Install", "ordered": true, "tasks": ["Clone the repo", "Run \`npm install\`", "Run \`npm test\`"]}
      ]
    }

Here "Install" stays locked until "Gather" is done, and its steps then go in
order. For one sequence across the whole list, as in the "Ship the release"
example above, set "ordered" on every section too.

Text is plain: Markdown and HTML are shown literally, with two exceptions:

- \`backticks\` mark code. Wrap commands, file names, paths and identifiers
  in backticks; the user can select a code span with one click to copy it.
- Web addresses (http:// or https://) in task text, details and
  descriptions become links that open in a new tab. Write an address bare,
  not in backticks, when the user should be able to open it; in backticks it
  stays code, for copying.

Only the checkbox toggles a task, so links and code in a task are safe to
click.

## Limits

- tasks: 1 to ${LIMITS.maxTasks} in total; task text at most ${LIMITS.maxTaskLength} characters
- details: at most ${LIMITS.maxDetailsLength} characters
- copy: at most ${LIMITS.maxCopyLength} characters per value, ${LIMITS.maxCopyValues} values per task, labels at most ${LIMITS.maxCopyLabelLength} characters
- sections: 1 to ${LIMITS.maxSections}, each with a title and at least one task
- titles (list and section): at most ${LIMITS.maxTitleLength} characters
- description (list and section): at most ${LIMITS.maxDescriptionLength} characters
- POST body: at most ${LIMITS.maxBodyBytes / 1024} KB

## Giving the link to the user

The link can be long. Show it as a Markdown link, for example
[Open checklist](<url>), or open it for them (macOS: open "<url>"). A link
you updated goes back to the user the same way.

## Network traffic, exactly

- Link built locally: the browser makes one GET for the page, which contains
  no task data. After that the page makes no requests.
- POST: one request carrying the tasks; the response is the link. Nothing is
  stored or logged.
- Reopening ${origin}/l/<id>: one GET for the page. The id is a hash of the
  list's contents (or the "id" in the link, when it has one), and the list
  itself stays in the browser.
- A link in the list goes to its own site only when the user clicks it. It
  opens in a new tab and sends no referrer, so that site doesn't learn which
  list it came from.

Source: https://github.com/crstauf/listless
`;
}
