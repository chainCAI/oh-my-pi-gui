/**
 * Key-value row editor for flat `record` settings (string → string|number|
 * boolean), e.g. tools.approval (tool → policy). Replaces the raw-JSON
 * textarea: rows of {key, value} + add/remove. When the value domain is a
 * known small enum (passed via valueOptions), the value cell is a dropdown
 * instead of free text. Commits the whole record on every change; a new row
 * stays a local draft until it has a key and a value, because the record's
 * schema can reject a placeholder (an empty string for a number map, #20).
 */

import { Plus, X } from "lucide-react";
import { Fragment, useState } from "react";
import { useT } from "../../../lib/i18n";
import { ModelValueSelect } from "../ModelValueSelect";

type Primitive = string | number | boolean;

export interface RecordKvEditorProps {
	value: Record<string, unknown>;
	onCommit: (value: Record<string, unknown>) => void;
	disabled?: boolean;
	/** When set, the value cell renders a dropdown of these options. */
	valueOptions?: { value: string; label: string }[];
	/** When "model", the value cell renders a searchable model dropdown. */
	valueKind?: "model";
	keyPlaceholder?: string;
	valuePlaceholder?: string;
	/** Render free-text value cells as password inputs (secret env vars / headers). */
	maskValues?: boolean;
}

function toPrimitive(input: string): Primitive {
	if (input === "true") return true;
	if (input === "false") return false;
	const n = Number(input);
	if (input.trim() !== "" && Number.isFinite(n)) return n;
	return input;
}

/** Collision marker for the draft row, which has no record key yet. */
const DRAFT_ROW = "\u0000draft";

const INPUT_CLASS =
	"rounded-md border border-(--omp-input-border) bg-(--omp-input-bg) px-2 py-1 font-mono text-omp-sm text-(--omp-text) outline-none transition-colors focus:border-(--omp-input-focus-border)";

