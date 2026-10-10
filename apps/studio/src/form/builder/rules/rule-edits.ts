import type { FormDefinition, FormEvent, FormEventAction, FormField, FormRule, RuleAction } from '../../types';
import { isExpressionCondition, isOptionField, isValueField, validateFormDefinition } from '../../engine';
import { defaultCondition } from '../components/ConditionEditor';

export type ActionType = RuleAction['type'];

/** Reads as the start of a sentence that the target field finishes: "Show <field>". */
export const ACTION_LABEL: Record<ActionType, string> = {
  SHOW: 'Show',
  HIDE: 'Hide',
  REQUIRE: 'Make required',
  ENABLE: 'Enable',
  DISABLE: 'Disable',
  SET_VALUE: 'Set the value of',
  ERROR: 'Show an error on',
  SET_OPTIONS: 'Limit the options of',
};

export const ACTION_TYPES = Object.keys(ACTION_LABEL) as ActionType[];

/**
 * "Clear the answer to" is offered as its own choice, because nobody should have to know that an empty answer
 * is written `null`. It is kept as a set-value whose formula is exactly that, so the engine needs nothing new.
 */
export const CLEAR = 'CLEAR';
export const CLEAR_FORMULA = 'null';
export type ActionChoice = ActionType | typeof CLEAR;
export const ACTION_CHOICES: { value: ActionChoice; label: string }[] = [
  ...ACTION_TYPES.map((t) => ({ value: t as ActionChoice, label: ACTION_LABEL[t] })),
  { value: CLEAR, label: 'Clear the answer to' },
];
export const isClear = (a: RuleAction) => a.type === 'SET_VALUE' && a.value.trim() === CLEAR_FORMULA;

const CALCULABLE: ReadonlySet<FormField['type']> = new Set([
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'EMAIL',
  'PHONE',
  'DATE',
  'DATETIME',
  'TIME',
  'MONTH',
  'URL',
  'COLOR',
  'SLIDER',
  'CHECKBOX',
  'SWITCH',
  'STEPPER',
  'RADIO',
  'DROPDOWN',
  'HIDDEN',
]);

const fillable = (f: FormField) => isValueField(f) && f.type !== 'HIDDEN' && f.type !== 'CAPTCHA';
const hasFixedOptions = (f: FormField) => isOptionField(f) && f.dataSource?.type === 'STATIC' && !!f.dataSource.options?.length;

/** The fields an action of this type can act on (mirrors what publishing accepts). */
export function targetsFor(type: ActionType, fields: FormField[]): FormField[] {
  switch (type) {
    case 'SHOW':
    case 'HIDE':
      return fields.filter((f) => f.type !== 'HIDDEN' && f.type !== 'CAPTCHA');
    case 'SET_VALUE':
      return fields.filter((f) => CALCULABLE.has(f.type) && !f.systemSource && !f.prefill?.lock);
    case 'SET_OPTIONS':
      return fields.filter(hasFixedOptions);
    default:
      return fields.filter(fillable);
  }
}

/** Fields a condition or formula can read. */
export const readableFields = (fields: FormField[]): FormField[] => fields.filter((f) => isValueField(f) && f.type !== 'CAPTCHA');

/** An action of `type`, keeping the target when it still fits. */
export function actionOf(type: ActionType, fields: FormField[], keepTarget?: string): RuleAction {
  const targets = targetsFor(type, fields);
  const target = (targets.find((f) => f.name === keepTarget) ?? targets[0])?.name ?? '';
  switch (type) {
    case 'SET_VALUE':
      return { type, target, value: '' };
    case 'ERROR':
      return { type, target, message: '' };
    case 'SET_OPTIONS':
      return { type, target, values: [] };
    default:
      return { type, target };
  }
}

export function newRule(rules: FormRule[], fields: FormField[]): FormRule {
  const taken = new Set(rules.map((r) => r.id));
  let n = rules.length + 1;
  while (taken.has(`rule_${n}`)) n++;
  return { id: `rule_${n}`, name: '', when: defaultCondition(readableFields(fields)[0]), then: [actionOf('SHOW', fields)] };
}

export type ConditionMode = 'always' | 'conditions' | 'formula';

export const conditionMode = (rule: FormRule): ConditionMode =>
  !rule.when ? 'always' : isExpressionCondition(rule.when) ? 'formula' : 'conditions';

