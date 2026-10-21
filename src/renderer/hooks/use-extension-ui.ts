import { useCallback, useEffect } from "react";
import type { ExtensionUIRequest, ExtensionUIResponse } from "../../shared/rpc-types";
import { removeExtensionRequest, useExtensionUiStore } from "../stores/extension-ui";
import { pushTabExtensionUiRequest } from "../stores/tabs";

interface ExtensionUiResult {
	currentRequest: ExtensionUIRequest | null;
	respond: (response: ExtensionUIResponse) => void;
	cancel: (id: string) => void;
}

/**
 * Subscribes to extension UI requests and manages the dialog queue.
 */
export function useExtensionUi(): ExtensionUiResult {
	const pendingRequests = useExtensionUiStore(s => s.pendingRequests);

	useEffect(() => {
		const unsubscribe = window.omp.events.onExtensionUi((request, tabId) => {
			pushTabExtensionUiRequest(tabId, request);
		});
		return unsubscribe;
	}, []);

	const respond = useCallback((response: ExtensionUIResponse) => {
		window.omp.ui.respondExtensionUi(response);
		removeExtensionRequest(response.id);
	}, []);

	const cancel = useCallback((id: string) => {
		window.omp.ui.respondExtensionUi({ type: "extension_ui_response", id, cancelled: true });
		removeExtensionRequest(id);
	}, []);

	return {
		currentRequest: pendingRequests.length > 0 ? pendingRequests[0] : null,
		respond,
		cancel,
	};
}
