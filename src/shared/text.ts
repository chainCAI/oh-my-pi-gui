/** Cut the middle of text longer than `max` characters, keeping both ends around "…". */
export function truncateMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const keep = Math.floor((max - 1) / 2);
	return `${text.slice(0, keep)}…${text.slice(-keep)}`;
}
