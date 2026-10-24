/**
 * /btw dialog against the upstream streaming protocol: the `btw` response
 * carries the running record, `btw_delta` frames stream the answer, and
 * `btw_record` frames settle it. Same linkedom harness as the other dialogs.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BtwHistoryRecord, RpcBtwFrame, RpcCommand, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useBtwStore } from "../../stores/btw";
import { useUiStore } from "../../stores/ui";
import { BtwDialog } from "./BtwDialog";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

const elementPrototype = HTMLElement.prototype as unknown as Record<string, unknown>;
if (typeof elementPrototype.scrollIntoView !== "function") elementPrototype.scrollIntoView = () => {};
if (typeof elementPrototype.focus !== "function") elementPrototype.focus = () => {};

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

const command = vi.fn(async (cmd: RpcCommand): Promise<RpcResponse> => {
	if (cmd.type === "btw") return { type: "response", command: "btw", success: true, data: { record: record() } };
	if (cmd.type === "get_btw_history")
		return { type: "response", command: "get_btw_history", success: true, data: { records: [] } };
	return { type: "response", command: cmd.type, success: true };
});

Object.assign(window as unknown as Record<string, unknown>, { omp: { rpc: { command } } });

let container: InstanceType<typeof HTMLElement> | null = null;
let root: Root | null = null;

async function mount(): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<BtwDialog />
			</I18nProvider>,
		);
	});
}

function button(label: string): HTMLButtonElement | undefined {
	return [...document.querySelectorAll("button")].find(node => node.textContent?.includes(label)) as
		| HTMLButtonElement
		| undefined;
}

async function frame(next: RpcBtwFrame): Promise<void> {
	await act(async () => {
		useBtwStore.getState().applyFrame(next);
	});
}

beforeEach(() => {
	command.mockClear();
});

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	container?.remove();
	container = null;
	root = null;
	useUiStore.getState().closeBtw();
	useUiStore.setState({ panelTab: "diff", panelVisible: false });
	useBtwStore.getState().reset();
});

describe("BtwDialog", () => {
	it("streams the answer, offers stop while running, and branches only once complete", async () => {
		useUiStore.getState().openBtw("why?");
		await mount();
		await act(async () => {
			button(translate("btw.ask"))?.click();
		});
		expect(command).toHaveBeenCalledWith({ type: "btw", question: "why?" }, 120_000);

		await frame({ type: "btw_delta", recordId: "topic-1", delta: "Because " });
		await frame({ type: "btw_delta", recordId: "topic-1", delta: "reasons." });
		expect(document.body.textContent).toContain("Because reasons.");
		// One question at a time: the ask button is replaced by stop while streaming.
		expect(button(translate("btw.ask"))).toBeUndefined();
		expect(button(translate("btw.branch"))?.disabled).toBe(true);

		await frame({ type: "btw_record", record: record({ status: "complete", answer: "Because reasons." }) });
		expect(button(translate("btw.cancel"))).toBeUndefined();
		expect(button(translate("btw.branch"))?.disabled).toBe(false);
	});

	it("ignores frames for other topics", async () => {
		useUiStore.getState().openBtw("why?");
		await mount();
		await act(async () => {
			button(translate("btw.ask"))?.click();
		});
		await frame({ type: "btw_delta", recordId: "someone-else", delta: "leak" });
		expect(document.body.textContent).not.toContain("leak");
	});

	it("keeps a still-streaming answer running when the dialog closes", async () => {
		useUiStore.getState().openBtw("why?");
		await mount();
		await act(async () => {
			button(translate("btw.ask"))?.click();
		});
		await act(async () => {
			useUiStore.getState().closeBtw();
		});
		expect(command.mock.calls.map(([cmd]) => cmd)).not.toContainEqual({
			type: "btw_cancel",
			recordId: "topic-1",
		});
	});

	it("does not cancel after the answer settled", async () => {
		useUiStore.getState().openBtw("why?");
		await mount();
		await act(async () => {
			button(translate("btw.ask"))?.click();
		});
		await frame({ type: "btw_record", record: record({ status: "complete", answer: "done" }) });
		await act(async () => {
			useUiStore.getState().closeBtw();
		});
		expect(command).not.toHaveBeenCalledWith(expect.objectContaining({ type: "btw_cancel" }));
	});

	it("moves a running answer into the side-questions drawer when the dialog closes", async () => {
		useUiStore.getState().openBtw("why?");
		await mount();
		await act(async () => {
			button(translate("btw.ask"))?.click();
		});

		const closeButton = [...document.querySelectorAll("button")].find(
			node => node.getAttribute("aria-label") === translate("common.close"),
		);
		await act(async () => {
			closeButton?.click();
		});

		expect(useUiStore.getState().btwRequest).toBeNull();
		expect(useUiStore.getState().panelTab).toBe("btw");
		expect(useUiStore.getState().panelVisible).toBe(true);
		expect(command.mock.calls.map(([cmd]) => cmd)).not.toContainEqual({
			type: "btw_cancel",
			recordId: "topic-1",
		});
	});

	it("shows the failure instead of a thinking spinner when a turn ends with no text", async () => {
		useUiStore.getState().openBtw("why?");
		await mount();
		await act(async () => {
			button(translate("btw.ask"))?.click();
		});
		await frame({ type: "btw_record", record: record({ status: "error", error: "provider down" }) });
		expect(document.body.textContent).toContain("provider down");
		expect(document.body.textContent).not.toContain(translate("btw.thinking"));
	});
});
