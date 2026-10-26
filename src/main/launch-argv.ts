/**
 * What a launch asked for, decoded from the app's own arguments at startup or
 * from those a refused second instance handed over. Pure so the rule is
 * testable without Electron.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type LaunchRequest = { kind: "url"; url: string } | { kind: "path"; path: string } | { kind: "focus" };

export function isExistingDirectory(path: string): boolean {
	try {
		return fs.statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * A deep link wins over everything; otherwise the first argument naming a real
 * directory is the workspace to open, and anything left means "just raise the
 * app". Flags are skipped so Electron's own switches never look like a path.
 */
export function parseLaunchArgv(
	argv: readonly string[],
	protocol: string,
	directoryExists: (path: string) => boolean = isExistingDirectory,
): LaunchRequest {
	for (const arg of argv) {
		if (arg.startsWith(`${protocol}://`)) return { kind: "url", url: arg };
	}
	for (const arg of argv) {
		if (arg.startsWith("-")) continue;
		if (directoryExists(arg)) return { kind: "path", path: arg };
	}
	return { kind: "focus" };
}

/**
 * The arguments meant for the app. In dev, argv[0] is Electron and argv[1] the
 * app directory, a real directory that would pass for a workspace; a packaged
 * app's own arguments start right after the executable.
 */
export function launchArguments(argv: readonly string[], defaultApp: boolean): readonly string[] {
	return argv.slice(defaultApp ? 2 : 1);
}

/**
 * The workspace a launch was pointed at (`omp ~/code/x`), absolute. A relative
 * path resolves against this process's cwd, so only call this for the app's own
 * startup argv, where that cwd is the launcher's.
 */
export function launchFolder(
	argv: readonly string[],
	defaultApp: boolean,
	protocol: string,
	directoryExists: (path: string) => boolean = isExistingDirectory,
): string | undefined {
	const request = parseLaunchArgv(launchArguments(argv, defaultApp), protocol, directoryExists);
	return request.kind === "path" ? path.resolve(request.path) : undefined;
}
