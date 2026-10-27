/**
 * Links in replies and tool output. A click opens inside the app (web pages in
 * the browser panel, files in the Files preview); ⌘/Ctrl-click opens outside
 * (the system browser, the default app); right-click offers both plus copying.
 * A click that ends a text selection keeps the selection instead of opening.
 */
import { type CSSProperties, type ReactNode, useMemo } from "react";
import type { IpcResolvedPath } from "../../../shared/ipc-types";
import { activateFileLink } from "../../lib/file-actions";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { type FileTarget, parseFileTarget } from "../../lib/link-targets";
import { browserPanelAvailable, openLink } from "../../lib/open-link";
import { useResolvedPath } from "../../lib/path-resolver";
import { useRuntimeTabId } from "../../stores/session-runtime-context";
import { LINK_MODIFIER, showLinkMenu } from "./LinkMenu";

function selectingText(): boolean {
	const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
	return selection !== null && !selection.isCollapsed && selection.toString().length > 0;
}

export function WebLink({
	url,
	children,
	className,
	style,
}: {
	url: string;
	children: ReactNode;
	className?: string;
	style?: CSSProperties;
}) {
	const t = useT();
	const web = /^https?:\/\//i.test(url);
	const hint = web
		? browserPanelAvailable()
			? t("links.webHint", { mod: LINK_MODIFIER })
			: t("links.webHintExternal")
		: null;
	return (
		<a
			href={url}
			title={hint ? `${url}\n${hint}` : url}
			onClick={event => {
				event.preventDefault();
				event.stopPropagation();
				if (selectingText()) return;
				openLink(url, event);
			}}
			onContextMenu={event => showLinkMenu(event, { kind: "url", url })}
			className={className}
			style={style}
		>
			{children}
		</a>
	);
}

export function FileLink({
	target,
	resolved,
	children,
	className,
}: {
	target: FileTarget;
	/** What the path names on disk; undefined while unknown, null when missing. */
	resolved: IpcResolvedPath | null | undefined;
	children: ReactNode;
	className?: string;
}) {
	const t = useT();
	const folder = resolved?.kind === "directory";
	const shown = `${resolved?.absolutePath ?? target.path}${target.line ? `:${target.line}` : ""}`;
	return (
		// A span, not a button: link text stays selectable like the prose around it.
		<span
			role="link"
			tabIndex={0}
			title={`${shown}\n${t(folder ? "links.folderHint" : "links.fileHint", { mod: LINK_MODIFIER })}`}
			onClick={event => {
				event.preventDefault();
				event.stopPropagation();
				if (selectingText()) return;
				activateFileLink(target, resolved, event.metaKey || event.ctrlKey);
			}}
			onKeyDown={event => {
				if (event.key !== "Enter") return;
				event.preventDefault();
				event.stopPropagation();
				activateFileLink(target, resolved, event.metaKey || event.ctrlKey);
			}}
			onContextMenu={event => showLinkMenu(event, { kind: "path", target, resolved })}
			className={cx("cursor-pointer", className)}
		>
			{children}
		</span>
	);
}

/**
 * Inline code that names a path becomes a file link once the path is found on
 * disk; until then (and when it is not there) it stays plain code.
 */
export function PathCode({
	text,
	children,
	plainClassName,
	linkClassName,
}: {
	text: string;
	children: ReactNode;
	plainClassName: string;
	linkClassName: string;
}) {
	const target = useMemo(() => parseFileTarget(text), [text]);
	const tabId = useRuntimeTabId();
	const resolved = useResolvedPath(target.path, tabId);
	if (!resolved) return <code className={plainClassName}>{children}</code>;
	return (
		<FileLink target={target} resolved={resolved}>
			<code className={linkClassName}>{children}</code>
		</FileLink>
	);
}
