import { defineConfig } from "vitest/config";

// Browser tests for the checklist page. They drive Chromium with Playwright, so
// they run in plain Node rather than the Workers pool used by `npm test`.
export default defineConfig({
	test: {
		environment: "node",
		include: ["test/page/**/*.test.ts"],
		testTimeout: 20_000,
		slowTestThreshold: 0, // TEMPORARY: print every duration while measuring budgets
		hookTimeout: 30_000,
	},
});
