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

/**
 * Form events: things that happen once, at a moment (the form opens, a
 * button is clicked, a submit succeeds or fails), unlike rules, which hold
 * for as long as their condition does. They run in the browser only: nothing
 * they do is trusted by the server, which still applies every rule on submit.
 */
export type FormEventTrigger =
  | { type: 'LOAD' }
  /** `field` is the name of a BUTTON field. */
  | { type: 'CLICK'; field: string }
  /** `field` is the name of a question: the actions run a moment after the person changes its answer. */
  | { type: 'CHANGE'; field: string }
  | { type: 'SUBMIT_SUCCESS' }
  | { type: 'SUBMIT_ERROR' };

/** A data source to read one row from; `params` may use `{{fieldName}}` like a dropdown's. */
export interface FetchSource {
  url: string;
  method: 'GET' | 'POST';
  params?: Record<string, string>;
}

/**
 * A look-up can also fill a repeating section, one row of it for each row that comes back (an order's lines, a
 * policy's nominees): `into` names the section, `set` says which property goes into which of its questions.
 */
export interface FetchRows {
  into: string;
  set: Record<string, string>;
}

export type FormEventAction =
  /** Fills the target once; the person can change it afterwards. */
  | { type: 'SET_VALUE'; target: string; value: string }
  /** Steps mode: `step` is the name of the top-level section to open. */
  | { type: 'GO_TO_STEP'; step: string }
  /** Reads the first row of a data source and copies its properties into fields: `{ fieldName: 'row.property' }`. */
  | { type: 'FETCH'; source: FetchSource; set: Record<string, string>; rows?: FetchRows }
  /** Puts the cursor in a question (opening its step, tab or panel first if it is not showing). */
  | { type: 'FOCUS'; target: string }
  /** Sends the form, as pressing Submit would: every check still runs first. */
  | { type: 'SUBMIT' }
  /** Empties the form back to how it opened. */
  | { type: 'RESET' }
  /** Saves the answers so far for later, as "Save and continue later" does (where the form allows saving). */
  | { type: 'SAVE' }
  /** After a submit: the text shown instead of the standard success or error message. */
  | { type: 'SHOW_MESSAGE'; message: string }
  /** After a successful submit: go to this address instead of showing a message. */
  | { type: 'REDIRECT'; url: string };

export interface FormEvent {
  id: string;
  name?: string;
  disabled?: boolean;
  on: FormEventTrigger;
  /** Left out, the actions always run when the event happens. */
  when?: RuleCondition;
  do: FormEventAction[];
}
