/**
 * Searchable list of the window's tabs (gui#30), opened from the strip's "all
 * tabs" button to reach chips scrolled out of view, and from a chip's "Split
 * with…" to pick the partner. A split pair is one row, like its merged chip.
 */

import { Check, Columns2, Rows2, Search } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";
import { onEscape } from "../../lib/keymap";
import type { SplitAxis } from "../../stores/tabs";

export interface TabSearchEntry {
	/** The tab a pick selects. */
	tabId: string;
	/** One title per tab: two for a pair, in pane order. */
	labels: string[];
	/** Workspace names, searched along with the titles. */
	detail: string;
	/** Set for a pair: how its panes sit. */
	axis?: SplitAxis;
	current: boolean;
}

export function TabSearchMenu({
	x,
	y,
	title,
	entries,
	onPick,
	onClose,
}: {
	/** Viewport coordinates for the menu's top-left corner. */
	x: number;
	y: number;
	title?: string;
	entries: readonly TabSearchEntry[];
	onPick: (tabId: string) => void;
	onClose: () => void;
}) {
	const t = useT();
	const menuRef = useRef<HTMLDivElement>(null);
	const [query, setQuery] = useState("");
	const [activeIndex, setActiveIndex] = useState(0);
	const [pos, setPos] = useState({ left: x, top: y });
	const matches = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return entries;
		return entries.filter(entry => [...entry.labels, entry.detail].some(text => text.toLowerCase().includes(needle)));
	}, [entries, query]);

	useLayoutEffect(() => {
		const menu = menuRef.current;
		if (!menu) return;
		// Layout size, not the bounding box: the pop-in animation is still
		// scaling the menu down when this measures, so the box reads too small
		// and the menu would hang off the window's right edge.
		const left = Math.min(x, window.innerWidth - (menu.offsetWidth || 0) - 8);
		const top = Math.min(y, window.innerHeight - (menu.offsetHeight || 0) - 8);
		setPos({ left: Math.max(8, left), top: Math.max(8, top) });
	}, [x, y]);

	const onCloseRef = useRef(onClose);
	onCloseRef.current = onClose;
	useEffect(() => {
		const restore = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const onDown = (event: PointerEvent) => {
			if (!menuRef.current?.contains(event.target as globalThis.Node | null)) onCloseRef.current();
		};
		document.addEventListener("pointerdown", onDown);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			if (restore?.isConnected) restore.focus();
		};
	}, []);

	useEffect(() => {
		menuRef.current
			?.querySelector<HTMLElement>(`[data-tab-search-index="${activeIndex}"]`)
			?.scrollIntoView?.({ block: "nearest" });
	}, [activeIndex]);

	const pick = (entry: TabSearchEntry | undefined) => {
		if (!entry) return;
		onClose();
		onPick(entry.tabId);
	};

	return createPortal(
		<div
			ref={menuRef}
			role="dialog"
			aria-label={title ?? t("tabs.allTabs")}
			style={{ left: pos.left, top: pos.top }}
			onKeyDown={event => {
				if (isImeKeyEvent(event)) return;
				// Escape closes the list, and the list owns it: unclaimed, App
				// would abort the focused session's run.
				if (onEscape(event, onClose)) {
					event.stopPropagation();
					return;
				}
				if (event.key === "Tab") {
					event.preventDefault();
					onClose();
				} else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
					event.preventDefault();
					if (matches.length === 0) return;
					const delta = event.key === "ArrowDown" ? 1 : -1;
					setActiveIndex(current => (current + delta + matches.length) % matches.length);
				} else if (event.key === "Enter") {
					event.preventDefault();
					pick(matches[activeIndex]);
				}
			}}
			className="omp-pop-in fixed z-50 flex max-h-[min(28rem,70vh)] w-80 flex-col overflow-hidden rounded-xl border border-[var(--omp-border)] bg-[var(--omp-bg-elevated)] shadow-xl"
		>
			{title && <div className="truncate px-3 pt-2.5 text-omp-xs font-medium text-[var(--omp-dim)]">{title}</div>}
			<label className="flex shrink-0 items-center gap-2 border-b border-[var(--omp-border-muted)] px-3 py-2">
				<Search aria-hidden size={13} className="shrink-0 text-[var(--omp-dim)]" />
				<input
					autoFocus
					value={query}
					onChange={event => {
						setQuery(event.target.value);
						setActiveIndex(0);
					}}
					placeholder={t("tabs.search")}
					aria-label={t("tabs.search")}
					className="min-w-0 flex-1 bg-transparent text-omp-md text-[var(--omp-text)] outline-none placeholder:text-[var(--omp-dim)]"
				/>
			</label>
			<div role="listbox" aria-label={title ?? t("tabs.allTabs")} className="min-h-0 overflow-y-auto py-1">
				{matches.length === 0 ? (
					<div className="px-3 py-2 text-omp-sm text-[var(--omp-dim)]">{t("tabs.searchEmpty")}</div>
				) : (
					matches.map((entry, index) => {
						const PairIcon = entry.axis === "rows" ? Rows2 : Columns2;
						return (
							<div
								key={entry.tabId}
								role="option"
								tabIndex={-1}
								aria-selected={index === activeIndex}
								data-tab-search-index={index}
								onPointerMove={() => setActiveIndex(index)}
								onClick={() => pick(entry)}
								onKeyDown={() => {}}
								className={cx(
									"mx-1 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-omp-md",
									index === activeIndex ? "bg-[var(--omp-selected-bg)]" : "",
								)}
							>
								{entry.axis ? (
									<PairIcon aria-hidden size={12} className="shrink-0 text-[var(--omp-accent)]" />
								) : (
									<span aria-hidden className="w-3 shrink-0" />
								)}
								<span className="flex min-w-0 flex-1 flex-col leading-tight">
									<span className="flex min-w-0 items-center gap-1.5 text-[var(--omp-text)]">
										{entry.labels.map((label, labelIndex) => (
											<span key={label + String(labelIndex)} className="flex min-w-0 items-center gap-1.5">
												{labelIndex > 0 && (
													<span aria-hidden className="text-[var(--omp-dim)]">
														│
													</span>
												)}
												<span className="truncate">{label}</span>
											</span>
										))}
									</span>
									<span className="truncate text-omp-xs text-[var(--omp-dim)]">{entry.detail}</span>
								</span>
								{entry.current && (
									<Check
										aria-label={t("tabs.current")}
										size={13}
										className="shrink-0 text-[var(--omp-accent)]"
									/>
								)}
							</div>
						);
					})
				)}
			</div>
		</div>,
		document.body,
	);
}
