import { createContext, useContext } from "react";

/**
 * Set by a subagent page (plan/24 §6.1). The transcript is someone else's
 * history: actions that act on the session (edit, branch, retry, stop) are
 * hidden, and the first user message is the delegated assignment, labelled
 * with who sent it.
 */
export interface ReadOnlyTranscript {
	/** Author label for user messages, in place of "You". */
	authorLabel: string;
}

export const ReadOnlyTranscriptContext = createContext<ReadOnlyTranscript | null>(null);

export function useReadOnlyTranscript(): ReadOnlyTranscript | null {
	return useContext(ReadOnlyTranscriptContext);
}
