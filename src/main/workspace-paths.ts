/**
 * Paths named by the renderer, resolved the way fs reads resolve them: inside
 * the tab's workspace for relative paths, as given for absolute ones.
 */
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IpcResolvedPath } from "../shared/ipc-types";

/** Resolve `rel` against `root`, refusing escapes outside the workspace. */
export function resolveWithin(root: string, rel: string): string | null {
	const resolved = path.resolve(root, rel);
	const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
	if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
	return resolved;
}

/**
 * What `target` names on disk, resolved like fs reads: "~" expands, absolute
 * paths pass through, relative ones resolve inside `cwd` (escapes refused).
 * Null when it does not exist.
 */
export async function resolveExistingPath(target: unknown, cwd: string | null): Promise<IpcResolvedPath | null> {
	if (typeof target !== "string" || !target.trim()) return null;
	const raw = target.startsWith("~/") ? path.join(os.homedir(), target.slice(2)) : target;
	let abs: string;
	if (path.isAbsolute(raw)) {
		abs = path.normalize(raw);
	} else {
		const within = cwd ? resolveWithin(cwd, raw) : null;
		if (!within) return null;
		abs = within;
	}
	try {
		const stat = await fsp.stat(abs);
		const fromCwd = cwd ? path.relative(cwd, abs) : "";
		const relativePath =
			fromCwd && fromCwd.split(path.sep)[0] !== ".." && !path.isAbsolute(fromCwd) ? fromCwd : undefined;
		return {
			absolutePath: abs,
			kind: stat.isDirectory() ? "directory" : "file",
			...(relativePath ? { relativePath } : {}),
		};
	} catch {
		return null;
	}
}
