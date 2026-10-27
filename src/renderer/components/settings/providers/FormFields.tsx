/**
 * Form field components: label and error display for provider configuration forms.
 */

import type { ReactNode } from "react";

export function FieldLabel({ children }: { children: ReactNode }) {
	// Matches common/Input's label so mixed field types read as one form.
	return <span className="mb-1.5 block text-omp-md font-medium text-(--omp-text-secondary)">{children}</span>;
}

export function FieldError({ message }: { message?: string }) {
	if (!message) return null;
	return (
		<span data-field-error="" className="mt-1 block text-omp-sm text-(--omp-error)">
			{message}
		</span>
	);
}
