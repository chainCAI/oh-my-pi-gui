/**
 * The small Handlebars subset the scheduler's prompt files use: `{{name}}`
 * substitution and flat `{{#if name}}…{{/if}}` sections that drop out when
 * the value is empty. Values are inserted verbatim (prompts, not HTML).
 */

export type TemplateValues = Record<string, string | boolean | null | undefined>;

const SECTION = /\{\{#if (\w+)\}\}\n?([\s\S]*?)\{\{\/if\}\}\n?/g;
const VALUE = /\{\{(\w+)\}\}/g;

export function renderTemplate(template: string, values: TemplateValues): string {
	const truthy = (key: string) => {
		const value = values[key];
		return typeof value === "string" ? value.trim() !== "" : value === true;
	};
	return template
		.replace(SECTION, (_match, key: string, body: string) => (truthy(key) ? body : ""))
		.replace(VALUE, (_match, key: string) => {
			const value = values[key];
			return typeof value === "string" ? value : "";
		})
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
