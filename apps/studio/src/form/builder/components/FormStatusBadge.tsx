import type { FormStatus } from '../../types';

/** Design-system status combos (Design-system.md §3): neutral for draft/archived, success for published. */
const STYLE: Record<FormStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-600 border-gray-300',
  PUBLISHED: 'bg-green-50 text-green-700 border-green-200',
  ARCHIVED: 'bg-gray-100 text-gray-500 border-gray-200',
};

const LABEL: Record<FormStatus, string> = {
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  ARCHIVED: 'Archived',
};

export function FormStatusBadge({ status }: { status: FormStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${STYLE[status]}`}>
      {LABEL[status]}
    </span>
  );
}
