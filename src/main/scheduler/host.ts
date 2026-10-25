/**
 * The scheduler inside Electron (plan/23 §2): owns scheduler.db, spawns run
 * sidecars, turns finished runs into notifications and the dock badge, pushes
 * snapshots to every window, and carries an agent's `schedule_task` draft to
 * the user's confirm card and the answer back to the agent.
 */

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { app, type BrowserWindow, ipcMain, Notification, powerMonitor } from "electron";
import { APPROVAL_APPROVE, approvalToolName } from "../../shared/approval-prompt";
import { IPC_COMMANDS, IPC_EVENTS } from "../../shared/ipc-types";
import type { ExtensionUIRequest, HostToolCallRequest, RpcCommand, RpcResponse } from "../../shared/rpc-types";
import type {
	ScheduleRequestOutcome,
	SchedulerLimits,
	SchedulerOpenTarget,
	ScheduleTaskRequest,
	TaskRun,
} from "../../shared/scheduler-types";
import { type MainTextKey, mainT } from "../i18n";
import type { SpawnWindow, WindowManager } from "../window";
import { asRequestOutcome, asTaskConfig, asTaskDraft } from "./guards";
import {
	executeRun,
	type RunnerDeps,
	type RunSidecar,
	type RunSidecarSpec,
	runMaintenanceScript,
	worktreeRemovalScript,
} from "./runner";
import {
	parseScheduleToolArgs,
	SCHEDULE_TASK_TOOL,
	SCHEDULE_TASK_TOOL_DEFINITION,
	scheduleOutcomeText,
} from "./schedule-tool";
import { Scheduler, type SchedulerNotice } from "./scheduler";
import { SchedulerStore } from "./store";

const SNAPSHOT_DEBOUNCE_MS = 100;

/** The slice of a pooled tab sidecar the host talks to. */
export interface TabSidecar {
	readonly cwd: string;
	readonly rpcClient: { command(cmd: RpcCommand): Promise<RpcResponse> } | null;
	sendSideChannel(frame: object): void;
	on(event: "frame", listener: (frame: Record<string, unknown>) => void): unknown;
	off(event: "frame", listener: (frame: Record<string, unknown>) => void): unknown;
}

export interface SchedulerHostDeps {
	dbPath: string;
	createRunSidecar(spec: RunSidecarSpec): RunSidecar;
	deleteSession(sessionPath: string): Promise<void>;
	windowManager: WindowManager;
	spawnWindow: SpawnWindow;
	log(message: string, details?: Record<string, unknown>): void;
}

interface PendingRequest {
	request: ScheduleTaskRequest;
	toolRequestId: string;
	sidecar: TabSidecar;
	win: BrowserWindow;
	onFrame: (frame: Record<string, unknown>) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const idOf = (payload: unknown, key: string): string => {
	const value = isRecord(payload) ? payload[key] : undefined;
	if (typeof value !== "string" || value === "") throw new Error(`${key} is required`);
	return value;
};

export class SchedulerHost {
	readonly scheduler: Scheduler;
	readonly #deps: SchedulerHostDeps;
	readonly #store: SchedulerStore;
	readonly #runSidecars = new Set<RunSidecar>();
	readonly #pending = new Map<string, PendingRequest>();
	#snapshotTimer: NodeJS.Timeout | null = null;
	#badge = -1;
	#disposed = false;

	constructor(deps: SchedulerHostDeps) {
		this.#deps = deps;
		this.#store = new SchedulerStore(deps.dbPath);
		const runnerDeps: RunnerDeps = {
			createSidecar: spec => this.#trackedSidecar(spec),
			now: Date.now,
			cwdExists: async path => {
				try {
					return (await stat(path)).isDirectory();
				} catch {
					return false;
				}
			},
		};
		this.scheduler = new Scheduler({
			store: this.#store,
			runner: input => executeRun(input, runnerDeps),
			now: Date.now,
			nextId: randomUUID,
			cleanup: {
				removeWorktree: async (worktree, { deleteBranch }) =>
					(await runMaintenanceScript(
						runnerDeps,
						worktree.baseCwd,
						worktreeRemovalScript(worktree, deleteBranch),
					)) === 0,
				deleteSession: sessionPath => deps.deleteSession(sessionPath),
			},
			notify: notice => this.#notify(notice),
			onChange: () => this.#scheduleSnapshot(),
			onProgress: (runId, progress) => this.#broadcast(IPC_EVENTS.SCHEDULER_PROGRESS, { runId, progress }),
		});
	}

	start(): void {
		this.#registerIpc();
		powerMonitor.on("resume", () => this.scheduler.wake());
		powerMonitor.on("unlock-screen", () => this.scheduler.wake());
		this.scheduler.start();
		this.#pushSnapshot();
	}

