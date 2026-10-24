/**
 * The find bar over a transcript (⌘F): a query, where the current match sits in
 * the total, and previous / next. Enter steps forward, ⇧Enter back, Escape closes.
 */

import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { RefObject } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { isImeKeyEvent } from "../../lib/ime";

export interface TranscriptFindBarProps {
	query: string;
	onQueryChange: (query: string) => void;
	total: number;
	/** Zero-based position of the current match; ignored when `total` is 0. */
	current: number;
	onStep: (direction: 1 | -1) => void;
	onClose: () => void;
	inputRef: RefObject<HTMLInputElement | null>;
}

export function TranscriptFindBar({
	query,
	onQueryChange,
	total,
	current,
	onStep,
	onClose,
	inputRef,
}: TranscriptFindBarProps) {
	const t = useT();
	const searched = query.trim().length > 0;
	const stepButton =
		"omp-pressable flex h-7 w-7 items-center justify-center rounded-md text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)] disabled:pointer-events-none disabled:opacity-40";

	return (
		<div
			role="search"
			data-transcript-find
			aria-label={t("chat.find.label")}
			className="omp-find-bar absolute top-3 z-30 flex h-10 w-[min(380px,calc(100%-2rem))] items-center gap-1 rounded-xl border border-[var(--omp-border)] bg-[var(--omp-bg-elevated)] ps-3 pe-1.5 shadow-[var(--omp-shadow-md)]"
		>
			<Search aria-hidden size={14} className="shrink-0 text-[var(--omp-dim)]" />
			<input
				ref={inputRef}
				autoFocus
				value={query}
				onChange={event => onQueryChange(event.target.value)}
				onKeyDown={event => {
					if (isImeKeyEvent(event)) return;
					if (event.key === "Enter") {
						event.preventDefault();
						onStep(event.shiftKey ? -1 : 1);
					} else if (event.key === "Escape") {
						event.preventDefault();
						event.stopPropagation();
						onClose();
					}
				}}
				aria-label={t("chat.find.label")}
				placeholder={t("chat.find.placeholder")}
				spellCheck={false}
				className="min-w-0 flex-1 bg-transparent px-1.5 text-omp-md text-[var(--omp-text)] placeholder:text-[var(--omp-dim)] focus:outline-none"
			/>
			<span
				aria-live="polite"
				className={cx(
					"shrink-0 px-1 text-omp-sm tabular-nums",
					searched && total === 0 ? "text-[var(--omp-error)]" : "text-[var(--omp-dim)]",
				)}
			>
				{searched
					? total === 0
						? t("chat.find.none")
						: t("chat.find.count", { current: current + 1, total })
					: null}
			</span>
			<button
				type="button"
				onClick={() => onStep(-1)}
				disabled={total === 0}
				aria-label={t("chat.find.previous")}
				title={t("chat.find.previous")}
				className={stepButton}
			>
				<ChevronUp size={15} />
			</button>
			<button
				type="button"
				onClick={() => onStep(1)}
				disabled={total === 0}
				aria-label={t("chat.find.next")}
				title={t("chat.find.next")}
				className={stepButton}
			>
				<ChevronDown size={15} />
			</button>
			<button
				type="button"
				onClick={onClose}
				aria-label={t("chat.find.close")}
				title={t("chat.find.close")}
				className={stepButton}
			>
				<X size={14} />
			</button>
		</div>
	);
}
