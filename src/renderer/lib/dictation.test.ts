/**
 * Live dictation: the composer gets typed-looking text, the first words survive a model
 * that is still loading, and every way out leaves the microphone closed.
 */
import { describe, expect, it, vi } from "vitest";
import type { RpcDictationFrame, RpcResponse } from "../../shared/rpc-types";
import {
	DictationSession,
	type DictationView,
	insertDictated,
	type OpenMic,
	pcm16ToBase64,
	trimBeforeCaret,
} from "./dictation";

describe("insertDictated", () => {
	it("spaces words like typing: none at the start or after whitespace, one after a word", () => {
		expect(insertDictated("", 0, 0, " hello")).toEqual({ value: "hello", caret: 5 });
		expect(insertDictated("Note: ", 6, 6, "ship it")).toEqual({ value: "Note: ship it", caret: 13 });
		expect(insertDictated("Note:", 5, 5, "ship it")).toEqual({ value: "Note: ship it", caret: 13 });
		expect(insertDictated("ship it", 7, 7, ", then rest")).toEqual({ value: "ship it, then rest", caret: 18 });
	});

	it("keeps a space before following text, with the caret before it so the next phrase joins on", () => {
		const first = insertDictated("fix bug", 4, 4, "the");
		expect(first).toEqual({ value: "fix the bug", caret: 7 });
		expect(insertDictated(first.value, first.caret, first.caret, " login")).toEqual({
			value: "fix the login bug",
			caret: 13,
		});
	});

	it("replaces a selection", () => {
		expect(insertDictated("say WORD here", 4, 8, "this")).toEqual({ value: "say this here", caret: 8 });
	});

	it("leaves the text alone when there are no words", () => {
		expect(insertDictated("draft", 5, 5, "  ")).toEqual({ value: "draft", caret: 5 });
	});
});

describe("trimBeforeCaret", () => {
	it("removes a spoken submit word right before the caret", () => {
		expect(trimBeforeCaret("ship it submit and more", 14, 7)).toEqual({ value: "ship it and more", caret: 7 });
		expect(trimBeforeCaret("ab", 1, 5)).toEqual({ value: "b", caret: 0 });
	});
});

function chunk(...values: number[]): Int16Array {
	return Int16Array.from(values);
}