	/** Quit teardown: synchronous by contract, so live runs are recorded cancelled and their processes killed now. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		if (this.#snapshotTimer) clearTimeout(this.#snapshotTimer);
		void this.scheduler.stop();
		for (const sidecar of [...this.#runSidecars]) sidecar.dispose();
		for (const requestId of [...this.#pending.keys()])
			this.#answer(requestId, { kind: "declined", reason: "omp quit before you answered." });
	}

	/** Run sessions stay out of the sidebar; they open from the Tasks window. */
	runSessionPaths(): Set<string> {
		return this.scheduler.runSessionPaths();
	}

	// ------------------------------------------------- schedule_task (agent tabs)

	/** A tab's sidecar came up: give agent tabs the tool. */
	tabReady(tab: { tabId: string; kind: "agent" | "chat"; sidecar: TabSidecar }): void {
		if (tab.kind !== "agent") return;
		tab.sidecar.rpcClient
			?.command({ type: "set_host_tools", tools: [SCHEDULE_TASK_TOOL_DEFINITION] })
			.catch(error => this.#deps.log("set_host_tools failed", { tabId: tab.tabId, error: String(error) }));
	}

	/** A tab's process stopped: its pending drafts can no longer be answered. */
	/**
	 * omp gates host tools as exec, so a tab below yolo asks before
	 * `schedule_task` runs. The confirm card is that consent; the prompt in
	 * front of it is answered here. True when the request was answered.
	 */
	answerToolPrompt(sidecar: TabSidecar, request: ExtensionUIRequest): boolean {
		if (approvalToolName(request) !== SCHEDULE_TASK_TOOL) return false;
		sidecar.sendSideChannel({ type: "extension_ui_response", id: request.id, value: APPROVAL_APPROVE });
		return true;
	}

	tabDown(tabId: string): void {
		for (const [requestId, pending] of this.#pending) {
			if (pending.request.tabId === tabId) this.#close(requestId);
		}
	}

	/**
	 * Route one host tool call from a tab. Returns false for tools this host
	 * does not own. The answer is deferred until the user confirms or declines.
	 */
	handleToolCall(
		sidecar: TabSidecar,
		request: HostToolCallRequest,
		win: BrowserWindow,
		tab: { tabId: string; sessionFile: string | null } | null,
	): boolean {
		if (request.toolName !== SCHEDULE_TASK_TOOL) return false;
		const fail = (text: string) =>
			sidecar.sendSideChannel({
				type: "host_tool_result",
				id: request.id,
				result: { content: [{ type: "text", text }] },
				isError: true,
			});
		if (!tab || win.isDestroyed()) {
			fail("This conversation cannot schedule tasks.");
			return true;
		}
		const parsed = parseScheduleToolArgs(request.arguments, {
			cwd: sidecar.cwd,
			now: Date.now(),
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
			sessionPath: tab.sessionFile,
		});
		if (!parsed.ok) {
			fail(
				`The draft was not shown to the user: ${parsed.error}. Fix the arguments and call ${SCHEDULE_TASK_TOOL} again.`,
			);
			return true;
		}
		const scheduleRequest: ScheduleTaskRequest = {
			requestId: request.id,
			tabId: tab.tabId,
			draft: parsed.draft,
			suggestedModel: parsed.suggestedModel,
			reason: parsed.reason,
		};
		const onFrame = (frame: Record<string, unknown>) => {
			if (frame.type === "host_tool_cancel" && frame.targetId === request.id) this.#close(request.id);
		};
		sidecar.on("frame", onFrame);
		this.#pending.set(request.id, { request: scheduleRequest, toolRequestId: request.id, sidecar, win, onFrame });
		win.webContents.send(IPC_EVENTS.SCHEDULER_REQUEST, scheduleRequest);
		return true;
	}

	#answer(requestId: string, outcome: ScheduleRequestOutcome): void {
		const pending = this.#pending.get(requestId);
		if (!pending) return;
		let resolved = outcome;
		if (outcome.kind === "created") {
			const task = this.scheduler.getTask(outcome.taskId);
			resolved = task
				? { kind: "created", taskId: task.id, title: task.title, nextFireAt: task.nextFireAt, tools: task.tools }
				: { kind: "declined", reason: "" };
		}
		pending.sidecar.sendSideChannel({
			type: "host_tool_result",
			id: pending.toolRequestId,
			result: {
				content: [{ type: "text", text: scheduleOutcomeText(resolved) }],
				details:
					resolved.kind === "created"
						? { outcome: "created", taskId: resolved.taskId }
						: { outcome: "declined", reason: resolved.reason },
			},
		});
		this.#close(requestId);
	}

