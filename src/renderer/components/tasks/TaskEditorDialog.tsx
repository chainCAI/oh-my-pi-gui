/**
 * Create or edit a task. Editing saves a new revision: runs already started
 * keep the settings they were launched with.
 */

import { useEffect, useState } from "react";
import type { TaskDraft } from "../../../shared/scheduler-types";
import { useT } from "../../lib/i18n";
import { useSchedulerStore } from "../../stores/scheduler";
import { Button, Modal } from "../common";
import { TaskForm, useDraftProblems } from "./TaskForm";

export function TaskEditorDialog() {
	const t = useT();
	const editor = useSchedulerStore(state => state.editor);
	const closeEditor = useSchedulerStore(state => state.closeEditor);
	const [draft, setDraft] = useState<TaskDraft | null>(editor?.initial ?? null);
	const [saving, setSaving] = useState(false);
	const editingId = editor?.mode === "edit" ? editor.taskId : undefined;

	useEffect(() => {
		setDraft(editor?.initial ?? null);
	}, [editor]);

	const problems = useDraftProblems(draft ?? (editor?.initial as TaskDraft), editingId);

	const save = async () => {
		if (!draft) return;
		setSaving(true);
		try {
			const result = await useSchedulerStore.getState().save(draft, editingId);
			if (result.ok) closeEditor();
		} finally {
			setSaving(false);
		}
	};

	return (
		<Modal
			onClose={closeEditor}
			open={editor !== null}
			size="lg"
			title={editor?.mode === "edit" ? t("tasks.editor.editTitle") : t("tasks.editor.newTitle")}
			bodyClassName="p-0"
		>
			{draft && (
				<div className="flex max-h-[min(80dvh,52rem)] flex-col">
					<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
						<TaskForm draft={draft} onChange={setDraft} problems={problems} />
					</div>
					<div className="flex shrink-0 items-center justify-between gap-3 border-t border-(--omp-border-muted) px-5 py-3">
						<span className="text-omp-sm text-(--omp-dim)">
							{editor?.mode === "edit" ? t("tasks.editor.revisionNote") : t("tasks.editor.createNote")}
						</span>
						<div className="flex gap-2">
							<Button onClick={closeEditor} size="sm" variant="ghost">
								{t("common.cancel")}
							</Button>
							<Button
								disabled={problems.length > 0}
								loading={saving}
								onClick={() => void save()}
								size="sm"
								variant="primary"
							>
								{editor?.mode === "edit" ? t("tasks.editor.save") : t("tasks.editor.create")}
							</Button>
						</div>
					</div>
				</div>
			)}
		</Modal>
	);
}
