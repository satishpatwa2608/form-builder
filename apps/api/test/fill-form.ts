import { exampleAnswers, EXAMPLE_SIGNATURE, type FormDefinition, type FormField } from '@fb/engine';

/** The engine's own answer-filler, asked for the least that makes a form pass: the required questions only. */
export const SIGNATURE = EXAMPLE_SIGNATURE;
export const fillForm = (def: FormDefinition, upload: (field: FormField) => Promise<{ uploadId: string }>, now = new Date()) => exampleAnswers(def, { upload, now });
