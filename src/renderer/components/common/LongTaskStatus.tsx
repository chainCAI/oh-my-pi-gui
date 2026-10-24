/**
 * Status line for slow work the user is waiting on (a compaction, a handoff):
 * an animated label, the elapsed time once the wait is noticeable, a hint when
 * it runs long, and an optional Stop — so a long wait reads as work in
 * progress, never as a frozen window.
 */

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
	/** Shown once the wait passes {@link SLOW_HINT_MS}. */
	slowHint?: string;
	onStop?: () => void;
	stopLabel?: string;
	className?: string;
}

/** Whole seconds, so the ticking clock never shows a jittering decimal. */
function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return translate("time.secondsShort", { count: seconds });
	return translate("time.minutesSecondsShort", { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
}

export function LongTaskStatus({ label, startedAt, slowHint, onStop, stopLabel, className }: LongTaskStatusProps) {
	const t = useT();
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const interval = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(interval);
	}, []);
	const elapsedMs = Math.max(0, now - startedAt);

	return (
		<div className={`flex flex-col gap-1 ${className ?? ""}`}>
			{/* Announced once; the ticking clock below stays out of the live region. */}
			<span aria-atomic="true" aria-live="polite" className="sr-only" role="status">
				{label}
			</span>
			<div aria-hidden className="flex min-w-0 items-center gap-2.5 text-omp-md">
				<span className="omp-working-dot" />
				<span className="omp-shimmer-text min-w-0 truncate">{label}</span>
				{elapsedMs >= ELAPSED_VISIBLE_MS && (
					<span className="shrink-0 tabular-nums text-[var(--omp-dim)]">{formatElapsed(elapsedMs)}</span>
				)}
			</div>
			{(onStop || (slowHint && elapsedMs >= SLOW_HINT_MS)) && (
				<div className="flex items-center gap-2 ps-[18px] text-omp-sm">
					{slowHint && elapsedMs >= SLOW_HINT_MS && <span className="text-[var(--omp-dim)]">{slowHint}</span>}
					{onStop && (
						<button
							type="button"
							onClick={onStop}
							className="omp-pressable h-6 shrink-0 rounded-full px-2 font-medium text-[var(--omp-muted)] hover:bg-[var(--omp-selected-bg)] hover:text-[var(--omp-text)]"
						>
							{stopLabel ?? t("chat.retry.stop")}
						</button>
					)}
				</div>
			)}
		</div>
	);
}
