/**
 * The agent asked to schedule a task (`schedule_task`). Nothing is created
 * until the user confirms here; they can edit every field, and the agent is
 * told what they decided. One draft at a time, oldest first.
 */

import { CalendarClock } from "lucide-react";
import { useEffect, useState } from "react";
import type { ScheduleTaskRequest, TaskDraft } from "../../../shared/scheduler-types";
import { useT } from "../../lib/i18n";
import { useSchedulerStore } from "../../stores/scheduler";
import { useTabsStore } from "../../stores/tabs";
import { Button, Input, Modal } from "../common";
import { TaskForm, useDraftProblems } from "./TaskForm";

function RequestBody({ request }: { request: ScheduleTaskRequest }) {
	const t = useT();
	const [draft, setDraft] = useState<TaskDraft>(request.draft);
	const [declining, setDeclining] = useState(false);
	const [reason, setReason] = useState("");
	const [saving, setSaving] = useState(false);
	const problems = useDraftProblems(draft);
	const respond = useSchedulerStore(state => state.respond);
	const tabTitle = useTabsStore(state => state.tabs.find(tab => tab.id === request.tabId)?.title);

	const create = async () => {
		setSaving(true);
		try {
			const result = await useSchedulerStore.getState().save(draft);
			if (result.ok) {
				await respond(request.requestId, {
					kind: "created",
					taskId: result.task.id,
					title: result.task.title,
					nextFireAt: result.task.nextFireAt,
					tools: result.task.tools,
				});
			}
		} finally {
			setSaving(false);
		}
	};

	return (
		<div className="flex max-h-[min(82dvh,54rem)] flex-col">
			<div className="flex shrink-0 items-start gap-3 border-b border-(--omp-border-muted) px-5 py-3.5">
				<span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border border-(--omp-border-muted) text-(--omp-accent)">
					<CalendarClock size={16} />
				</span>
				<div className="min-w-0">
					<p className="text-omp-md text-(--omp-text)">
						{tabTitle ? t("tasks.request.fromTab", { tab: tabTitle }) : t("tasks.request.fromAgent")}
					</p>
					{request.reason && <p className="mt-0.5 text-omp-md text-(--omp-muted)">{request.reason}</p>}
				</div>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				<TaskForm draft={draft} onChange={setDraft} problems={problems} suggestedModel={request.suggestedModel} />
			</div>
			<div className="shrink-0 border-t border-(--omp-border-muted) px-5 py-3">
				{declining ? (
					<div className="omp-fade-up flex items-end gap-2">
						<div className="flex-1">
							<Input
								autoFocus
								label={t("tasks.request.declineReason")}
								onChange={event => setReason(event.target.value)}
								onKeyDown={event => {
									if (event.key === "Enter")
										void respond(request.requestId, { kind: "declined", reason: reason.trim() });
								}}
								placeholder={t("tasks.request.declinePlaceholder")}
								value={reason}
							/>
						</div>
						<Button onClick={() => setDeclining(false)} variant="ghost">
							{t("tasks.request.back")}
						</Button>
						<Button
							onClick={() => void respond(request.requestId, { kind: "declined", reason: reason.trim() })}
							variant="danger"
						>
							{t("tasks.request.decline")}
						</Button>
					</div>
				) : (
					<div className="flex items-center justify-between gap-3">
						<span className="text-omp-sm text-(--omp-dim)">{t("tasks.request.note")}</span>
						<div className="flex gap-2">
							<Button onClick={() => setDeclining(true)} size="sm" variant="ghost">
								{t("tasks.request.decline")}
							</Button>
							<Button
								disabled={problems.length > 0}
								loading={saving}
								onClick={() => void create()}
								size="sm"
								variant="primary"
							>
								{t("tasks.request.create")}
							</Button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

export function ScheduleRequestDialog() {
	const t = useT();
	const request = useSchedulerStore(state => state.requests[0] ?? null);
	const respond = useSchedulerStore(state => state.respond);
	const [shown, setShown] = useState<ScheduleTaskRequest | null>(request);
	useEffect(() => {
		if (request) setShown(request);
	}, [request]);

	return (
		<Modal
			bodyClassName="p-0"
			onClose={() => request && void respond(request.requestId, { kind: "declined", reason: "" })}
			open={request !== null}
			size="lg"
			title={t("tasks.request.title")}
		>
			{shown && <RequestBody key={shown.requestId} request={shown} />}
		</Modal>
	);
}
