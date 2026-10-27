/**
 * The tray's quota rows depend on the window reading quotas on its own: the
 * first read waits for the sidecar, and a reading lands in the shared store
 * the tray sync pushes from.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ProviderInfo, UsageReport } from "../../shared/rpc-types";
import { useModelStore } from "../stores/model";
import { useQuotaStore } from "../stores/quotas";
import { useSessionStore } from "../stores/session";
import { useQuotaPolling } from "./use-quota-polling";

const { document, window, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const ompWindow = window as unknown as { omp?: unknown };
const claude: UsageReport = {
	provider: "anthropic",
	fetchedAt: 0,
	limits: [{ id: "5h", label: "Claude 5 Hour", windowLabel: "5 Hour", usedFraction: 0.42 }],
};

let root: Root | null = null;
let getUsage: Mock;

function Poller() {
	useQuotaPolling();
	return null;
}

async function settle(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

beforeEach(() => {
	getUsage = vi.fn(async () => ({ success: true, data: { reports: [claude] } }));
	ompWindow.omp = { rpc: { getUsage } };
	useModelStore.setState({ providers: [{ id: "anthropic", name: "Anthropic (Claude Pro/Max)" } as ProviderInfo] });
	useQuotaStore.setState({ reports: null, fetchedAt: 0 });
});

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	root = null;
	document.body.innerHTML = "";
	delete ompWindow.omp;
	useSessionStore.getState().reset();
	useModelStore.setState({ providers: [] });
});

describe("useQuotaPolling", () => {
	it("waits for the sidecar, then reads quotas once into the store the tray pushes from", async () => {
		useSessionStore.setState({ status: "starting" });
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host as unknown as Element);
		await act(async () => root?.render(<Poller />));
		await settle();
		expect(getUsage).not.toHaveBeenCalled();

		await act(async () => useSessionStore.setState({ status: "ready" }));
		await settle();
		expect(getUsage).toHaveBeenCalledTimes(1);
		expect(useQuotaStore.getState().reports).toEqual([claude]);
		expect(useQuotaStore.getState().fetchedAt).toBeGreaterThan(0);
	});
});
