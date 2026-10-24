/**
 * RecordKvEditor tests: the row editor commits whole records on change, so the
 * contract these defend is that an edit never destroys a neighbouring entry —
 * renaming a key onto one that already exists must be refused, not silently
 * written over — and that a new row reaches the record only as a whole entry.
 */

import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../../lib/i18n";
import { RecordKvEditor } from "./RecordKvEditor";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const committed: Record<string, unknown>[] = [];
const onCommit = vi.fn((next: Record<string, unknown>) => committed.push(next));

let root: Root;

async function mount(value: Record<string, unknown>): Promise<void> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<RecordKvEditor onCommit={onCommit} value={value} />
			</I18nProvider>,
		);
	});
}

/** Key inputs come first in each row: [key, value, key, value, …]. */
function keyInput(index: number): HTMLInputElement {
	return document.body.querySelectorAll("input")[index * 2] as unknown as HTMLInputElement;
}

function valueInput(index: number): HTMLInputElement {
	return document.body.querySelectorAll("input")[index * 2 + 1] as unknown as HTMLInputElement;
}

/** Type into a controlled input, then leave it. linkedom's input events never reach React's onChange. */
async function type(input: HTMLInputElement, text: string): Promise<void> {
	Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(input, text);
	const record = input as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void } | undefined) : undefined;
	await act(async () => props?.onChange?.({ target: input, currentTarget: input }));
	await act(async () => {
		input.dispatchEvent(new window.Event("focusout", { bubbles: true }));
	});
}

async function rename(index: number, next: string): Promise<void> {
	const input = keyInput(index);
	await act(async () => {
		input.value = next;
		input.dispatchEvent(new window.Event("focusout", { bubbles: true }));
	});
}

afterEach(async () => {
	await act(async () => {
		root?.unmount();
	});
	document.body.innerHTML = "";
	onCommit.mockClear();
	committed.length = 0;
});

describe("RecordKvEditor", () => {
	it("refuses a rename that would overwrite another entry's value", async () => {
		await mount({ alpha: "keep-me", beta: "other" });

		await rename(0, "beta");

		expect(onCommit).not.toHaveBeenCalled();
		expect(committed).toEqual([]);
		expect(document.body.textContent).toContain(translate("settings.editors.kvDuplicateKey", { key: "beta" }));

		// The row stays editable; the next unique name commits normally.
		await rename(0, "gamma");
		expect(committed).toEqual([{ gamma: "keep-me", beta: "other" }]);
	});

	it("holds an added row until it has a key and a value (#20)", async () => {
		// A number map: committing a placeholder "" would fail the agent's schema.
		await mount({ explore: 4 });
		const addButton = [...document.body.querySelectorAll("button")].find(button =>
			button.textContent?.includes(translate("settings.editors.kvAdd")),
		);
		await act(async () => {
			addButton?.dispatchEvent(new window.Event("click", { bubbles: true }));
		});
		expect(onCommit).not.toHaveBeenCalled();

		await type(keyInput(1), "task");
		expect(onCommit).not.toHaveBeenCalled();

		await type(valueInput(1), "12");
		expect(committed).toEqual([{ explore: 4, task: 12 }]);
	});
});
