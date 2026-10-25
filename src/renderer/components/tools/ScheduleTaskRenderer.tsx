import { CalendarClock } from "lucide-react";
import type { TaskSchedule } from "../../../shared/scheduler-types";
import { useT } from "../../lib/i18n";
import { useSchedulerStore } from "../../stores/scheduler";
import { scheduleLabel } from "../tasks/task-format";
import { resultBodyText, resultDetails } from "./result";
import type { ToolRendererProps } from "./ToolCard";

/**
 * `schedule_task` (plan/23 §5): the agent's draft as a one-line task, then
 * either "waiting for you" while the confirm card is open, or what the user
 * decided. The task itself lives in Scheduled Tasks, linked from here.
 */

function draftSchedule(args: Record<string, unknown>): TaskSchedule | null {
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	if (args.scheduleKind === "cron" && typeof args.cron === "string" && args.cron.trim()) {
		return { kind: "cron", expr: args.cron.trim(), tz: zone };
	}
	if (args.scheduleKind === "interval" && typeof args.everyMinutes === "number" && args.everyMinutes > 0) {
		return { kind: "interval", everyMs: args.everyMinutes * 60_000, anchor: 0 };
	}
	if (args.scheduleKind === "once" && typeof args.at === "string") {
		const at = Date.parse(args.at);
		if (Number.isFinite(at)) return { kind: "once", at };
	}
	return null;
}

export function ScheduleTaskRenderer({ args, result, isError, isPartial }: ToolRendererProps) {
	const t = useT();
	const title = typeof args.title === "string" ? args.title : "";
	const schedule = draftSchedule(args);
	const details = isPartial ? undefined : resultDetails(result);
	const created = !isError && details?.outcome === "created";
	const reason = typeof details?.reason === "string" ? details.reason.trim() : "";
	const status = isPartial
		? t("tools.scheduleTask.waiting")
		: isError
			? t("tools.scheduleTask.notShown")
			: created
				? t("tools.scheduleTask.created")
				: t("tools.scheduleTask.declined");

	return (
		<div className="flex flex-col gap-1.5">
			<div className="flex min-w-0 items-center gap-1.5 text-omp-sm">
				<CalendarClock
					size={12}
					className={
						isError
							? "shrink-0 text-(--omp-error)"
							: created
								? "shrink-0 text-(--omp-success)"
								: "shrink-0 text-(--omp-muted)"
					}
				/>
				<span className="min-w-0 truncate font-semibold text-(--omp-text)">
					{title || t("tools.scheduleTask.title")}
				</span>
				{schedule && <span className="shrink-0 text-(--omp-muted)">· {scheduleLabel(t, schedule)}</span>}
			</div>
			<p className={isPartial ? "omp-shimmer-text text-omp-sm" : "text-omp-sm text-(--omp-dim)"}>{status}</p>
			{isError && (
				<p className="text-omp-sm break-words whitespace-pre-wrap text-(--omp-muted)">
					{resultBodyText(result).trim()}
				</p>
			)}
			{reason && (
				<p className="text-omp-sm break-words text-(--omp-muted)">{t("tools.scheduleTask.reason", { reason })}</p>
			)}
			{created && (
				<button
					className="self-start text-omp-sm text-(--omp-link) hover:underline"
					onClick={() => useSchedulerStore.getState().openTasks({ view: "tasks" })}
					type="button"
				>
					{t("tools.scheduleTask.open")}
				</button>
			)}
		</div>
	);
}
