/**
 * Resolves paths named in replies and tool output against the tab's workspace.
 * Requests made in one tick go to the main process as one batch per tab, and
 * answers are cached briefly: the agent creates and deletes files as it works,
 * so a path that did not exist a moment ago may exist now.
 */
import { useEffect, useState } from "react";
import type { IpcResolvedPath } from "../../shared/ipc-types";

const CACHE_MS = 10_000;
const CACHE_LIMIT = 2_000;

type Resolution = IpcResolvedPath | null;

const cache = new Map<string, { promise: Promise<Resolution>; at: number }>();
const queued = new Map<string, Map<string, PromiseWithResolvers<Resolution>>>();
let flushScheduled = false;

function flush(): void {
	flushScheduled = false;
	const batches = [...queued];
	queued.clear();
	for (const [tabKey, requests] of batches) {
		const paths = [...requests.keys()];
		const settle = (results: Array<Resolution | undefined>) => {
			for (const [index, path] of paths.entries()) requests.get(path)?.resolve(results[index] ?? null);
		};
		const resolvePaths = window.omp?.system?.resolvePaths;
		if (!resolvePaths) {
			settle([]);
			continue;
		}
		resolvePaths(paths, tabKey || undefined).then(settle, () => settle([]));
	}
}

/** What `path` names on disk for `tabId`'s workspace; null when nothing is there. */
export function resolvePath(path: string, tabId?: string | null): Promise<Resolution> {
	const tabKey = tabId ?? "";
	const key = `${tabKey}\0${path}`;
	const now = Date.now();
	const cached = cache.get(key);
	if (cached && now - cached.at < CACHE_MS) return cached.promise;
	if (cache.size >= CACHE_LIMIT) cache.clear();
	let requests = queued.get(tabKey);
	if (!requests) {
		requests = new Map();
		queued.set(tabKey, requests);
	}
	let request = requests.get(path);
	if (!request) {
		request = Promise.withResolvers<Resolution>();
		requests.set(path, request);
	}
	cache.set(key, { promise: request.promise, at: now });
	if (!flushScheduled) {
		flushScheduled = true;
		queueMicrotask(flush);
	}
	return request.promise;
}

/** `path`'s resolution once it arrives (undefined until then); a null path is never resolved. */
export function useResolvedPath(path: string | null, tabId: string | null): Resolution | undefined {
	const key = path === null ? null : `${tabId ?? ""}\0${path}`;
	const [answer, setAnswer] = useState<{ key: string; value: Resolution } | null>(null);
	useEffect(() => {
		if (path === null || key === null) return;
		let live = true;
		void resolvePath(path, tabId).then(value => {
			if (live) setAnswer({ key, value });
		});
		return () => {
			live = false;
		};
	}, [key, path, tabId]);
	return answer && answer.key === key ? answer.value : undefined;
}

/** Test seam: forget cached answers. */
export function clearPathResolutionCache(): void {
	cache.clear();
}
