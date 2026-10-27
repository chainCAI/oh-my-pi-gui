/**
 * Paths named by the renderer, resolved the way fs reads resolve them: inside
 * the tab's workspace for relative paths, as given for absolute ones.
 */
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IpcResolvedPath } from "../shared/ipc-types";

/** Resolve `rel` against `root`, refusing escapes outside the workspace. */
export function resolveWithin(root: string, rel: string, paths: path.PlatformPath = path): string | null {
	const resolved = paths.resolve(root, rel);
	const rootWithSep = root.endsWith(paths.sep) ? root : root + paths.sep;
	if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
	return resolved;
}

/**
 * The absolute path `target` names: "~" expands, absolute paths pass through
 * normalized, relative ones resolve inside `cwd` (escapes refused). On Windows
 * a drive path written URL-style (`/E:/src/a.ts`, what a `file:///E:/…` link
 * leaves) names that drive; read as rooted, Windows would look on the current
 * drive instead (`C:\E:\src\a.ts`).
 */
export function toAbsolutePath(
	target: string,
	cwd: string | null,
	paths: path.PlatformPath = path,
): { path: string } | { error: string } {
	const windows = paths.sep === "\\";
	let raw = windows && /^[\\/][A-Za-z]:[\\/]/.test(target) ? target.slice(1) : target;
	if (windows ? /^~[\\/]/.test(raw) : raw.startsWith("~/")) raw = paths.join(os.homedir(), raw.slice(2));
	if (paths.isAbsolute(raw)) return { path: paths.normalize(raw) };
	if (!cwd) return { error: "No workspace" };
	const within = resolveWithin(cwd, raw, paths);
	return within ? { path: within } : { error: "Path escapes the workspace" };
}

/**
 * What `target` names on disk, resolved by `toAbsolutePath`. Null when it does
 * not exist or cannot be resolved.
 */
export async function resolveExistingPath(target: unknown, cwd: string | null): Promise<IpcResolvedPath | null> {
	if (typeof target !== "string" || !target.trim()) return null;
	const resolved = toAbsolutePath(target, cwd);
	if ("error" in resolved) return null;
	const abs = resolved.path;
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
