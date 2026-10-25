/**
 * The agent's tool-approval prompt as it arrives over RPC: a plain `select`
 * whose title reads "Allow tool: <name>\n<details>" and whose options end in
 * "Deny". Shared by the approval dialog and by scheduled runs, which answer
 * every such prompt with "Deny" except for the GUI's own host tools: omp
 * gives every host tool the exec tier, so those prompt in any mode below yolo.
 */

import type { ExtensionUIRequest } from "./rpc-types";

export const APPROVAL_TITLE_PREFIX = "Allow tool: ";
export const APPROVAL_APPROVE = "Approve";
export const APPROVAL_DENY = "Deny";

export type ApprovalSelect = Extract<ExtensionUIRequest, { method: "select" }>;

export function isApprovalRequest(request: ExtensionUIRequest): request is ApprovalSelect {
	if (request.method !== "select" || !request.title.startsWith(APPROVAL_TITLE_PREFIX)) return false;
	const { options } = request;
	// Grants shift "Approve" off index 0; its presence anywhere plus a "Deny"
	// tail is the approval shape.
	return options.includes("Approve") && options.at(-1) === APPROVAL_DENY;
}

/** Tool name (empty when the title has none) and the detail lines under it. */
/** The tool an approval prompt asks about; null for any other request. */
export function approvalToolName(request: ExtensionUIRequest): string | null {
	return isApprovalRequest(request) ? parseApprovalTitle(request.title).toolName : null;
}

export function parseApprovalTitle(title: string): { toolName: string; body: string } {
	const lines = title.split("\n");
	const first = lines[0] ?? "";
	const toolName = first.startsWith(APPROVAL_TITLE_PREFIX) ? first.slice(APPROVAL_TITLE_PREFIX.length).trim() : first;
	return { toolName, body: lines.slice(1).join("\n").trim() };
}
