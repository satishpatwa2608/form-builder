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

/**
 * Form rules: "when X, then do Y, otherwise do Z". They sit on the form (not
 * on one field) because one rule can act on several fields. The per-field
 * `visibility` / `requiredWhen` above keep working alongside them.
 */

/** Either the point-and-click condition above or a typed expression such as `total > 5000 && !approved`. */
export type RuleCondition = Condition | { expr: string };

export type RuleStateAction = 'SHOW' | 'HIDE' | 'ENABLE' | 'DISABLE' | 'REQUIRE';

export type RuleAction =
  /**
   * State actions describe the field while the rule holds; the opposite
   * applies while it does not, so "show B when A is ticked" also hides B
   * otherwise without a second rule.
   */
  | { type: RuleStateAction; target: string }
  /** Sets the target to the result of an expression. The server recomputes it on submit. */
  | { type: 'SET_VALUE'; target: string; value: string }
  /** Marks the target invalid, with this message, while the rule holds. */
  | { type: 'ERROR'; target: string; message: string }
  /** Narrows a static option list to these option values while the rule holds. */
  | { type: 'SET_OPTIONS'; target: string; values: string[] };

export interface FormRule {
  /** Stable identity used by the builder. */
  id: string;
  name?: string;
  /** Kept in the form but not applied. */
  disabled?: boolean;
  /** Left out, the rule always holds (a plain calculation). */
  when?: RuleCondition;
  then: RuleAction[];
  /** Applied while `when` does not hold. Needs a `when`. */
  else?: RuleAction[];
}
