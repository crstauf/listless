import { defineConfig } from "vitest/config";

// Browser tests for the checklist page. They drive Chromium with Playwright, so
// they run in plain Node rather than the Workers pool used by `npm test`.
export default defineConfig({
	test: {
		environment: "node",
		include: ["test/page/**/*.test.ts"],
		testTimeout: 20_000,
		// Every test has its own time budget (the last argument of each `it`), and fails
		// when it goes over, so yellow would only repeat that for a single test. It is
		// kept for the file as a whole, which takes about 22s in CI: a passing log stays
		// all green, and yellow means the suite as a whole has slowed down.
		slowTestThreshold: 30_000,
		hookTimeout: 30_000,
	},
});
