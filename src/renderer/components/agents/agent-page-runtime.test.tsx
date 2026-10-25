/**
 * The subagent page's runtime (plan/24 §6): it reads the agent's transcript
 * into its own stores, keeps reading while the agent works, and never lets the
 * page act on the session. A regression puts a subagent's tool cards into the
 * conversation, sends a mutation from a page, or keeps polling a finished
 * agent.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { StoreApi } from "zustand/vanilla";
import type { AgentMessage, RpcCommand, RpcResponse, SubagentSnapshot } from "../../../shared/rpc-types";
import type { MessagesStore } from "../../stores/messages";
import { createSessionStore } from "../../stores/session";
import type { RuntimeStoreKey, SessionRuntime } from "../../stores/session-runtime-context";
import { createToolsStore, type ToolsStore } from "../../stores/tools";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

// Deferred until after the globals above: react-dom computes DOM support
// flags at evaluation time.
const { createRoot } = await import("react-dom/client");
const { createAgentPageRuntime, useAgentTranscript } = await import("./agent-page-runtime");

const POLL_MS = 50;

function readCall(id: string, path: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
	} as AgentMessage;
}

function readResult(id: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text: "ok" }],
	} as AgentMessage;
}

function snapshot(status: string): SubagentSnapshot {
	return { id: "a1", index: 0, agent: "explore", status, sessionFile: "/tmp/a1.jsonl", lastUpdate: 1 };
}

/** The agent's transcript file, served in the slices `fromByte` asks for. */
const slices: Record<number, { messages: AgentMessage[]; nextByte: number }> = {
	0: { messages: [readCall("t1", "src/a.ts")], nextByte: 100 },
	100: { messages: [readResult("t1"), readCall("t2", "src/b.ts")], nextByte: 200 },
	200: { messages: [readResult("t2")], nextByte: 300 },
	300: { messages: [], nextByte: 300 },
};

let parentCommand: Mock<(command: RpcCommand) => Promise<RpcResponse>>;
let parent: SessionRuntime;
let container: HTMLElement;
let root: Root;

beforeEach(() => {
	vi.useFakeTimers();
	parentCommand = vi.fn(async (command: RpcCommand): Promise<RpcResponse> => {
		if (command.type !== "get_subagent_messages") {
			return { type: "response", command: command.type, success: true, data: {} };
		}
		return { type: "response", command: command.type, success: true, data: slices[command.fromByte ?? 0] };
	});
	parent = {
		tabId: "t1",
		command: parentCommand,
		stores: new Map<RuntimeStoreKey, StoreApi<unknown>>([
			["session", createSessionStore()],
			["tools", createToolsStore()],
		]),
	};
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
});

afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
});

function Reader({ runtime, agent }: { runtime: SessionRuntime; agent: SubagentSnapshot }) {
	useAgentTranscript(runtime, agent, POLL_MS);
	return null;
}

function stateOf<T>(runtime: SessionRuntime, key: RuntimeStoreKey): T {
	const store = runtime.stores.get(key);
	if (!store) throw new Error(`no ${key} store`);
	return store.getState() as T;
}

function fromBytes(): number[] {
	return parentCommand.mock.calls
		.map(([command]) => command)
		.filter(command => command.type === "get_subagent_messages")
		.map(command => (command.type === "get_subagent_messages" ? (command.fromByte ?? 0) : -1));
}

async function tick(ms: number): Promise<void> {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

describe("agent page runtime", () => {
	it("passes reads to the session and refuses everything else", async () => {
		const page = createAgentPageRuntime(parent, "a1");

		const abort = await page.command({ type: "abort" });
		const read = await page.command({ type: "get_subagent_messages", subagentId: "a1", fromByte: 0 });

		expect(abort.success).toBe(false);
		expect(read.success).toBe(true);
		expect(parentCommand.mock.calls.map(([command]) => command.type)).toEqual(["get_subagent_messages"]);
	});

	it("appends what the agent writes while it works, and stops after one last read", async () => {
		const page = createAgentPageRuntime(parent, "a1");
		await act(async () => root.render(<Reader agent={snapshot("running")} runtime={page} />));
		await tick(0);
		await tick(POLL_MS);
		expect(fromBytes()).toEqual([0, 100]);

		await act(async () => root.render(<Reader agent={snapshot("completed")} runtime={page} />));
		await tick(POLL_MS * 4);
		expect(fromBytes()).toEqual([0, 100, 200]);

		expect(stateOf<MessagesStore>(page, "messages").messages).toHaveLength(4);
		expect([...stateOf<ToolsStore>(page, "tools").activeTools.keys()].sort()).toEqual(["t1", "t2"]);
		// The conversation's own tool cards are untouched.
		expect(stateOf<ToolsStore>(parent, "tools").activeTools.size).toBe(0);
	});
});