function harness(
	options: { micFails?: Error; startResult?: RpcResponse; stopResult?: RpcResponse; micGate?: Promise<void> } = {},
) {
	const ok = (command: string, data?: unknown) =>
		Promise.resolve({ type: "response", command, success: true, data } as RpcResponse);
	const sent: string[] = [];
	const rpc = {
		dictationStart: vi.fn(() =>
			options.startResult
				? Promise.resolve(options.startResult)
				: ok("host_dictation_start", { state: "recording" }),
		),
		dictationAudio: vi.fn((pcm: string) => {
			sent.push(pcm);
			return ok("host_dictation_audio");
		}),
		dictationStop: vi.fn(() =>
			options.stopResult ? Promise.resolve(options.stopResult) : ok("host_dictation_stop"),
		),
		dictationCancel: vi.fn(() => ok("host_dictation_cancel")),
	};
	let listener: ((frame: RpcDictationFrame) => void) | undefined;
	const unsubscribe = vi.fn();
	const mics: { feed: (pcm: Int16Array, level?: number) => void; stop: ReturnType<typeof vi.fn> }[] = [];
	const openMic: OpenMic = async onChunk => {
		await options.micGate;
		if (options.micFails) throw options.micFails;
		const mic = { feed: (pcm: Int16Array, level = 0.5) => onChunk(pcm, level), stop: vi.fn() };
		mics.push(mic);
		return mic;
	};
	const views: (DictationView | null)[] = [];
	const editor = { commit: vi.fn(), trim: vi.fn(), submit: vi.fn() };
	const warnings: string[] = [];
	const onNothingHeard = vi.fn();
	const session = new DictationSession({
		rpc,
		subscribe: next => {
			listener = next;
			return unsubscribe;
		},
		openMic,
		editor,
		onView: view => views.push(view),
		onWarning: message => warnings.push(message),
		onNothingHeard,
	});
	const frame = (next: RpcDictationFrame) => listener?.(next);
	const state = (value: "preparing" | "recording" | "transcribing" | "idle") =>
		frame({ type: "host_dictation_state", state: value });
	const phase = () => views.at(-1)?.phase ?? null;
	return { session, rpc, sent, mics, views, editor, warnings, onNothingHeard, unsubscribe, frame, state, phase };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("DictationSession", () => {
	it("sends what was said while the model loaded, then streams, and inserts final words", async () => {
		const h = harness();
		h.session.start();
		h.state("preparing");
		await settle();
		expect(h.phase()).toBe("preparing");

		h.mics[0]!.feed(chunk(1, 2));
		h.mics[0]!.feed(chunk(3));
		expect(h.sent).toEqual([]);

		h.state("recording");
		h.mics[0]!.feed(chunk(4));
		expect(h.sent).toEqual([pcm16ToBase64(chunk(1, 2)), pcm16ToBase64(chunk(3)), pcm16ToBase64(chunk(4))]);

		h.frame({ type: "host_dictation_text", op: "volatile", text: "hello wor" });
		expect(h.views.at(-1)?.partial).toBe("hello wor");
		h.frame({ type: "host_dictation_text", op: "commit", text: "hello world" });
		expect(h.editor.commit).toHaveBeenCalledWith("hello world");
		expect(h.views.at(-1)?.partial).toBe("");

		h.session.stop();
		expect(h.rpc.dictationStop).toHaveBeenCalledTimes(1);
		expect(h.mics[0]!.stop).toHaveBeenCalledTimes(1);
		expect(h.phase()).toBe("transcribing");
		h.mics[0]!.feed(chunk(5));
		expect(h.sent).toHaveLength(3);

		h.state("idle");
		expect(h.views.at(-1)).toBeNull();
		expect(h.unsubscribe).toHaveBeenCalledTimes(1);
		expect(h.onNothingHeard).not.toHaveBeenCalled();
		expect(h.editor.submit).not.toHaveBeenCalled();
	});

	it("sends a spoken message only after the capture has ended", async () => {
		const h = harness();
		h.session.start();
		h.state("recording");
		await settle();
		h.frame({ type: "host_dictation_text", op: "commit", text: "ship it submit" });
		h.frame({ type: "host_dictation_text", op: "trim", count: 7 });
		h.frame({ type: "host_dictation_text", op: "submit" });
		expect(h.editor.trim).toHaveBeenCalledWith(7);
		expect(h.editor.submit).not.toHaveBeenCalled();
		h.state("idle");
		expect(h.editor.submit).toHaveBeenCalledTimes(1);
	});

	it("closes the microphone during a model download and reopens it when recording starts", async () => {
		const h = harness();
		h.session.start();
		await settle();
		h.mics[0]!.feed(chunk(9));
		h.frame({ type: "host_dictation_download", label: "Nemotron", percent: 3 });
		expect(h.mics[0]!.stop).toHaveBeenCalledTimes(1);
		expect(h.views.at(-1)).toMatchObject({ phase: "downloading", download: { label: "Nemotron", percent: 3 } });
		h.frame({ type: "host_dictation_download", label: "Nemotron", percent: 40 });
		expect(h.mics).toHaveLength(1);

		h.state("recording");
		await settle();
		expect(h.mics).toHaveLength(2);
		h.mics[1]!.feed(chunk(1));
		// Audio from before the download is stale by now and never sent.
		expect(h.sent).toEqual([pcm16ToBase64(chunk(1))]);
	});

	it("keeps waiting on the microphone until it opens, even once the model is ready", async () => {
		const gate = Promise.withResolvers<void>();
		const h = harness({ micGate: gate.promise });
		h.session.start();
		h.state("recording");
		expect(h.phase()).toBe("opening");
		gate.resolve();
		await settle();
		expect(h.phase()).toBe("recording");
		h.mics[0]!.feed(chunk(7));
		expect(h.sent).toEqual([pcm16ToBase64(chunk(7))]);
	});

	it("stopping before recording begins cancels quietly", async () => {
		const h = harness();
		h.session.start();
		h.state("preparing");
		await settle();
		h.session.stop();
		expect(h.rpc.dictationCancel).toHaveBeenCalledTimes(1);
		expect(h.rpc.dictationStop).not.toHaveBeenCalled();
		expect(h.mics[0]!.stop).toHaveBeenCalledTimes(1);
		expect(h.views.at(-1)).toBeNull();
		expect(h.onNothingHeard).not.toHaveBeenCalled();
	});

	it("a microphone that cannot open ends the capture with a warning", async () => {
		const h = harness({ micFails: new Error("Permission denied") });
		h.session.start();
		await settle();
		expect(h.warnings).toEqual(["Permission denied"]);
		expect(h.rpc.dictationCancel).toHaveBeenCalledTimes(1);
		expect(h.views.at(-1)).toBeNull();
	});

	it("a refused start ends with the sidecar's reason, and the microphone closes", async () => {
		const h = harness({
			startResult: {
				type: "response",
				command: "host_dictation_start",
				success: false,
				error: "Speech-to-text is disabled",
			} as RpcResponse,
		});
		h.session.start();
		await settle();
		expect(h.warnings).toEqual(["Speech-to-text is disabled"]);
		expect(h.views.at(-1)).toBeNull();
		expect(h.mics.every(mic => mic.stop.mock.calls.length === 1)).toBe(true);
	});

	it("a failed finish ends with the sidecar's reason instead of waiting on the transcript", async () => {
		const h = harness({
			stopResult: {
				type: "response",
				command: "host_dictation_stop",
				success: false,
				error: "Transcription failed",
			} as RpcResponse,
		});
		h.session.start();
		h.state("recording");
		await settle();
		h.session.stop();
		await settle();
		expect(h.warnings).toEqual(["Transcription failed"]);
		expect(h.views.at(-1)).toBeNull();
		expect(h.onNothingHeard).not.toHaveBeenCalled();
	});

	it("cancelling while the last words transcribe discards them and ends at once", async () => {
		const h = harness();
		h.session.start();
		h.state("recording");
		await settle();
		h.session.stop();
		h.session.cancel();
		expect(h.rpc.dictationCancel).toHaveBeenCalledTimes(1);
		expect(h.views.at(-1)).toBeNull();
		h.frame({ type: "host_dictation_text", op: "commit", text: "late words" });
		expect(h.editor.commit).not.toHaveBeenCalled();
		expect(h.onNothingHeard).not.toHaveBeenCalled();
	});

	it("says so when a finished capture heard nothing", async () => {
		const h = harness();
		h.session.start();
		h.state("recording");
		await settle();
		h.session.stop();
		h.state("idle");
		expect(h.onNothingHeard).toHaveBeenCalledTimes(1);
	});
});
