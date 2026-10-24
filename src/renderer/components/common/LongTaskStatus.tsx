/**
 * Status for slow work the user is waiting on (a compaction, a handoff, a
 * sign-in): an animated label, the elapsed time once the wait is noticeable,
 * a hint when it runs long, and an optional Stop — so a long wait reads as
 * work in progress, never as a frozen window. `card` is the transcript form:
 * an icon, a line saying what the work does, and a sliding progress track.
 */

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { translate, useT } from "../../lib/i18n";

/** Below this the wait is not worth a clock. */
const ELAPSED_VISIBLE_MS = 5_000;
/** Past this the hint explains why it is still going. */
const SLOW_HINT_MS = 30_000;

export interface LongTaskStatusProps {
	label: string;
	/** Client clock (Date.now()) when the work started. */
	startedAt: number;
	/** Shown once the wait passes {@link SLOW_HINT_MS}; replaces `detail` in a card. */
	slowHint?: string;
	onStop?: () => void;
	stopLabel?: string;
	className?: string;
	/** Card form: a framed row with an icon, a progress track and this line of detail. */
	card?: { icon: ReactNode; detail: string };
}

/** Whole seconds, so the ticking clock never shows a jittering decimal. */
function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return translate("time.secondsShort", { count: seconds });
	return translate("time.minutesSecondsShort", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

export function LongTaskStatus({
	label,
	startedAt,
	slowHint,
	onStop,
	stopLabel,
	className,
	card,
}: LongTaskStatusProps) {
	const t = useT();
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const interval = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(interval);
	}, []);
	const elapsedMs = Math.max(0, now - startedAt);
	const elapsed = elapsedMs >= ELAPSED_VISIBLE_MS ? formatElapsed(elapsedMs) : null;
	const hint = slowHint && elapsedMs >= SLOW_HINT_MS ? slowHint : null;

	const stopButton = onStop && (
		<button
			type="button"
			onClick={onStop}
			className="omp-pressable h-7 shrink-0 rounded-full px-2.5 text-omp-sm font-medium text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]"
		>
			{stopLabel ?? t("chat.retry.stop")}
		</button>
	);
	// Announced once; the ticking clock stays out of the live region.
	const announcement = (
		<span aria-atomic="true" aria-live="polite" className="sr-only" role="status">
			{label}
		</span>
	);

	if (card) {
		return (
			<div
				className={`omp-task-card relative flex min-w-0 items-center gap-3 overflow-hidden rounded-xl border px-3.5 py-3 ${className ?? ""}`}
			>
				{announcement}
				<span
					aria-hidden
					className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--omp-selected-bg)] text-[var(--omp-accent)]"
				>
					{card.icon}
				</span>
				<div aria-hidden className="min-w-0 flex-1">
					<p className="flex min-w-0 items-baseline gap-2 text-omp-md">
						<span className="omp-shimmer-text truncate font-medium">{label}</span>
						{elapsed && (
							<span className="shrink-0 text-omp-sm tabular-nums text-[var(--omp-dim)]">{elapsed}</span>
						)}
					</p>
					<p className="mt-0.5 truncate text-omp-sm text-[var(--omp-muted)]">{hint ?? card.detail}</p>
				</div>
				{stopButton}
				<div aria-hidden className="omp-task-card-track">
					<div className="omp-indeterminate-progress h-full bg-[var(--omp-accent)]" />
				</div>
			</div>
		);
	}

	return (
		<div className={`flex min-w-0 flex-col gap-0.5 ${className ?? ""}`}>
			{announcement}
			<div className="flex min-w-0 items-center gap-2.5 text-omp-md">
				<span aria-hidden className="omp-working-dot" />
				<span aria-hidden className="omp-shimmer-text min-w-0 truncate">
					{label}
				</span>
				{elapsed && (
					<span aria-hidden className="shrink-0 tabular-nums text-[var(--omp-dim)]">
						{elapsed}
					</span>
				)}
				{stopButton && <span className="ms-auto">{stopButton}</span>}
			</div>
			{hint && (
				<p aria-hidden className="ps-[18px] text-omp-sm text-[var(--omp-dim)]">
					{hint}
				</p>
			)}
		</div>
	);
}
