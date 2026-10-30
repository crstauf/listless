# Contributing

## Development

```sh
npm run build      # rebuild src/page.generated.ts from src/page/
npm run typecheck
npm test           # the Worker: headers, CSP, API
npm run test:page  # the page, driven in Chromium (npx playwright install chromium, once)
```

The page source lives in `src/page/` (`page.html`, `page.css`, `page.js`). `npm run build` inlines the CSS and JS into the HTML, computes the SHA-256 hashes the Content-Security-Policy needs, and writes `src/page.generated.ts`. That file is committed so the deployed page can be reviewed in the repository. CI rebuilds it and fails if it differs. The build also copies the limits from [`src/limits.ts`](src/limits.ts), which the Worker uses too, into the page script before hashing it, so both enforce the same ones.

The browser tests (`npm run test:page`) serve the built page to Chromium with the same Content-Security-Policy header the Worker sends, so they need no server.

After changing how the page looks, run `npm run screenshots` to recapture the README preview (`docs/preview-light.png` and `docs/preview-dark.png`). It needs Playwright's Chromium, which you can install once with `npx playwright install chromium`. No server is needed.

## Writing tests

There are two suites, and CI runs both on every pull request.

- **The Worker** (`test/*.test.ts`, `npm test`) runs in the Workers runtime. [`test/helpers.ts`](test/helpers.ts) has `get` and `post` for calling the Worker.
- **The page** (`test/page/page.test.ts`, `npm run test:page`) drives the built page in Chromium. [`test/page/helpers.ts`](test/page/helpers.ts) has the pieces you build a test from:
  - `useBrowser()` starts one Chromium for the file and returns `session(options)`. Each call makes a fresh browser context with empty `localStorage`; its `open(url)` returns a page. `options` are Playwright context options, such as a `colorScheme`, a touch screen or a `viewport`.
  - `linkFor(list)` (and `plainLinkFor` for the `#json=` form) builds the link for a list, and `ID_URL` matches the short address the page swaps it for.
  - A test fails if the page logs a console error (which is how Content-Security-Policy violations show up) or opens a dialog. The page confirms with a second click and offers undo, so it never uses `alert()`, `confirm()` or `prompt()`.

  The top of `page.test.ts` has small helpers of its own (`toggle`, `texts`, `checks`, `shareLink`, `decodeLink`) and the lists most tests start from (`groceries`, `steps`). Use them before writing new ones.

### Animations

The page tests run with `reducedMotion: "reduce"`, which turns off every animation and transition (the page honors `prefers-reduced-motion`). Playwright waits for a moving element to settle before it clicks, so with animations on, a test's time depends on where an animation happens to be: one test took 110ms or 470ms depending on frame timing. A test that needs motion, because it checks behavior that depends on it, opts back in with `session({ reducedMotion: "no-preference" })`. See the `with motion` tests. Don't do that just to see an animation; only for something a user would notice if it broke.

### Time budgets

Every page test has its own time budget, passed as the last argument of `it`:

```ts
it("unchecks the last step without asking", async () => {
	// …
}, 272);
```

A test that runs longer fails with `Test timed out in 272ms`, which names the test. Without one, a test gets the 20 second default from `vitest.page.config.ts`, so a slowdown would go unnoticed. Always give a new test a budget.

To set one:

1. Write the test and get it passing.
2. Temporarily set `slowTestThreshold: 0` in `vitest.page.config.ts`. Vitest then prints every test's duration in the CI log, not only the slow ones.
3. Push, open a pull request, and rerun the `check` job a few times (`gh run rerun <run id>`) to collect about five CI samples. CI is slower than a laptop, up to about 2.5 times for some tests, so budgets taken from local runs fail in CI. (For local samples as well, run `npx vitest run -c vitest.page.config.ts --reporter=json --outputFile=<file>`.)
4. Set the budget to 1.5 times the slowest sample, rounded up, in milliseconds. There is no minimum: the margin is what absorbs jitter.
5. Put `slowTestThreshold` back to its committed value.

Re-measure a test's budget whenever you change the test, or the page in a way that makes it slower or faster. If a test fails its budget in CI without such a change, re-measure it the same way and look at what changed before raising the number. A deliberate wait counts against the budget too, so a test that waits on a real timer (such as the armed button's timeout) gets a large one.

`slowTestThreshold` in `vitest.page.config.ts` is 30 seconds, which only applies to the file as a whole: Vitest colors a duration yellow when it goes over, and the suite takes about 22 seconds in CI. A healthy run has no yellow, so yellow means the suite as a whole has slowed down.

## Deploying from GitHub Actions

Two workflows live in `.github/workflows/`. `check.yml` runs the checks (the generated page is up to date, typecheck, the Worker tests and the browser tests) on every pull request and has no access to secrets. `deploy.yml` runs on pushes to `master`: it calls `check.yml` first, then deploys. The deploy needs two repository (or `production` environment) secrets:

- `CLOUDFLARE_API_TOKEN`: an API token with the **Workers Scripts: Edit** permission
- `CLOUDFLARE_ACCOUNT_ID`

[Dependabot](.github/dependabot.yml) opens a weekly pull request for updates to the Actions and the npm dependencies; the same checks run on it.
