import type { CSSProperties } from 'react';

/**
 * Inline styles for the few things index.css has no compiled class for
 * (`text-destructive`, `font-mono`, `whitespace-pre-wrap`, `text-xl` are all
 * missing - see Design-system.md section 0).
 */
export const errorText: CSSProperties = { color: 'var(--destructive, #d4183d)' };

export const monoBlock: CSSProperties = {
  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
  fontSize: 12,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

/** @ui Textarea / SelectTrigger / RadioGroupItem default to `border-input`, which is transparent. */
export const VISIBLE_BORDER = 'border-gray-300';
