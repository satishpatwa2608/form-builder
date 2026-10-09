import { answerFields, type FormDefinition } from '@fb/engine';

/** The fields a visit is counted against: what a person answers, not what the form fills in for them. */
export const countedFields = (def: FormDefinition) =>
  answerFields(def.fields)
    .filter((f) => f.type !== 'HIDDEN' && f.type !== 'CAPTCHA')
    .map((f) => ({ name: f.name, label: f.label ?? f.name }));
