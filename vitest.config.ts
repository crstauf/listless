import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
	// The page tests drive a real browser from Node; see vitest.page.config.ts.
	test: { exclude: ["**/node_modules/**", "test/page/**"] },
});
