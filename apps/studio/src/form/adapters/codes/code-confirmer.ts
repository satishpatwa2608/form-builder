import type { FormDefinition, FormValues } from '../../types';

/**
 * Confirming an email address or phone number with a one-time code. The page that shows a form says how codes
 * are sent and checked (the public form app asks the server; a preview has a stand-in), and the proofs that
 * come back are kept here until the form is submitted with them.
 */
export interface CodeConfirmer {
  send(definition: FormDefinition, field: string, value: string): Promise<void>;
  /** Resolves with the proof to send with the form; rejects with what to tell the person. */
  check(definition: FormDefinition, field: string, value: string, code: string): Promise<string>;
}

/** In a preview nothing is sent: 123456 is always the code. */
export const PREVIEW_CODE = '123456';
const preview: CodeConfirmer = {
  send: async () => undefined,
  check: async (_def, _field, _value, code) => {
    if (code !== PREVIEW_CODE) throw new Error(`In a preview the code is ${PREVIEW_CODE}`);
    return 'preview';
  },
};

let confirmer: CodeConfirmer = preview;
export const setCodeConfirmer = (next: CodeConfirmer | null) => {
  confirmer = next ?? preview;
};
export const codeConfirmer = () => confirmer;

const tidy = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase().replace(/[\s().-]/g, '') : '');
const proofs = new Map<string, { value: string; proof: string }>();
const key = (definition: Pick<FormDefinition, 'code'>, field: string) => `${definition.code}|${field}`;

export function rememberProof(definition: Pick<FormDefinition, 'code'>, field: string, value: string, proof: string) {
  proofs.set(key(definition, field), { value: tidy(value), proof });
}
/** Whether what the field holds now is what was confirmed. Changing the answer means confirming again. */
export const isConfirmed = (definition: Pick<FormDefinition, 'code'>, field: string, value: unknown) => {
  const kept = proofs.get(key(definition, field));
  return !!kept && !!tidy(value) && kept.value === tidy(value);
};
/** The proofs to send with a submission: one for each field whose present answer was confirmed. */
export function proofsFor(definition: Pick<FormDefinition, 'code' | 'fields'>, values: FormValues): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of definition.fields) if (isConfirmed(definition, f.name, values[f.name])) out[f.name] = proofs.get(key(definition, f.name))!.proof;
  return out;
}
export const forgetProofs = () => proofs.clear();
