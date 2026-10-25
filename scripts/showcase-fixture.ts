import { createInterface } from "node:readline";
import { createShowcaseData } from "./showcase-data";

const locale = process.env.OMP_SHOWCASE_LANG === "zh" ? "zh" : "en";
const data = createShowcaseData(locale, process.env.OMP_SHOWCASE_PROJECT ?? process.cwd());

if (process.argv.includes("stats")) {
	const headers = { "x-omp-stats-dashboard": "1" };
	// The dashboard syncs quietly on open; each status poll reports a newer finished sync.
	let lastSyncedAt = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const pathname = new URL(request.url).pathname;
			if (pathname === "/api/sync" || pathname === "/api/status") {
				if (pathname === "/api/status") lastSyncedAt++;
				const sync = { phase: "idle", current: 0, total: 0, processed: 0, lastSyncedAt, error: null };
				return Response.json({ version: 1, sync }, { headers });
			}
			return Response.json(data.stats[pathname] ?? [], { headers });
		},
	});
	process.stdout.write(`http://127.0.0.1:${server.port}\n`);
	process.on("SIGTERM", () => {
		server.stop(true);
		process.exit(0);
	});
} else {
	const write = (frame: unknown) => process.stdout.write(`${JSON.stringify(frame)}\n`);
	write({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] });
	const input = createInterface({ input: process.stdin });
	input.on("line", line => {
		const command = JSON.parse(line) as { id?: string; type: string };
		if (Object.hasOwn(data.replies, command.type)) {
			write({
				type: "response",
				id: command.id,
				command: command.type,
				success: true,
				data: data.replies[command.type],
			});
		} else if (
			["set_subagent_subscription", "set_host_tools", "set_host_uri_schemes", "abort"].includes(command.type)
		) {
			write({ type: "response", id: command.id, command: command.type, success: true, data: {} });
		} else {
			process.stderr.write(`Unscripted showcase command: ${command.type}\n`);
			write({
				type: "response",
				id: command.id,
				command: command.type,
				success: false,
				error: locale === "zh" ? "演示场景未启用此操作" : "This action is not enabled in the demonstration",
			});
		}
	});
}
