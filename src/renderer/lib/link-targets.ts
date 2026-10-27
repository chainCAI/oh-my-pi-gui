/**
 * What a piece of reply or tool-output text points at: a web address or a file
 * reference. File references carry the line/column suffixes editors and
 * compilers print (`src/a.ts:12:5`, `src/a.ts#L12`, `src/a.ts(12,5)`), so a
 * click can land on the line.
 */

/** A file reference split into the path and its optional position. */
export interface FileTarget {
	path: string;
	line?: number;
	column?: number;
}

// `:12`, `:12:5`, `#L12`, `#L12-L20`, `(12,5)`; a path can end in only one.
const POSITION_SUFFIX = /(?::(\d+)(?::(\d+))?|#L(\d+)(?:-L?\d+)?|\((\d+)(?:,\s*(\d+))?\))$/;
const WEB_URL = /^https?:\/\/[^\s"'<>`]+$/i;
/** A bare `name.ext` file name; the extension has a letter so `1.2.3` is a version, not a file. */
const FILE_NAME = /^[\w@+-][\w.@+-]*\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,10}$/;
/** A bare dotfile such as `.gitignore` or `.env.local`. */
const DOTFILE = /^\.[A-Za-z_][\w.-]*$/;
/** Characters that mark globs, templates, shell syntax, or prose rather than one path. */
const NOT_A_PATH = /[\s*?<>|"'`{}$,;=]/;

/** Whether `text` is one whole web address. */
export function isWebUrl(text: string): boolean {
	return WEB_URL.test(text);
}

/** Split a trailing line/column suffix off a file reference. */
export function parseFileTarget(text: string): FileTarget {
	const match = text.match(POSITION_SUFFIX);
	if (!match || match.index === undefined || match.index === 0) return { path: text };
	const line = Number(match[1] ?? match[3] ?? match[4]);
	const columnText = match[2] ?? match[5];
	return {
		path: text.slice(0, match.index),
		...(line > 0 ? { line } : {}),
		...(columnText && Number(columnText) > 0 ? { column: Number(columnText) } : {}),
	};
}

/**
 * Whether inline code reads as a file reference worth checking on disk: one
 * token with a path separator, a `name.ext` file name, or a dotfile. Existence decides
 * the rest — `and/or` passes here and simply never resolves.
 */
export function looksLikeFilePath(text: string): boolean {
	if (text.length < 2 || text.length > 400) return false;
	if (text.includes("://") || text.startsWith("-") || text.startsWith("@")) return false;
	const { path } = parseFileTarget(text);
	if (!path || /^\.+$/.test(path) || NOT_A_PATH.test(path)) return false;
	if (/[\\/]/.test(path)) return /[^\\/.~]/.test(path);
	return FILE_NAME.test(path) || DOTFILE.test(path);
}
