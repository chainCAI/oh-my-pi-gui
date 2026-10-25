/**
 * Synthetic scheduled tasks and run history for the showcase capture, written
 * through the scheduler's own store into the profile's scheduler.db. Times are
 * relative to `now` because the scheduler in the main process runs on the real
 * clock: tasks saved "just now" record no missed slots on launch.
 */

import { SchedulerStore } from "../src/main/scheduler/store";
import type { RunReport, ScheduledTask, TaskRun } from "../src/shared/scheduler-types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const HISTORY_DAYS = 13;
// The app shows schedules and run times in local time, so the demo schedules use it too.
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

type StoredTask = Omit<ScheduledTask, "nextFireAt">;

/** Writes the demo tasks and their history; returns the task titles, first shown first. */
export function seedScheduledTasks(dbPath: string, project: string, language: "en" | "zh", now: number): string[] {
	const text = (en: string, zh: string) => (language === "zh" ? zh : en);
	const base = {
		cwd: project,
		model: null,
		timeoutMs: 30 * MINUTE,
		revision: 1,
		createdAt: now - (HISTORY_DAYS + 1) * DAY,
		updatedAt: now,
		origin: { sessionPath: null, createdBy: "agent" as const },
	};
	const dashboard: StoredTask = {
		...base,
		id: "task-dashboard",
		title: text("Check the dashboard for regressions", "检查仪表盘回归"),
		prompt: text(
			"Open the staging dashboard, compare today's error rate and p95 latency with last week, and report anything that moved.",
			"打开预发布环境仪表盘，把今天的错误率和 p95 延迟与上周对比，报告有变化的指标。",
		),
		schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: TZ },
		tools: "read_only",
		verify: null,
		notify: "on_failure",
		state: "active",
	};
	const dependencies: StoredTask = {
		...base,
		id: "task-dependencies",
		title: text("Update dependencies and run the tests", "更新依赖并运行测试"),
		prompt: text(
			"Update patch and minor dependency versions, run the test suite, and summarize what changed.",
			"更新补丁和次版本依赖，运行测试，并总结改动内容。",
		),
		schedule: { kind: "cron", expr: "0 3 * * 1", tz: TZ },
		tools: "workspace",
		verify: { command: "bun test", timeoutMs: 10 * MINUTE },
		notify: "on_change",
		state: "active",
		origin: { sessionPath: null, createdBy: "user" },
	};
	const pullRequests: StoredTask = {
		...base,
		id: "task-pull-requests",
		title: text("Summarize open pull requests", "汇总待处理的 PR"),
		prompt: text(
			"List open pull requests, note which are waiting on review or failing checks, and keep it to five lines.",
			"列出待处理的 PR，标出等待审查或检查失败的，控制在五行以内。",
		),
		// Next slot two hours out, so nothing fires while the capture runs.
		schedule: { kind: "interval", everyMs: 8 * HOUR, anchor: now + 2 * HOUR - 60 * 8 * HOUR },
		tools: "read_only",
		verify: null,
		notify: "always",
		state: "active",
	};
	const accessibility: StoredTask = {
		...base,
		id: "task-accessibility",
		title: text("Audit new components for accessibility", "审查新组件的无障碍"),
		prompt: text(
			"Check components added this week for labels, focus order and contrast.",
			"检查本周新增组件的标签、焦点顺序和对比度。",
		),
		schedule: { kind: "cron", expr: "30 16 * * 5", tz: TZ },
		tools: "read_only",
		verify: null,
		notify: "on_change",
		state: "paused",
	};

	const runs: TaskRun[] = [];
	const day = (offset: number, hour: number) => {
		const start = new Date(now - offset * DAY);
		start.setHours(hour, 0, 0, 0);
		return start.getTime();
	};
	const finished = (
		task: StoredTask,
		scheduledFor: number,
		minutes: number,
		cost: number,
		report: RunReport,
		extra: Partial<TaskRun> = {},
	): TaskRun => ({
		id: `run-${task.id}-${scheduledFor}`,
		taskId: task.id,
		taskRevision: 1,
		trigger: "schedule",
		scheduledFor,
		createdAt: scheduledFor,
		state: "succeeded",
		startedAt: scheduledFor + 2_000,
		endedAt: scheduledFor + 2_000 + minutes * MINUTE,
		report,
		blocked: [],
		changedFiles: [],
		verification: { state: "none" },
		review: { state: "none" },
		usage: {
			inputTokens: Math.round(cost * 160_000),
			outputTokens: Math.round(cost * 9_000),
			costUsd: cost,
			turns: 6,
		},
		model: "claude-sonnet-4-5",
		...extra,
	});
	const quiet = (summary: string): RunReport => ({ status: "nothing_to_report", summary, findings: [], changes: [] });

	for (let offset = HISTORY_DAYS; offset >= 1; offset--) {
		const weekday = new Date(day(offset, 9)).getDay();
		if (weekday >= 1 && weekday <= 5) {
			if (offset === 4) {
				runs.push(
					finished(dashboard, day(offset, 9), 1, 0.02, quiet(""), {
						state: "failed",
						report: undefined,
						error: { message: "429 Too Many Requests: rate limit reached", kind: "transient" },
					}),
				);
			} else if (offset === 6) {
				runs.push(
					finished(dashboard, day(offset, 9), 3, 0.11, {
						status: "done",
						summary: text(
							"p95 latency on /api/search rose from 180 ms to 260 ms after Tuesday's deploy.",
							"周二部署后 /api/search 的 p95 延迟从 180 ms 升到 260 ms。",
						),
						findings: [
							{
								title: text("Search latency regressed", "搜索延迟回退"),
								severity: "warn",
							},
						],
						changes: [],
					}),
				);
			} else {
				runs.push(
					finished(
						dashboard,
						day(offset, 9),
						2,
						0.06 + (offset % 3) * 0.01,
						quiet(text("Error rate and latency match last week.", "错误率和延迟与上周持平。")),
					),
				);
			}
		}
		for (const hour of [2, 10, 18]) {
			runs.push(
				finished(
					pullRequests,
					day(offset, hour),
					1,
					0.03 + (hour % 4) * 0.005,
					quiet(text("Four open pull requests; one waits on review.", "4 个待处理 PR，其中 1 个等待审查。")),
				),
			);
		}
		if (weekday === 1) {
			const latest = offset <= 7;
			runs.push(
				finished(
					dependencies,
					day(offset, 3),
					7,
					0.38,
					{
						status: "done",
						summary: text(
							"Updated 6 packages to their latest patch versions; all 214 tests pass.",
							"6 个依赖更新到最新补丁版本，214 项测试全部通过。",
						),
						findings: [],
						changes: [
							{ path: "package.json", note: text("6 version bumps", "6 处版本更新") },
							{ path: "bun.lock" },
						],
					},
					{
						changedFiles: ["package.json", "bun.lock"],
						verification: { state: "passed", exitCode: 0 },
						review: latest ? { state: "pending" } : { state: "accepted", at: day(offset, 9) },
						worktree: {
							path: `${project}-worktrees/task-update-dependencies-${offset}`,
							branch: `omp/task-update-dependencies-${offset}`,
							baseCwd: project,
							removed: !latest,
							committed: true,
						},
					},
				),
			);
		}
	}

	const store = new SchedulerStore(dbPath);
	try {
		for (const task of [dashboard, dependencies, pullRequests, accessibility]) store.saveTask(task);
		for (const run of runs) store.saveRun(run);
	} finally {
		store.close();
	}
	return [dashboard.title, dependencies.title, pullRequests.title, accessibility.title];
}
