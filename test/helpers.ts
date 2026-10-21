import { exports } from "cloudflare:workers";

export const ORIGIN = "https://listless.test";

export function get(path: string): Promise<Response> {
	return exports.default.fetch(new Request(ORIGIN + path, { redirect: "manual" }));
}

export function post(path: string, body: string, headers: Record<string, string> = {}): Promise<Response> {
	return exports.default.fetch(new Request(ORIGIN + path, { method: "POST", body, headers }));
}
