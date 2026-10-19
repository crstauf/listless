import { env } from "cloudflare:test";
import { expect, it } from "vitest";

// Listless promises that nothing is stored off-site. A KV, D1, R2, Durable
// Object or any other binding would break that promise, so adding one should
// require consciously changing this test.
it("has no bindings, so the Worker has nowhere to store anything", () => {
	// The test runner injects its own internal bindings; ignore only those.
	const bindings = Object.keys(env).filter((name) => !name.startsWith("__VITEST_POOL_WORKERS_"));
	expect(bindings).toEqual([]);
});
