/**
 * A page beside its session's conversation (plan/24 §3.3): two panes of one
 * tab, with the split view's divider, minimum share and keyboard steps.
 */

import { Columns2 } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useRef, useState } from "react";
import { cx } from "../../lib/format";
import { useT } from "../../lib/i18n";

const DIVIDER_SIZE = 5;
const RATIO_STEP = 0.05;

function clampRatio(ratio: number): number {
	return Math.min(0.8, Math.max(0.2, ratio));
}

export function AgentBeside({ conversation, page }: { conversation: ReactNode; page: ReactNode }) {
	const t = useT();
	const rootRef = useRef<HTMLDivElement>(null);
	const dragging = useRef(false);
	const [ratio, setRatio] = useState(0.5);
	const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
		const bounds = rootRef.current?.getBoundingClientRect();
		return bounds ? clampRatio((event.clientX - bounds.left) / bounds.width) : ratio;
	};
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		setRatio(value => clampRatio(value + (event.key === "ArrowRight" ? RATIO_STEP : -RATIO_STEP)));
	};
	const finish = (event: PointerEvent<HTMLDivElement>) => {
		if (!dragging.current) return;
		dragging.current = false;
		event.currentTarget.releasePointerCapture(event.pointerId);
	};
	return (
		<div
			className="omp-agent-beside grid min-h-0 flex-1"
			ref={rootRef}
			style={{
				gridTemplateColumns: `${ratio}fr ${DIVIDER_SIZE}px ${1 - ratio}fr`,
				gridTemplateRows: "minmax(0, 1fr)",
			}}
		>
			<div className="relative flex min-h-0 min-w-0 flex-col overflow-hidden">{conversation}</div>
			<div
				aria-label={t("split.resize")}
				aria-orientation="vertical"
				aria-valuemax={80}
				aria-valuemin={20}
				aria-valuenow={Math.round(ratio * 100)}
				className={cx(
					"omp-split-divider group relative z-20 cursor-col-resize touch-none bg-[var(--omp-border-muted)] focus-visible:bg-[var(--omp-accent)]",
				)}
				onKeyDown={onKeyDown}
				onPointerCancel={finish}
				onPointerDown={event => {
					dragging.current = true;
					event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onPointerMove={event => {
					if (dragging.current) setRatio(fromPointer(event));
				}}
				onPointerUp={finish}
				role="separator"
				tabIndex={0}
			>
				<span className="pointer-events-none absolute inset-0 m-auto flex h-5 w-5 items-center justify-center rounded-full bg-[var(--omp-bg-elevated)] text-[var(--omp-dim)] opacity-0 shadow-sm transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
					<Columns2 size={12} />
				</span>
			</div>
			<div className="relative flex min-h-0 min-w-0 flex-col overflow-hidden">{page}</div>
		</div>
	);
}
