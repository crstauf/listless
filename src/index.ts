export default {
	async fetch(): Promise<Response> {
		return new Response("Not found\n", { status: 404 });
	},
} satisfies ExportedHandler;
