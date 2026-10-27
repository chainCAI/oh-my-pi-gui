import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, test, vi } from "vitest";
import type { CustomProviderInput, CustomProviderView } from "../../../shared/ipc-types";
import type { ProvidersResult, RpcResponse } from "../../../shared/rpc-types";
import { I18nProvider, translate } from "../../lib/i18n";
import { useModelStore } from "../../stores/model";
import { useUiStore } from "../../stores/ui";
import { defaultProviderDiscovery, ProviderConfigDialog, providerRequiresManualModels } from "./ProviderConfigDialog";

describe("custom provider discovery defaults", () => {
	test("keeps /v1/models discovery opt-in for new providers", () => {
		expect(defaultProviderDiscovery()).toBeUndefined();
	});

	test("allows a discovery-only provider without a hand-written model row", () => {
		expect(providerRequiresManualModels("openai-models-list")).toBe(false);
		expect(providerRequiresManualModels(undefined)).toBe(true);
	});
});

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);
// linkedom has no layout: the form scrolls its first error into view.
(HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = () => {};

const emptyCatalog: ProvidersResult = {
	providers: [],
	models: [],
	discoveryStates: [],
	refreshPending: false,
	generation: 1,
};
const upsertProvider = vi.fn(async (_input: CustomProviderInput) => {});
const deleteProvider = vi.fn(async (_id: string) => {});
const listProviders = vi.fn(async (): Promise<CustomProviderView[]> => []);
const getProviders = vi.fn(
	async (): Promise<RpcResponse> => ({
		type: "response",
		command: "get_providers",
		success: true,
		data: emptyCatalog,
	}),
);
Object.assign(window as unknown as Record<string, unknown>, {
	omp: { models: { listProviders, upsertProvider, deleteProvider }, rpc: { getProviders } },
});

function mockProvider(): CustomProviderView {
	return {
		id: "mock",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9/v1",
		hasApiKey: false,
		auth: "none",
		models: [{ id: "mock-1", name: "Mock One" }],
		builtin: false,
	};
}

const roots: Root[] = [];

async function mountDialog(): Promise<void> {
	const root = createRoot(document.body as unknown as Element);
	roots.push(root);
	const Mounted = () => {
		const open = useUiStore(s => s.providerConfigOpen);
		const edit = useUiStore(s => s.providerConfigEdit);
		const close = useUiStore(s => s.closeProviderConfig);
		return <ProviderConfigDialog open={open} editProvider={edit} onClose={close} />;
	};
	await act(async () => {
		root.render(
			<I18nProvider>
				<Mounted />
			</I18nProvider>,
		);
	});
}

function text(): string {
	return document.body.textContent ?? "";
}

function button(label: string): HTMLButtonElement {
	const found = Array.from(document.body.querySelectorAll("button")).findLast(
		candidate => (candidate.textContent ?? "").trim() === label || candidate.getAttribute("aria-label") === label,
	);
	if (!found) throw new Error(`no button "${label}"`);
	return found as HTMLButtonElement;
}

async function click(label: string): Promise<void> {
	await act(async () => {
		button(label).click();
		await new Promise(resolve => setTimeout(resolve, 0));
	});
}

/** Drive a controlled field through React's own onChange (linkedom fires no input events). */
async function change(selector: string, value: string): Promise<void> {
	const element = document.body.querySelector(selector);
	if (!element) throw new Error(`no field ${selector}`);
	const record = element as unknown as Record<string, unknown>;
	const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
	const props = propsKey ? (record[propsKey] as { onChange?: (event: object) => void }) : undefined;
	(element as unknown as { value: string }).value = value;
	await act(async () => props?.onChange?.({ target: element, currentTarget: element }));
}

async function fillLocalServer(): Promise<void> {
	await change(`input[placeholder="${translate("providerCfg.form.idPlaceholder")}"]`, "local-llm");
	await change(`input[placeholder="${translate("providerCfg.form.baseUrlPlaceholder")}"]`, "http://127.0.0.1:9/v1");
	await change(`input[placeholder="${translate("providerCfg.form.modelIdPlaceholder")}"]`, "m1");
}

afterEach(async () => {
	for (const root of roots) {
		await act(async () => root.unmount());
	}
	roots.length = 0;
	while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
	useUiStore.getState().closeProviderConfig();
	useUiStore.getState().closeProviders();
	useModelStore.getState().reset();
	upsertProvider.mockClear();
	deleteProvider.mockClear();
	listProviders.mockReset();
	listProviders.mockResolvedValue([]);
});

describe("ProviderConfigDialog", () => {
	it("refuses a keyless provider with models until its auth mode says no key is needed", async () => {
		// Saved as-is, the agent rejects all of models.yml and every custom
		// provider leaves the model picker — the one in use included.
		useUiStore.getState().openProviderConfig("new");
		await mountDialog();
		await fillLocalServer();

		await click(translate("providerCfg.form.add"));
		expect(upsertProvider).not.toHaveBeenCalled();
		expect(text()).toContain(translate("providerCfg.form.apiKeyRequired"));

		const authSelect = Array.from(document.body.querySelectorAll("select")).find(select =>
			Array.from(select.querySelectorAll("option")).some(option => option.getAttribute("value") === "none"),
		);
		if (!authSelect) throw new Error("no auth select");
		const record = authSelect as unknown as Record<string, unknown>;
		const propsKey = Object.getOwnPropertyNames(record).find(key => key.startsWith("__reactProps$"));
		const props = propsKey ? (record[propsKey] as { onChange: (event: object) => void }) : undefined;
		await act(async () => props?.onChange({ target: { value: "none" } }));

		await click(translate("providerCfg.form.add"));
		expect(upsertProvider).toHaveBeenCalledOnce();
		expect(upsertProvider.mock.calls[0]?.[0]).toMatchObject({
			id: "local-llm",
			auth: "none",
			models: [{ id: "m1" }],
		});
	});

	it("opens straight into the add form and returns to the Providers window on Cancel", async () => {
		useUiStore.getState().openProviders();
		useUiStore.getState().openProviderConfig("new");
		await mountDialog();

		// No detour through the custom-provider list.
		expect(
			document.body.querySelector(`input[placeholder="${translate("providerCfg.form.idPlaceholder")}"]`),
		).not.toBeNull();

		await click(translate("providerCfg.form.cancel"));
		expect(useUiStore.getState().providerConfigOpen).toBe(false);
		// Cancel used to close the Providers window behind it as well.
		expect(useUiStore.getState().providersOpen).toBe(true);
	});

	it("deletes from the edit form the Providers window opens, then returns to the window", async () => {
		// Add provider now opens the form directly, so the edit form is the only
		// place the Providers window can reach Delete from.
		useUiStore.getState().openProviders();
		useUiStore.getState().openProviderConfig(mockProvider());
		await mountDialog();

		await click(translate("providerCfg.list.delete"));
		await click(translate("providerCfg.delete.confirm"));
		expect(deleteProvider).toHaveBeenCalledWith("mock");
		expect(useUiStore.getState().providerConfigOpen).toBe(false);
		expect(useUiStore.getState().providersOpen).toBe(true);
	});

	it("warns before deleting the provider the session's model comes from", async () => {
		listProviders.mockResolvedValue([mockProvider()]);
		useModelStore.setState({ model: { provider: "mock", id: "mock-1", name: "Mock One" } });
		useUiStore.getState().openProviderConfig();
		await mountDialog();

		await click(translate("providerCfg.list.delete"));
		expect(text()).toContain(translate("providerCfg.delete.inUse", { model: "Mock One" }));
	});
});