	#close(requestId: string): void {
		const pending = this.#pending.get(requestId);
		if (!pending) return;
		this.#pending.delete(requestId);
		pending.sidecar.off("frame", pending.onFrame);
		if (!pending.win.isDestroyed()) pending.win.webContents.send(IPC_EVENTS.SCHEDULER_REQUEST_CLOSED, { requestId });
	}

	// ------------------------------------------------------------- plumbing

	#trackedSidecar(spec: RunSidecarSpec): RunSidecar {
		const sidecar = this.#deps.createRunSidecar(spec);
		this.#runSidecars.add(sidecar);
		return {
			get status() {
				return sidecar.status;
			},
			get rpcClient() {
				return sidecar.rpcClient;
			},
			start: () => sidecar.start(),
			restart: cwd => sidecar.restart(cwd),
			dispose: () => {
				this.#runSidecars.delete(sidecar);
				sidecar.dispose();
			},
			sendSideChannel: frame => sidecar.sendSideChannel(frame),
			on: (event, listener) => sidecar.on(event, listener),
			off: (event, listener) => sidecar.off(event, listener),
		};
	}

	#scheduleSnapshot(): void {
		if (this.#disposed || this.#snapshotTimer) return;
		this.#snapshotTimer = setTimeout(() => {
			this.#snapshotTimer = null;
			this.#pushSnapshot();
		}, SNAPSHOT_DEBOUNCE_MS);
	}

	#pushSnapshot(): void {
		const snapshot = this.scheduler.snapshot();
		this.#broadcast(IPC_EVENTS.SCHEDULER_SNAPSHOT, snapshot);
		if (snapshot.reviewCount !== this.#badge) {
			this.#badge = snapshot.reviewCount;
			app.setBadgeCount(snapshot.reviewCount);
		}
	}

	#broadcast(channel: string, data: unknown): void {
		for (const win of this.#deps.windowManager.getAllWindows()) {
			if (!win.isDestroyed()) win.webContents.send(channel, data);
		}
	}

	#notify(notice: SchedulerNotice): void {
		if (!Notification.isSupported()) return;
		const { task, run } = notice;
		const params = { title: task.title };
		const [titleKey, body] = noticeText(notice);
		const notification = new Notification({ title: mainT(titleKey, undefined, params), body, silent: false });
		notification.on("click", () =>
			this.open({
				view: notice.kind === "run" && run.review.state === "pending" ? "review" : "runs",
				taskId: task.id,
				runId: run.id,
			}),
		);
		notification.show();
	}

	/** Bring a window forward and land it in the Tasks window. */
	open(target: SchedulerOpenTarget): void {
		let win = this.#deps.windowManager.getMainWindow();
		if (!win || win.isDestroyed()) win = this.#deps.spawnWindow() ?? null;
		if (!win) return;
		if (win.isMinimized()) win.restore();
		win.show();
		win.focus();
		const send = () => win?.webContents.send(IPC_EVENTS.SCHEDULER_OPEN, target);
		if (win.webContents.isLoading()) win.webContents.once("did-finish-load", send);
		else send();
	}

	#registerIpc(): void {
		const scheduler = this.scheduler;
		ipcMain.handle(IPC_COMMANDS.SCHEDULER_GET_SNAPSHOT, () => scheduler.snapshot());
		ipcMain.handle(IPC_COMMANDS.SCHEDULER_VALIDATE, (_event, payload: unknown) => {
			const draft = asTaskDraft(isRecord(payload) ? payload.draft : undefined);
			if (!draft) throw new Error("Invalid task draft");
			const editingId = isRecord(payload) && typeof payload.editingId === "string" ? payload.editingId : undefined;
			return scheduler.validate(draft, editingId);
		});
		ipcMain.handle(IPC_COMMANDS.SCHEDULER_CREATE, (_event, payload: unknown) => {
			const draft = asTaskDraft(isRecord(payload) ? payload.draft : undefined);
			if (!draft) throw new Error("Invalid task draft");
			return scheduler.createTask(draft);
		});
		ipcMain.handle(IPC_COMMANDS.SCHEDULER_UPDATE, (_event, payload: unknown) => {
			const config = asTaskConfig(isRecord(payload) ? payload.config : undefined);
			if (!config) throw new Error("Invalid task settings");
			return scheduler.updateTask(idOf(payload, "taskId"), config);
		});
		ipcMain.handle(IPC_COMMANDS.SCHEDULER_SET_ENABLED, (_event, payload: unknown) =>
			scheduler.setTaskEnabled(idOf(payload, "taskId"), isRecord(payload) && payload.enabled === true),
		);
		ipcMain.handle(IPC_COMMANDS.SCHEDULER_ARCHIVE, (_event, payload: unknown) =>
			scheduler.archiveTask(idOf(payload, "taskId"), isRecord(payload) && payload.cancelLive === true),
		);
		ipcMain.handle(IPC_COMMANDS.SCHEDULER_DELETE, (_event, payload: unknown) =>
			scheduler.deleteTask(idOf(payload, "taskId")),
		);
		ipcMain.handle(IPC_COMMANDS.SCHEDULER_RUN_NOW, (_event, payload: unknown) =>
			scheduler.runNow(idOf(payload, "taskId")),
		);
		ipcMain.handle(IPC_COMMANDS.SCHEDULER_CANCEL_RUN, (_event, payload: unknown) =>
			scheduler.cancelRun(idOf(payload, "runId")),
		);
		ipcMain.handle(IPC_COMMANDS.SCHEDULER_REVIEW, (_event, payload: unknown) => {
			const decision = isRecord(payload) ? payload.decision : undefined;
			if (decision !== "accepted" && decision !== "rejected") throw new Error("Invalid review decision");
			const note = isRecord(payload) && typeof payload.note === "string" ? payload.note.slice(0, 2000) : undefined;
			return scheduler.review(idOf(payload, "runId"), decision, note);
		});
		ipcMain.handle(IPC_COMMANDS.SCHEDULER_SET_PAUSED, (_event, payload: unknown) =>
			scheduler.setPaused(isRecord(payload) && payload.paused === true),
		);
		ipcMain.handle(IPC_COMMANDS.SCHEDULER_SET_LIMITS, (_event, payload: unknown) => {
			const patch = isRecord(payload) && isRecord(payload.patch) ? payload.patch : {};
			const next: Partial<Pick<SchedulerLimits, "maxConcurrentRuns" | "retainDays">> = {};
			if (typeof patch.maxConcurrentRuns === "number") next.maxConcurrentRuns = patch.maxConcurrentRuns;
			if (typeof patch.retainDays === "number") next.retainDays = patch.retainDays;
			scheduler.setLimits(next);
		});
		ipcMain.handle(IPC_COMMANDS.SCHEDULER_INSIGHTS, (_event, payload: unknown) => {
			const days = isRecord(payload) && typeof payload.periodDays === "number" ? payload.periodDays : 30;
			const taskId = isRecord(payload) && typeof payload.taskId === "string" ? payload.taskId : undefined;
			return scheduler.insights(Math.min(365, Math.max(1, Math.round(days))), taskId);
		});
		ipcMain.handle(IPC_COMMANDS.SCHEDULER_GET_RUN, (_event, payload: unknown) =>
			scheduler.getRun(idOf(payload, "runId")),
		);
		ipcMain.handle(IPC_COMMANDS.SCHEDULER_TASK_RUNS, (_event, payload: unknown): TaskRun[] =>
			scheduler.listTaskRuns(idOf(payload, "taskId")),
		);
		ipcMain.handle(IPC_COMMANDS.SCHEDULER_REVISIONS, (_event, payload: unknown) =>
			scheduler.listRevisions(idOf(payload, "taskId")),
		);
		ipcMain.handle(IPC_COMMANDS.SCHEDULER_RESPOND_REQUEST, (_event, payload: unknown) => {
			const outcome = asRequestOutcome(isRecord(payload) ? payload.outcome : undefined);
			if (!outcome) throw new Error("Invalid answer");
			this.#answer(idOf(payload, "requestId"), outcome);
		});
		ipcMain.handle(IPC_COMMANDS.SCHEDULER_PENDING_REQUESTS, event =>
			[...this.#pending.values()]
				.filter(pending => pending.win.webContents === event.sender)
				.map(pending => pending.request),
		);
	}
}

/** Notification title key and body for one notice. */
function noticeText(notice: SchedulerNotice): [MainTextKey, string] {
	const { run } = notice;
	if (notice.kind === "auth") return ["tasks.notify.auth", mainT("tasks.notify.authBody")];
	if (notice.kind === "disabled") {
		return [
			"tasks.notify.disabled",
			mainT(
				notice.task.disabledReason === "blocked_config"
					? "tasks.notify.disabledConfig"
					: "tasks.notify.disabledFailures",
			),
		];
	}
	const summary = run.report?.summary ?? run.error?.message ?? "";
	if (run.state === "missed") return ["tasks.notify.missed", mainT("tasks.notify.missedBody")];
	if (run.state === "blocked_config") return ["tasks.notify.blocked", summary];
	if (run.verification.state === "failed" || run.verification.state === "error")
		return ["tasks.notify.verifyFailed", summary];
	if (run.state === "failed" || run.state === "timed_out" || run.state === "unknown")
		return ["tasks.notify.failed", summary];
	if (run.review.state === "pending") return ["tasks.notify.review", summary];
	return ["tasks.notify.done", summary];
}
