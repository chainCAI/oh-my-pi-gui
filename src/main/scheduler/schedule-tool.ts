/**
 * The `schedule_task` tool agent tabs get (plan/23 §5): its definition, and
 * the mapping from the agent's arguments to a draft the user confirms. The
 * draft is always read-only with no model pin; only the user raises either.
 */

import type { HostToolDefinition } from "../../shared/rpc-types";
import type { ScheduleRequestOutcome, TaskDraft, TaskSchedule } from "../../shared/scheduler-types";
import { DEFAULT_TIMEOUT_MS } from "./policy";
import scheduleTaskDescription from "./prompts/schedule-task-tool.md?raw";

export const SCHEDULE_TASK_TOOL = "schedule_task";

export const SCHEDULE_TASK_TOOL_DEFINITION: HostToolDefinition = {
	name: SCHEDULE_TASK_TOOL,
	label: "Schedule task",
	description: scheduleTaskDescription.trim(),
	loadMode: "essential",
	parameters: {
		type: "object",
		properties: {
			title: { type: "string", description: "Short name for the task, under 60 characters." },
			prompt: { type: "string", description: "Complete instructions for each run." },
			scheduleKind: { type: "string", enum: ["cron", "interval", "once"] },
			cron: { type: "string", description: "Five-field cron in the user's local time, or empty." },
			everyMinutes: { type: "number", description: "Interval in minutes (at least 5), or 0." },
			at: { type: "string", description: "ISO 8601 date-time for a one-off run, or empty." },
			suggestedModel: { type: "string", description: "A model to suggest to the user, or empty." },
			reason: { type: "string", description: "One sentence on why this should be scheduled." },
		},
		required: ["title", "prompt", "scheduleKind", "cron", "everyMinutes", "at", "suggestedModel", "reason"],
		additionalProperties: false,
	},
};

export interface ScheduleToolContext {
	cwd: string;
	now: number;
	timeZone: string;
	sessionPath: string | null;
}

export type ParsedScheduleTool =
	| { ok: true; draft: TaskDraft; suggestedModel: string | null; reason: string }
	| { ok: false; error: string };

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export function parseScheduleToolArgs(args: Record<string, unknown>, context: ScheduleToolContext): ParsedScheduleTool {
	const title = text(args.title).slice(0, 80);
	const prompt = text(args.prompt);
	if (!title) return { ok: false, error: "title is required" };
	if (!prompt) return { ok: false, error: "prompt is required" };
	let schedule: TaskSchedule;
	switch (args.scheduleKind) {
		case "cron": {
			const expr = text(args.cron);
			if (!expr) return { ok: false, error: "cron is required when scheduleKind is cron" };
			schedule = { kind: "cron", expr, tz: context.timeZone };
			break;
		}
		case "interval": {
			const minutes = typeof args.everyMinutes === "number" ? args.everyMinutes : Number(args.everyMinutes);
			if (!Number.isFinite(minutes) || minutes <= 0) {
				return { ok: false, error: "everyMinutes must be a positive number when scheduleKind is interval" };
			}
			const everyMs = Math.round(minutes) * 60_000;
			schedule = { kind: "interval", everyMs, anchor: context.now + everyMs };
			break;
		}
		case "once": {
			const at = Date.parse(text(args.at));
			if (!Number.isFinite(at))
				return { ok: false, error: "at must be an ISO 8601 date-time when scheduleKind is once" };
			schedule = { kind: "once", at };
			break;
		}
		default:
			return { ok: false, error: "scheduleKind must be cron, interval or once" };
	}
	return {
		ok: true,
		draft: {
			title,
			prompt,
			cwd: context.cwd,
			schedule,
			model: null,
			tools: "read_only",
			timeoutMs: DEFAULT_TIMEOUT_MS,
			verify: null,
			notify: "on_change",
			origin: { sessionPath: context.sessionPath, createdBy: "agent" },
			startPaused: false,
		},
		suggestedModel: text(args.suggestedModel) || null,
		reason: text(args.reason),
	};
}

/** What the agent reads back once the user answered the card. */
export function scheduleOutcomeText(outcome: ScheduleRequestOutcome): string {
	if (outcome.kind === "declined") {
		return outcome.reason
			? `The user declined to schedule this task. Their reason: ${outcome.reason}`
			: "The user declined to schedule this task.";
	}
	const first =
		outcome.nextFireAt === null ? "not scheduled yet (created paused)" : new Date(outcome.nextFireAt).toISOString();
	const access =
		outcome.tools === "read_only"
			? "Runs are read-only."
			: "Runs can edit files in a fresh git worktree, reviewed by the user.";
	return `The user created the scheduled task "${outcome.title}" (id ${outcome.taskId}). First run: ${first}. ${access} Results appear in Scheduled Tasks, not in this conversation.`;
}
