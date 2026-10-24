/**
 * /btw store: history snapshot + streaming frames. `ask` starts a topic (or a
 * follow-up when a record id is passed), deltas append to the running answer,
 * and only a completed turn becomes branchable.
 */

import { describe, expect, it, vi } from "vitest";
import {
	type BtwHistoryRecord,
	getBtwCopyText,
	getBtwLatestTurn,
	getBtwTurns,
	type RpcCommand,
	type RpcResponse,
} from "../../shared/rpc-types";
import { createBtwStore } from "./btw";

function record(overrides: Partial<BtwHistoryRecord> = {}): BtwHistoryRecord {
	return {
		id: "topic-1",
		leafId: "leaf-1",
		question: "why?",
		answer: "",
		status: "running",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function ok(command: string, data?: unknown): RpcResponse {
	return { type: "response", command, success: true, data };
}

function transport(handler: (command: RpcCommand) => RpcResponse) {
	return vi.fn(async (command: RpcCommand) => handler(command));
}

describe("createBtwStore", () => {
	it("starts a topic, selects it, and clears the branchable record", async () => {
		const command = transport(cmd => (cmd.type === "btw" ? ok("btw", { record: record() }) : ok(cmd.type)));
		const store = createBtwStore(command);

		const started = await store.getState().ask("why?");

		expect(command).toHaveBeenCalledWith({ type: "btw", question: "why?" }, 120_000);
		expect(started.id).toBe("topic-1");
		expect(store.getState().records.map(entry => entry.id)).toEqual(["topic-1"]);
		expect(store.getState().selectedId).toBe("topic-1");
		expect(store.getState().branchableId).toBeNull();
	});

	it("continues an existing topic when a record id is passed", async () => {
		const command = transport(cmd => (cmd.type === "btw" ? ok("btw", { record: record() }) : ok(cmd.type)));
		const store = createBtwStore(command);

		await store.getState().ask("more", "topic-1");

		expect(command).toHaveBeenCalledWith({ type: "btw", question: "more", recordId: "topic-1" }, 120_000);
	});

	it("appends streamed deltas to the running answer", async () => {
		const command = transport(cmd => (cmd.type === "btw" ? ok("btw", { record: record() }) : ok(cmd.type)));
		const store = createBtwStore(command);
		await store.getState().ask("why?");

		store.getState().applyFrame({ type: "btw_delta", recordId: "topic-1", delta: "Because " });
		store.getState().applyFrame({ type: "btw_delta", recordId: "topic-1", delta: "reasons." });

		expect(store.getState().records[0]?.answer).toBe("Because reasons.");
	});

	it("ignores deltas for unknown or already settled topics", async () => {
		const command = transport(cmd => (cmd.type === "btw" ? ok("btw", { record: record() }) : ok(cmd.type)));
		const store = createBtwStore(command);
		await store.getState().ask("why?");

		store.getState().applyFrame({ type: "btw_delta", recordId: "someone-else", delta: "leak" });
		expect(store.getState().records).toHaveLength(1);

		store.getState().applyFrame({
			type: "btw_record",
			record: record({ status: "complete", answer: "done" }),
		});
		store.getState().applyFrame({ type: "btw_delta", recordId: "topic-1", delta: " late" });
		expect(store.getState().records[0]?.answer).toBe("done");
	});

	it("makes a completed turn branchable and clears it on cancellation", async () => {
		const command = transport(cmd => (cmd.type === "btw" ? ok("btw", { record: record() }) : ok(cmd.type)));
		const store = createBtwStore(command);
		await store.getState().ask("why?");

		store.getState().applyFrame({
			type: "btw_record",
			record: record({ status: "complete", answer: "done" }),
		});
		expect(store.getState().branchableId).toBe("topic-1");

		store.getState().applyFrame({ type: "btw_record", record: record({ status: "cancelled" }) });
		expect(store.getState().branchableId).toBeNull();
	});

	it("loads history newest-first and keeps a selection that still exists", async () => {
		const newer = record({ id: "b", question: "newer", answer: "B", status: "complete", createdAt: 2 });
		const older = record({ id: "a", question: "older", answer: "A", status: "complete", createdAt: 1 });
		const command = transport(cmd =>
			cmd.type === "get_btw_history" ? ok("get_btw_history", { records: [newer, older] }) : ok(cmd.type),
		);
		const store = createBtwStore(command);

		await store.getState().refresh();
		expect(store.getState().records.map(entry => entry.id)).toEqual(["b", "a"]);
		expect(store.getState().selectedId).toBe("b");

		store.getState().select("a");
		await store.getState().refresh();
		expect(store.getState().selectedId).toBe("a");
	});

	it("keeps a fresher local running answer over an older snapshot", async () => {
		const command = transport(cmd => {
			if (cmd.type === "btw") return ok("btw", { record: record({ updatedAt: 1 }) });
			return ok("get_btw_history", { records: [record({ updatedAt: 1, answer: "snap" })] });
		});
		const store = createBtwStore(command);
		await store.getState().ask("why?");
		store.getState().applyFrame({ type: "btw_delta", recordId: "topic-1", delta: "live" });

		await store.getState().refresh();

		expect(store.getState().records[0]?.answer).toBe("live");
	});

	it("keeps a locally running topic that an older snapshot omits", async () => {
		const command = transport(cmd =>
			cmd.type === "btw" ? ok("btw", { record: record() }) : ok("get_btw_history", { records: [] }),
		);
		const store = createBtwStore(command);
		await store.getState().ask("why?");

		await store.getState().refresh();

		expect(store.getState().records.map(entry => entry.id)).toEqual(["topic-1"]);
	});

	it("does not regress a completed topic from a stale running snapshot", async () => {
		const command = transport(cmd => {
			if (cmd.type === "btw") return ok("btw", { record: record({ updatedAt: 1 }) });
			return ok("get_btw_history", { records: [record({ updatedAt: 1 })] });
		});
		const store = createBtwStore(command);
		await store.getState().ask("why?");
		store.getState().applyFrame({
			type: "btw_record",
			record: record({ status: "complete", answer: "done", updatedAt: 2 }),
		});

		await store.getState().refresh();

		expect(store.getState().records[0]?.status).toBe("complete");
		expect(store.getState().records[0]?.answer).toBe("done");
	});

	it("keeps a completed local topic missing from the snapshot", async () => {
		const command = transport(cmd =>
			cmd.type === "btw" ? ok("btw", { record: record() }) : ok("get_btw_history", { records: [] }),
		);
		const store = createBtwStore(command);
		await store.getState().ask("why?");
		store.getState().applyFrame({
			type: "btw_record",
			record: record({ status: "complete", answer: "done" }),
		});

		await store.getState().refresh();

		expect(store.getState().records.map(entry => entry.id)).toEqual(["topic-1"]);
		expect(store.getState().records[0]?.status).toBe("complete");
	});

	it("takes the new follow-up turn from a late btw response", async () => {
		let call = 0;
		const command = transport(cmd => {
			if (cmd.type !== "btw") return ok(cmd.type);
			call++;
			if (call === 1) return ok("btw", { record: record({ status: "complete", answer: "first" }) });
			return ok("btw", {
				record: record({
					status: "complete",
					answer: "first",
					followUps: [{ question: "more", answer: "", status: "running", createdAt: 2, updatedAt: 2 }],
				}),
			});
		});
		const store = createBtwStore(command);
		await store.getState().ask("why?");
		await store.getState().ask("more", "topic-1");

		const merged = store.getState().records[0]!;
		expect(merged.followUps?.[0]?.question).toBe("more");
		expect(getBtwLatestTurn(merged).status).toBe("running");
	});

	it("does not reselect a topic after starting a new question", async () => {
		const command = transport(cmd => (cmd.type === "btw" ? ok("btw", { record: record() }) : ok(cmd.type)));
		const store = createBtwStore(command);
		await store.getState().ask("why?");
		store.getState().select(null);

		store.getState().applyFrame({ type: "btw_record", record: record({ answer: "more", updatedAt: 2 }) });

		expect(store.getState().selectedId).toBeNull();
	});

	it("re-reads history when the sidecar has nothing to cancel", async () => {
		const command = transport(cmd => {
			if (cmd.type === "btw") return ok("btw", { record: record() });
			if (cmd.type === "btw_cancel") return ok("btw_cancel", { cancelled: false });
			if (cmd.type === "get_btw_history")
				return ok("get_btw_history", { records: [record({ status: "complete", answer: "done" })] });
			return ok(cmd.type);
		});
		const store = createBtwStore(command);
		await store.getState().ask("why?");

		await store.getState().cancel("topic-1");

		expect(command).toHaveBeenCalledWith({ type: "get_btw_history" }, 30_000);
		expect(store.getState().records[0]?.status).toBe("complete");
	});

	it("surfaces a failed history load and reset clears the state", async () => {
		const command = transport(cmd =>
			cmd.type === "get_btw_history"
				? { type: "response", command: "get_btw_history", success: false, error: "disk unavailable" }
				: ok(cmd.type),
		);
		const store = createBtwStore(command);

		await store.getState().refresh();
		expect(store.getState().error).toContain("disk unavailable");
		expect(store.getState().loading).toBe(false);

		store.getState().select("topic-1");
		store.getState().reset();
		expect(store.getState()).toMatchObject({ records: [], selectedId: null, error: null, pending: false });
	});
});

describe("btw record helpers", () => {
	it("lists the root turn before follow-ups and copies the latest nonblank answer", () => {
		const root = record({ answer: "first" });
		const withFollowUps = record({
			answer: "first",
			followUps: [
				{ question: "more", answer: "second", status: "complete", createdAt: 2, updatedAt: 2 },
				{ question: "even more", answer: "  ", status: "cancelled", createdAt: 3, updatedAt: 3 },
			],
		});

		expect(getBtwTurns(root).map(turn => turn.question)).toEqual(["why?"]);
		expect(getBtwTurns(withFollowUps).map(turn => turn.question)).toEqual(["why?", "more", "even more"]);
		expect(getBtwCopyText(withFollowUps)).toBe("second");
		expect(getBtwCopyText(record({ answer: "   " }))).toBeUndefined();
	});
});
