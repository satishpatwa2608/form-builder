/**
 * Rule contract shared by visibility, conditional-required and (later) any
 * other "when X then Y" behaviour. Kept separate from dependency: a rule
 * decides whether a field is shown/required, a dependency decides when a
 * field's value is cleared and its options reloaded.
 */

export type ConditionOperator =
  | 'equals'
  | 'notEquals'
  | 'contains'
  | 'notContains'
  | 'in'
  | 'notIn'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'greaterThan'
  | 'lessThan'
  | 'greaterThanOrEqual'
  | 'lessThanOrEqual';

/** Compares one other field's current value (by `name`) against `value`. */
export interface ConditionLeaf {
  field: string;
  operator: ConditionOperator;
  /** Not used by isEmpty / isNotEmpty. An array for in / notIn. */
  value?: unknown;
}

export interface ConditionAll {
  all: Condition[];
}

export interface ConditionAny {
  any: Condition[];
}

export type Condition = ConditionLeaf | ConditionAll | ConditionAny;

export interface VisibilityRule {
  when: Condition;
}

export interface DependencyConfig {
  /** Names of the fields this field depends on. */
  dependsOn: string[];
  /** Clear this field's value when any parent changes. Defaults to true. */
  resetOnChange?: boolean;
}
