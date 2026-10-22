// Shared by the Worker (src/link.ts) and the page, which gets a copy at build
// time (scripts/build-page.ts), so the two can't drift apart.
export const LIMITS = {
	maxTasks: 500,
	maxSections: 50,
	maxTaskLength: 1_000,
	maxDetailsLength: 2_000,
	maxCopyLength: 500,
	maxTitleLength: 200,
	maxDescriptionLength: 2_000,
	maxBodyBytes: 256 * 1024,
} as const;
