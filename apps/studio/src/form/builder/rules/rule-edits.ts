import type { FormDefinition, FormField, FormRule, RuleAction } from '../../types';
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

const CALCULABLE: ReadonlySet<FormField['type']> = new Set([
  'TEXT',
  'TEXTAREA',
  'NUMBER',
  'EMAIL',
  'PHONE',
  'DATE',
  'DATETIME',
  'CHECKBOX',
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
