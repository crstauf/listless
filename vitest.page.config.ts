import { defineConfig } from "vitest/config";

// Browser tests for the checklist page. They drive Chromium with Playwright, so
// they run in plain Node rather than the Workers pool used by `npm test`.
export default defineConfig({
	test: {
		environment: "node",
		include: ["test/page/**/*.test.ts"],
		testTimeout: 20_000,
		// Every test has its own time budget (the last argument of each `it`), and fails
		// when it goes over. Yellow would only repeat that, so it is set to the largest
		// budget: a passing log stays all green.
		slowTestThreshold: 6_480,
		hookTimeout: 30_000,
	},
});