export function RecordKvEditor({
	value,
	onCommit,
	disabled,
	valueOptions,
	valueKind,
	keyPlaceholder,
	valuePlaceholder,
	maskValues,
}: RecordKvEditorProps) {
	const t = useT();
	const entries = Object.entries(value);
	/** Row whose last rename collided, plus the name that collides with it. */
	const [collision, setCollision] = useState<{ row: string; typed: string } | null>(null);
	/** The row Add opened, not yet in the record. */
	const [draft, setDraft] = useState<{ key: string; value: string } | null>(null);

	const setEntry = (index: number, key: string, val: Primitive) => {
		const next: Record<string, unknown> = {};
		entries.forEach(([k, v], i) => {
			next[i === index ? key : k] = i === index ? val : v;
		});
		onCommit(next);
	};

	const removeEntry = (index: number) => {
		setCollision(null);
		const next: Record<string, unknown> = {};
		entries.forEach(([k, v], i) => {
			if (i !== index) next[k] = v;
		});
		onCommit(next);
	};

	const addEntry = () => {
		setCollision(null);
		setDraft({ key: "", value: valueOptions ? valueOptions[0].value : "" });
	};

	/** Keep the draft until it is a whole entry; then commit it as one. */
	const commitDraft = (next: { key: string; value: string }) => {
		setDraft(next);
		const key = next.key.trim();
		if (!key || next.value.trim() === "") return;
		if (key in value) {
			setCollision({ row: DRAFT_ROW, typed: key });
			return;
		}
		setCollision(null);
		setDraft(null);
		onCommit({ ...value, [key]: valueOptions || valueKind === "model" ? next.value : toPrimitive(next.value) });
	};

	return (
		<div className="flex w-full flex-col gap-1">
			{entries.map(([k, v], index) => (
				// Key by the record key (stable), not the index: rows use
				// uncontrolled inputs, so index keys would keep stale DOM values
				// attached to the wrong record entry after a row deletion.
				<Fragment key={k}>
					<div className="flex items-center gap-1.5">
						<input
							className={`${INPUT_CLASS} w-[45%]`}
							disabled={disabled}
							onBlur={e => {
								const nk = e.target.value.trim();
								if (!nk || nk === k) return;
								if (entries.some(([other], i) => i !== index && other === nk)) {
									// Writing it would replace that entry's value with
									// this row's — a silent loss, so refuse instead.
									setCollision({ row: k, typed: nk });
									return;
								}
								setCollision(null);
								setEntry(index, nk, v as Primitive);
							}}
							onChange={() => {}}
							defaultValue={k}
							placeholder={keyPlaceholder ?? t("settings.editors.kvKey")}
							spellCheck={false}
						/>
						{valueKind === "model" ? (
							<div className="flex-1">
								<ModelValueSelect
									disabled={disabled}
									kind="model"
									onCommit={next => setEntry(index, k, next)}
									value={typeof v === "string" ? v : ""}
								/>
							</div>
						) : valueOptions ? (
							<select
								className={`${INPUT_CLASS} flex-1`}
								disabled={disabled}
								onChange={e => setEntry(index, k, e.target.value)}
								value={typeof v === "string" ? v : String(v)}
							>
								{valueOptions.map(option => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						) : (
							<input
								className={`${INPUT_CLASS} flex-1`}
								defaultValue={typeof v === "string" ? v : String(v)}
								disabled={disabled}
								onBlur={e => {
									const nv = toPrimitive(e.target.value);
									if (nv !== v) setEntry(index, k, nv);
								}}
								onChange={() => {}}
								placeholder={valuePlaceholder ?? t("settings.editors.kvValue")}
								spellCheck={false}
								type={maskValues ? "password" : "text"}
							/>
						)}
						{!disabled && (
							<button
								aria-label={t("settings.editors.kvRemove")}
								className="shrink-0 text-(--omp-dim) hover:text-(--omp-error)"
								onClick={() => removeEntry(index)}
								type="button"
							>
								<X size={13} />
							</button>
						)}
					</div>
					{collision?.row === k && (
						<span className="pl-1 text-omp-xs text-(--omp-error)">
							{t("settings.editors.kvDuplicateKey", { key: collision.typed })}
						</span>
					)}
				</Fragment>
			))}
			{draft && !disabled && (
				<>
					<div className="flex items-center gap-1.5">
						<input
							autoFocus
							className={`${INPUT_CLASS} w-[45%]`}
							onBlur={() => commitDraft(draft)}
							onChange={e => setDraft({ ...draft, key: e.target.value })}
							placeholder={keyPlaceholder ?? t("settings.editors.kvKey")}
							spellCheck={false}
							value={draft.key}
						/>
						{valueKind === "model" ? (
							<div className="flex-1">
								<ModelValueSelect
									kind="model"
									onCommit={next => commitDraft({ ...draft, value: next })}
									value={draft.value}
								/>
							</div>
						) : valueOptions ? (
							<select
								className={`${INPUT_CLASS} flex-1`}
								onChange={e => commitDraft({ ...draft, value: e.target.value })}
								value={draft.value}
							>
								{valueOptions.map(option => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
						) : (
							<input
								className={`${INPUT_CLASS} flex-1`}
								onBlur={() => commitDraft(draft)}
								onChange={e => setDraft({ ...draft, value: e.target.value })}
								placeholder={valuePlaceholder ?? t("settings.editors.kvValue")}
								spellCheck={false}
								type={maskValues ? "password" : "text"}
								value={draft.value}
							/>
						)}
						<button
							aria-label={t("settings.editors.kvRemove")}
							className="shrink-0 text-(--omp-dim) hover:text-(--omp-error)"
							onClick={() => {
								setCollision(null);
								setDraft(null);
							}}
							type="button"
						>
							<X size={13} />
						</button>
					</div>
					{collision?.row === DRAFT_ROW && (
						<span className="pl-1 text-omp-xs text-(--omp-error)">
							{t("settings.editors.kvDuplicateKey", { key: collision.typed })}
						</span>
					)}
				</>
			)}
			{!disabled && !draft && (
				<button
					className="mt-0.5 inline-flex w-fit items-center gap-1 rounded-md border border-(--omp-border-muted) px-2 py-1 text-omp-sm text-(--omp-muted) transition-colors hover:bg-(--omp-bg-tertiary) hover:text-(--omp-text)"
					onClick={addEntry}
					type="button"
				>
					<Plus size={11} /> {t("settings.editors.kvAdd")}
				</button>
			)}
		</div>
	);
}