/** Switching how a rule decides. "Always" has no "otherwise", so that part goes too. */
export function withConditionMode(rule: FormRule, mode: ConditionMode, fields: FormField[]): FormRule {
  if (mode === conditionMode(rule)) return rule;
  if (mode === 'always') {
    const { when: _when, else: _else, ...rest } = rule;
    return rest;
  }
  return { ...rule, when: mode === 'formula' ? { expr: '' } : defaultCondition(readableFields(fields)[0]) };
}

/** The same, for the form's events. */
export function eventProblems(def: FormDefinition): Map<number, string[]> {
  const problems = new Map<number, string[]>();
  const result = validateFormDefinition(def, 'publish');
  if (result.success) return problems;
  for (const issue of result.issues) {
    const match = /^events\.(\d+)/.exec(issue.path);
    if (match) problems.set(Number(match[1]), [...(problems.get(Number(match[1])) ?? []), issue.message]);
  }
  return problems;
}

export type TriggerType = FormEvent['on']['type'];
export type EventActionType = FormEventAction['type'];

export const TRIGGER_LABEL: Record<TriggerType, string> = {
  LOAD: 'When the form opens',
  CLICK: 'When a button is clicked',
  SUBMIT_SUCCESS: 'After a successful submit',
  SUBMIT_ERROR: 'When a submit fails',
};

export const EVENT_ACTION_LABEL: Record<EventActionType, string> = {
  SET_VALUE: 'Set the value of',
  FETCH: 'Look up and fill in',
  GO_TO_STEP: 'Go to step',
  SHOW_MESSAGE: 'Show this message',
  REDIRECT: 'Go to this address',
};

/** What can happen at each moment (mirrors what publishing accepts). */
export const EVENT_ACTIONS_FOR: Record<TriggerType, EventActionType[]> = {
  LOAD: ['SET_VALUE', 'FETCH'],
  CLICK: ['SET_VALUE', 'FETCH', 'GO_TO_STEP'],
  SUBMIT_SUCCESS: ['SHOW_MESSAGE', 'REDIRECT'],
  SUBMIT_ERROR: ['SHOW_MESSAGE'],
};

export const buttonsOf = (fields: FormField[]): FormField[] => fields.filter((f) => f.type === 'BUTTON');
export const stepsOf = (fields: FormField[]): FormField[] => fields.filter((f) => f.type === 'SECTION' && f.parentId === undefined);

export function eventActionOf(type: EventActionType, fields: FormField[]): FormEventAction {
  switch (type) {
    case 'SET_VALUE':
      return { type, target: targetsFor('SET_VALUE', fields)[0]?.name ?? '', value: '' };
    case 'FETCH':
      return { type, source: { url: '', method: 'GET' }, set: {} };
    case 'GO_TO_STEP':
      return { type, step: stepsOf(fields)[0]?.name ?? '' };
    case 'SHOW_MESSAGE':
      return { type, message: '' };
    case 'REDIRECT':
      return { type, url: '' };
  }
}

/** Changing when an event happens keeps the actions that still fit, or starts with one that does. */
export function withTrigger(event: FormEvent, type: TriggerType, fields: FormField[]): FormEvent {
  const on: FormEvent['on'] = type === 'CLICK' ? { type, field: buttonsOf(fields)[0]?.name ?? '' } : { type };
  const kept = event.do.filter((a) => EVENT_ACTIONS_FOR[type].includes(a.type));
  return { ...event, on, do: kept.length ? kept : [eventActionOf(EVENT_ACTIONS_FOR[type][0], fields)] };
}

export function newEvent(events: FormEvent[], fields: FormField[]): FormEvent {
  const taken = new Set(events.map((e) => e.id));
  let n = events.length + 1;
  while (taken.has(`event_${n}`)) n++;
  return { id: `event_${n}`, name: '', on: { type: 'SUBMIT_SUCCESS' }, do: [eventActionOf('SHOW_MESSAGE', fields)] };
}

/** What stops each rule from publishing, by rule index; `-1` holds problems about the rules as a whole. */
export function ruleProblems(def: FormDefinition): Map<number, string[]> {
  const problems = new Map<number, string[]>();
  const result = validateFormDefinition(def, 'publish');
  if (result.success) return problems;
  for (const issue of result.issues) {
    const match = /^rules(?:\.(\d+))?/.exec(issue.path);
    if (!match) continue;
    const index = match[1] === undefined ? -1 : Number(match[1]);
    problems.set(index, [...(problems.get(index) ?? []), issue.message]);
  }
  return problems;
}
