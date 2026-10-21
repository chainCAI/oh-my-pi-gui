import { useSyncExternalStore } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { ExtensionUIRequest } from "../../shared/rpc-types";
import {
	allSessionRuntimes,
	createScopedStoreHook,
	focusedRuntimeTabId,
	onFocusedSessionRuntimeChange,
	onSessionRuntimeListChange,
} from "./session-runtime-context";

export interface ExtensionUiSnapshot {
	pendingRequests: ExtensionUIRequest[];
	statusWidgets: Record<string, string>;
	widgetPanels: Record<string, string[]>;
}

export interface ExtensionUiStore extends ExtensionUiSnapshot {
	pushRequest: (request: ExtensionUIRequest) => void;
	removeRequest: (id: string) => void;
	setStatus: (key: string, text: string | undefined) => void;
	setWidget: (key: string, lines: string[] | undefined) => void;
	clearAll: () => void;
}

/** Pure request reducer shared by the visible store and parked tab bundles. */
export function applyExtensionUiRequest(
	snapshot: ExtensionUiSnapshot,
	request: ExtensionUIRequest,
): ExtensionUiSnapshot {
	if (request.method === "setStatus") {
		const statusWidgets = { ...snapshot.statusWidgets };
		if (request.statusText) statusWidgets[request.statusKey] = request.statusText;
		else delete statusWidgets[request.statusKey];
		return { ...snapshot, statusWidgets };
	}
	if (request.method === "setWidget") {
		const widgetPanels = { ...snapshot.widgetPanels };
		if (request.widgetLines && request.widgetLines.length > 0) widgetPanels[request.widgetKey] = request.widgetLines;
		else delete widgetPanels[request.widgetKey];
		return { ...snapshot, widgetPanels };
	}
	if (request.method === "cancel") {
		return { ...snapshot, pendingRequests: snapshot.pendingRequests.filter(item => item.id !== request.targetId) };
	}
	return { ...snapshot, pendingRequests: [...snapshot.pendingRequests, request] };
}

export const createExtensionUiStore = () =>
	createStore<ExtensionUiStore>()((set, get) => ({
		pendingRequests: [],
		statusWidgets: {},
		widgetPanels: {},
		pushRequest: request => set(state => applyExtensionUiRequest(state, request)),
		removeRequest: id => set({ pendingRequests: get().pendingRequests.filter(r => r.id !== id) }),
		setStatus: (key, text) => {
			const next = { ...get().statusWidgets };
			if (text) {
				next[key] = text;
			} else {
				delete next[key];
			}
			set({ statusWidgets: next });
		},
		setWidget: (key, lines) => {
			const next = { ...get().widgetPanels };
			if (lines && lines.length > 0) {
				next[key] = lines;
			} else {
				delete next[key];
			}
			set({ widgetPanels: next });
		},
		clearAll: () => set({ pendingRequests: [], statusWidgets: {}, widgetPanels: {} }),
	}));

const defaultExtensionUiStore = createExtensionUiStore();
export const useExtensionUiStore = createScopedStoreHook("extensionUi", defaultExtensionUiStore);

/**
 * Cross-tab view of pendingRequests. Requests live in per-tab stores, but the
 * dialog surface is global — a request parked in a background tab's store was
 * previously invisible (and the agent behind it blocked forever). Responses
 * already route back by request id to the owning sidecar, so the queue can be
 * shown from anywhere: focused tab's items first, then the others.
 */

function runtimeExtensionStores(): { tabId: string | null; store: StoreApi<ExtensionUiStore> }[] {
	const entries = allSessionRuntimes().map(runtime => ({
		tabId: runtime.tabId,
		store: runtime.stores.get("extensionUi") as StoreApi<ExtensionUiStore> | undefined,
	}));
	return entries.filter((entry): entry is { tabId: string; store: StoreApi<ExtensionUiStore> } =>
		Boolean(entry.store),
	);
}

let pendingCache: ExtensionUIRequest[] = [];
const aggregateListeners = new Set<() => void>();
const perStoreUnsubs = new Map<StoreApi<ExtensionUiStore>, () => void>();

function recomputePendingCache(): void {
	const focusedTab = focusedRuntimeTabId();
	const stores = runtimeExtensionStores();
	stores.sort((a, b) => (a.tabId === focusedTab ? -1 : b.tabId === focusedTab ? 1 : 0));
	const next: ExtensionUIRequest[] = [];
	for (const { store } of stores) next.push(...store.getState().pendingRequests);
	next.push(...defaultExtensionUiStore.getState().pendingRequests);
	pendingCache = next;
}

function notifyAggregate(): void {
	recomputePendingCache();
	for (const listener of aggregateListeners) listener();
}

function attachStoreSubscriptions(): void {
	const wanted = new Set<StoreApi<ExtensionUiStore>>([defaultExtensionUiStore]);
	for (const { store } of runtimeExtensionStores()) wanted.add(store);
	for (const [store, unsubscribe] of perStoreUnsubs) {
		if (!wanted.has(store)) {
			unsubscribe();
			perStoreUnsubs.delete(store);
		}
	}
	for (const store of wanted) {
		if (!perStoreUnsubs.has(store)) perStoreUnsubs.set(store, store.subscribe(notifyAggregate));
	}
}

function subscribeAggregate(onChange: () => void): () => void {
	aggregateListeners.add(onChange);
	attachStoreSubscriptions();
	recomputePendingCache();
	const unFocus = onFocusedSessionRuntimeChange(notifyAggregate);
	const unRuntimeList = onSessionRuntimeListChange(() => {
		attachStoreSubscriptions();
		notifyAggregate();
	});
	return () => {
		aggregateListeners.delete(onChange);
		unFocus();
		unRuntimeList();
		if (aggregateListeners.size === 0) {
			for (const unsubscribe of perStoreUnsubs.values()) unsubscribe();
			perStoreUnsubs.clear();
		}
	};
}

/** Pending extension-UI requests across every tab (focused tab first). */
export function useAllPendingRequests(): ExtensionUIRequest[] {
	return useSyncExternalStore(subscribeAggregate, () => pendingCache);
}

/**
 * Drop a request from whichever store holds it — required now that the dialog
 * renders the cross-tab aggregate: the focused store may not own the request.
 */
export function removeExtensionRequest(id: string): void {
	defaultExtensionUiStore.getState().removeRequest(id);
	for (const { store } of runtimeExtensionStores()) store.getState().removeRequest(id);
}
