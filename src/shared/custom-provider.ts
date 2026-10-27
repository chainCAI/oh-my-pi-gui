/**
 * Rules for models.yml provider entries that both the main process (which
 * writes the file) and the renderer form (which validates before saving) apply.
 */

/**
 * The agent rejects the whole of models.yml when one entry fails validation,
 * so every custom provider leaves the model picker, not just the broken one.
 * The entry the add form can produce that way: models listed, no API key, and
 * auth left on the API-key default. `auth: none` (local servers) and
 * `auth: oauth` are the only keyless forms the agent accepts.
 */
export function customProviderNeedsApiKey(entry: {
	auth?: "apiKey" | "none" | "oauth";
	hasApiKey: boolean;
	modelCount: number;
}): boolean {
	return entry.modelCount > 0 && !entry.hasApiKey && entry.auth !== "none" && entry.auth !== "oauth";
}
