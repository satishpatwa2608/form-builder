import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type MutableRefObject } from 'react';
import { useForm, useWatch, type Resolver, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Form } from '@ui/form';
import type { FormDefinition, FormEventTrigger, FormStyle, FormValues, SubmissionResult, SystemContext } from '../../types';
import type { FormState } from '../../engine';
import {
  buildDefaultValues,
  buildFormCss,
  buildLayoutIndex,
  buildPayload,
  buildSteps,
  buildZodSchema,
  childrenOf,
  clickableButtons,
  coerceToField,
  computeFormState,
  eventActions,
  evaluateExpression,
  resolveParams,
  descendantsOf,
  emptyValueFor,
  isEmptyValue,
  answerFields,
  namesWithin,
  resetChildren,
  usedStyleIds,
  systemContextFor,
  valueAt,
  isRepeat,
  localize,
  pickLanguage,
  uiText,
} from '../../engine';
import { defaultSubmissionAdapter, type SubmissionAdapter } from '../../adapters/submission/submission-adapter';
import { defaultDataSourceAdapter, type DataSourceAdapter } from '../../adapters/data-source/data-source-adapter';
import type { CaptchaWidget } from '../../adapters/captcha/captcha-provider';
import { usePublishedForm } from '../../adapters/registry/useFormRegistry';
import { FormRuntimeProvider, useUi, type CaptchaMode } from '../FormRuntimeContext';
import { FieldList } from '../FieldRenderer/FieldRenderer';
import { REVEAL_EVENT } from '../fields/ContainerFields';
import '../../styles/form-runtime.css';
import { FormActions, FormErrorSummary, FormHeader, FormSuccess, problemsOf } from './FormParts';
import { FormReview } from './FormReview';
import { errorText } from '../styles';

export interface FormRuntimeProps {
  /** Host-supplied context (user, source channel, URL params). Overrides form-owned values. */
  systemContext?: SystemContext;
  submissionAdapter?: SubmissionAdapter;
  dataSourceAdapter?: DataSourceAdapter;
  /**
   * 'live' renders the configured CAPTCHA provider, 'mock' a local stand-in.
   * Defaults to live when the form has a site key, mock otherwise.
   */
  captchaMode?: CaptchaMode;
  /** Called after the adapter accepts a submission. */
  onSubmitted?: (result: SubmissionResult) => void;
  onValuesChange?: (values: FormValues) => void;
  /** Called with the questions at fault when the person tries to go on or submit and cannot. */
  onProblems?: (fields: string[]) => void;
  /** Used for cancel/success redirects and BUTTON links. Defaults to a full page load. */
  onNavigate?: (url: string) => void;
  showHeader?: boolean;
  /**
   * Live style-master entries for drafts (preview / playground). Published
   * versions carry their own snapshot in `definition.styles`, so the public
   * runtime never needs the master.
   */
  liveStyles?: FormStyle[];
  /** Start from these values (e.g. editing saved work fields) instead of the field defaults. */
  initialValues?: FormValues;
  /** Keep the form (with its values) after a successful submit instead of showing the success screen. */
  stayOnSubmit?: boolean;
}

export interface FormContainerProps extends FormRuntimeProps {
  /** Render this definition directly (preview, playground, embedding a known form). */
  definition?: FormDefinition;
  /** Or load the latest PUBLISHED version of this form code from the registry. */
  formCode?: string;
}

const FOCUSABLE = 'input:not([type="hidden"]), textarea, select, button, [tabindex]:not([tabindex="-1"])';
const fullPageNavigate = (url: string) => window.location.assign(url);

/**
 * The one runtime entry point for every form. Knows nothing about complaints
 * or any other domain - everything comes from the definition.
 */
export function FormContainer({ definition, formCode, ...runtime }: FormContainerProps) {
  if (definition) return <FormRuntime key={`${definition.id}@${definition.version}`} definition={definition} {...runtime} />;
  if (formCode) return <PublishedForm formCode={formCode} {...runtime} />;
  return null;
}

function PublishedForm({ formCode, ...runtime }: FormRuntimeProps & { formCode: string }) {
  const { data, isLoading, error } = usePublishedForm(formCode);
  const ui = useUi();
  if (isLoading) return <p className="text-sm text-muted-foreground">{ui('loading')}</p>;
  if (error) return <p style={errorText}>{ui('loadFailed')}</p>;
  if (!data) return <p className="text-sm text-muted-foreground">{ui('unavailable')}</p>;
  return <FormRuntime key={`${data.id}@${data.version}`} definition={data} {...runtime} />;
}

/**
 * Dependency engine: when a parent's value changes, clear every field
 * downstream of it (Business -> Section -> Sub-section). Their options reload
 * on their own because the option queries are keyed on the parent value.
 */
function useDependencyReset(
  form: UseFormReturn<FormValues>,
  definition: FormDefinition,
  values: FormValues,
  skipNext: MutableRefObject<boolean>,
) {
  const children = useMemo(() => resetChildren(definition.fields), [definition]);
  const previous = useRef(values);

  useEffect(() => {
    const before = previous.current;
    previous.current = values;
    if (skipNext.current) {
      skipNext.current = false;
      return;
    }
    for (const parent of children.keys()) {
      if (JSON.stringify(before[parent]) === JSON.stringify(values[parent])) continue;
      for (const name of descendantsOf(parent, children)) {
        const field = definition.fields.find((f) => f.name === name);
        if (!field || isEmptyValue(values[name])) continue;
        form.setValue(name, emptyValueFor(field.type), { shouldDirty: true, shouldValidate: false });
        form.clearErrors(name);
      }
    }
  }, [values, children, definition, form, skipNext]);
}

/** `a.b.c` in a fetched row, reading only what the row itself holds. */
function readOwnPath(row: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (at, key) => (at && typeof at === 'object' && Object.prototype.hasOwnProperty.call(at, key) ? (at as Record<string, unknown>)[key] : undefined),
    row,
  );
}

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

/**
 * Rule engine -> form state: writes each calculated value into the form so
 * the person sees it, and drops a choice a rule has just removed from a
 * narrowed option list. The server recomputes both on submit regardless.
 */
function useRuleValues(form: UseFormReturn<FormValues>, definition: FormDefinition, values: FormValues, state: FormState) {
  useEffect(() => {
    // A key is a field name, or `section.row.field` for a field in a row of a repeating section.
    for (const name of state.calculated) {
      const computed = valueAt(state.values, name);
      if (JSON.stringify(valueAt(values, name)) === JSON.stringify(computed)) continue;
      form.setValue(name, computed, { shouldDirty: true, shouldValidate: !!form.getFieldState(name).error });
    }
    for (const [name, allowed] of state.options) {
      const value = valueAt(values, name);
      const field = definition.fields.find((f) => f.name === name.split('.').pop());
      if (!field || isEmptyValue(value)) continue;
      if (Array.isArray(value)) {
        const kept = value.filter((v) => allowed.has(String(v)));
        if (kept.length !== value.length) form.setValue(name, kept, { shouldDirty: true });
      } else if (!allowed.has(String(value))) {
        form.setValue(name, emptyValueFor(field.type), { shouldDirty: true });
      }
    }
  }, [form, definition, values, state]);
}

function FormRuntime({
  definition: source,
  systemContext,
  submissionAdapter = defaultSubmissionAdapter,
  dataSourceAdapter = defaultDataSourceAdapter,
  captchaMode,
  onSubmitted,
  onValuesChange,
  onProblems,
  onNavigate = fullPageNavigate,
  showHeader = true,
  liveStyles,
  initialValues,
  stayOnSubmit = false,
}: FormRuntimeProps & { definition: FormDefinition }) {
  const containerRef = useRef<HTMLFormElement>(null);
  // The form in the language it is being shown in: wording only; names, values and rules are the same in every language.
  const language = pickLanguage(source, systemContext?.language);
  const definition = useMemo(() => localize(source, language), [source, language]);
  const ui = useMemo(() => uiText(language, source), [language, source]);
  // The person's own zone, so `today()` in a rule is their date; the server is told the same zone on submit.
  const context = useMemo(() => systemContextFor(definition, { timeZone: browserTimeZone(), ...systemContext, language }), [definition, systemContext, language]);
  const schema = useMemo(() => buildZodSchema(definition, context), [definition, context]);
  const defaults = useMemo(() => ({ ...buildDefaultValues(definition, context), ...initialValues }), [definition, context, initialValues]);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema) as Resolver<FormValues>,
    defaultValues: defaults,
    // Leaving a field checks it too, but that is done by `checkOnLeave` below rather than by the form library.
    mode: 'onSubmit',
  });

  // Read on every render, so the form library keeps this component up to date with errors
  // however they came about (a failed submit, or the check before the review page).
  const formErrors = form.formState.errors;
  const values = useWatch({ control: form.control }) as FormValues;
  const formState = useMemo(() => computeFormState(definition, values, context), [definition, values, context]);
  const { states } = formState;
  useRuleValues(form, definition, values, formState);

  const layout = useMemo(() => buildLayoutIndex(definition.fields), [definition]);

  // Look and feel: published forms carry a style snapshot; drafts/previews read the live master.
  const scope = `fpf-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const css = useMemo(() => {
    const ids = usedStyleIds(definition);
    const styles = definition.styles ?? (liveStyles ?? []).filter((st) => ids.includes(st.id));
    return buildFormCss(`.${scope}`, definition.theme, styles);
  }, [definition, liveStyles, scope]);

  // Steps mode: top-level sections become pages; hidden sections are skipped.
  const allSteps = useMemo(() => (definition.layout?.mode === 'steps' ? buildSteps(definition.fields) : null), [definition]);
  const steps = useMemo(
    () => allSteps?.filter((st) => !st.section || states.get(st.section.name)?.visible !== false) ?? null,
    [allSteps, states],
  );
  const [stepIndex, setStepIndex] = useState(0);
  const stepsRef = useRef(steps);
  stepsRef.current = steps;
  const step = steps ? steps[Math.min(stepIndex, steps.length - 1)] : undefined;
  const isLastStep = !steps || stepIndex >= steps.length - 1;
  const pendingFocus = useRef<string | null>(null);

  const skipDependencyReset = useRef(false);
  // Changing language while mistakes are showing: say them again, in the new language.
  const shownIn = useRef(language);
  useEffect(() => {
    if (shownIn.current === language) return;
    shownIn.current = language;
    if (Object.keys(form.formState.errors).length) void form.trigger();
  }, [language, form]);

  useDependencyReset(form, definition, values, skipDependencyReset);

  const [result, setResult] = useState<SubmissionResult | null>(null);

  /**
   * Once a field has been checked (by leaving it, by "Next", or by the check
   * before the review page), fields with an error are re-checked on every
   * change: the message goes as soon as the answer is right.
   */
  const [recheck, setRecheck] = useState(false);

  /**
   * A field is checked when the person leaves it. If they left it by pressing
   * the mouse on something else, the check waits until that click is over: an
   * error message appearing or going in between would move the page under the
   * cursor, and the click would land on nothing.
   */
  const pointerDown = useRef(false);
  const leftWhilePressed = useRef(new Set<string>());
  useEffect(() => {
    const check = (names: string[]) => {
      if (!names.length) return;
      setRecheck(true);
      void form.trigger(names);
    };
    const down = () => {
      pointerDown.current = true;
    };
    const up = () => {
      pointerDown.current = false;
      // After the click this press produces has been handled.
      setTimeout(() => {
        const names = [...leftWhilePressed.current];
        leftWhilePressed.current.clear();
        check(names);
      }, 0);
    };
    const left = (e: FocusEvent) => {
      const el = containerRef.current;
      const wrapper = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-field-name]');
      const name = wrapper?.dataset.fieldName;
      // Moving between the parts of one field (its radio buttons, a stepper's - and +) is not leaving it.
      if (!el || !wrapper || !name || !el.contains(wrapper) || (e.relatedTarget instanceof Node && wrapper.contains(e.relatedTarget))) return;
      if (pointerDown.current) leftWhilePressed.current.add(name);
      else check([name]);
    };
    const el = containerRef.current;
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('pointerup', up, true);
    document.addEventListener('pointercancel', up, true);
    el?.addEventListener('focusout', left);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('pointerup', up, true);
      document.removeEventListener('pointercancel', up, true);
      el?.removeEventListener('focusout', left);
    };
    // The form element is replaced by the success screen and comes back on reset.
  }, [form, result]);

  useEffect(() => {
    onValuesChange?.(values);
  }, [values, onValuesChange]);

  /** What the server found wrong, with the answer it was about: `field or row key -> { message, answer }`. */
  const serverFindings = useRef(new Map<string, { message: string; answer: string }>());

  useEffect(() => {
    const failing = Object.keys(form.formState.errors);
    if (!recheck || !failing.length) return;
    void form.trigger(failing).then(() => {
      // Re-checking knows nothing of what the server found, and would wipe it.
      // A finding stays until the answer it was about changes.
      for (const [name, finding] of serverFindings.current) {
        if (JSON.stringify(valueAt(form.getValues(), name)) === finding.answer) form.setError(name, { type: 'server', message: finding.message });
        else serverFindings.current.delete(name);
      }
    });
    // Only when an answer changes: re-checking on every error change would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [showSummary, setShowSummary] = useState(false);
  /** The "check your answers" page is showing instead of the fields. */
  const [reviewing, setReviewing] = useState(false);
  /** Set by a "submit succeeded" event: shown instead of the form's standard thank-you text. */
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  /** What a look-up has to say when it finds nothing or fails. */
  const [notice, setNotice] = useState<string | null>(null);
  const [resetKey, setResetKey] = useState(0);

  const captcha = useRef<CaptchaWidget | null>(null);
  const registerCaptcha = useCallback((widget: CaptchaWidget | null) => {
    captcha.current = widget;
  }, []);
  const captchaField = definition.fields.find((f) => f.type === 'CAPTCHA');
  const resolvedCaptchaMode: CaptchaMode = captchaMode ?? (definition.captcha?.siteKey ? 'live' : 'mock');

  /**
   * Runs the form's events for what just happened: fill a field, open a step,
   * look a row up. All of it is a convenience for the person filling in - the
   * server trusts none of it and applies every rule again on submit.
   */
  const runEvent = useCallback(
    async (trigger: FormEventTrigger) => {
      const current = () => computeFormState(definition, form.getValues(), context).values;
      const fill = (name: string, value: unknown) => {
        const target = definition.fields.find((f) => f.name === name);
        if (target) form.setValue(name, coerceToField(value, target), { shouldDirty: true, shouldValidate: !!form.formState.errors[name] });
      };
      setNotice(null);
      for (const action of eventActions(definition, trigger, current(), context)) {
        if (action.type === 'SET_VALUE') fill(action.target, evaluateExpression(action.value, current(), context).value);
        else if (action.type === 'GO_TO_STEP') {
          const index = stepsRef.current?.findIndex((st) => st.section?.name === action.step) ?? -1;
          if (index >= 0) setStepIndex(index);
        } else if (action.type === 'FETCH') {
          const { params, unresolved } = resolveParams(action.source.params, current(), context);
          if (unresolved.length) {
            setNotice(ui('lookupNeeds'));
            continue;
          }
          try {
            const [row] = await dataSourceAdapter.fetchRows({ ...action.source, valueField: '', labelField: '' }, params);
            if (!row) setNotice(ui('lookupNone'));
            else for (const [name, path] of Object.entries(action.set)) fill(name, readOwnPath(row, path));
          } catch {
            setNotice(ui('lookupFailed'));
          }
        }
      }
    },
    [definition, form, context, dataSourceAdapter],
  );

  const loaded = useRef(false);
  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    void runEvent({ type: 'LOAD' });
  }, [runEvent]);

  const resetForm = () => {
    skipDependencyReset.current = true;
    form.reset(defaults);
    captcha.current?.reset();
    setResult(null);
    setSubmitError(null);
    setShowSummary(false);
    setSuccessMessage(null);
    setNotice(null);
    setReviewing(false);
    setRecheck(false);
    setResetKey((k) => k + 1);
    setStepIndex(0);
  };

  const onValid = async (submitted: FormValues) => {
    setShowSummary(false);
    setSubmitError(null);
    serverFindings.current.clear();
    const computed = computeFormState(definition, submitted, context).values;
    try {
      const res = await submissionAdapter.submit({
        definition,
        payload: buildPayload(definition, submitted, context),
        values: submitted,
        systemContext: context,
      });
      if (!res.ok) {
        // The server re-validates; show its per-field findings where they belong.
        for (const fe of res.fieldErrors ?? []) {
          // `lines.0.qty` belongs to the repeating section `lines`.
          const owner = fe.field.split('.')[0];
          if (definition.fields.some((f) => f.name === fe.field || (f.name === owner && isRepeat(f)))) {
            form.setError(fe.field, { type: 'server', message: fe.message });
            serverFindings.current.set(fe.field, { message: fe.message, answer: JSON.stringify(valueAt(submitted, fe.field)) });
          }
        }
        if (res.fieldErrors?.length) {
          // Back to the form: the findings are shown next to their fields.
          setReviewing(false);
          setShowSummary(true);
        }
        const told = eventActions(definition, { type: 'SUBMIT_ERROR' }, computed, context).find((a) => a.type === 'SHOW_MESSAGE');
        setSubmitError(told?.type === 'SHOW_MESSAGE' ? told.message : res.error ?? ui('submitFailed'));
        captcha.current?.reset();
        return;
      }
      onSubmitted?.(res);
      // An event for this outcome (e.g. "over 5,000: say a manager will call") replaces the standard ending.
      const after = eventActions(definition, { type: 'SUBMIT_SUCCESS' }, computed, context);
      const redirect = after.find((a) => a.type === 'REDIRECT');
      const message = after.find((a) => a.type === 'SHOW_MESSAGE');
      const success = definition.submission.success;
      if (redirect?.type === 'REDIRECT') onNavigate(redirect.url);
      else if (message?.type === 'SHOW_MESSAGE') {
        setSuccessMessage(message.message);
        if (!stayOnSubmit) setResult(res);
      } else if (success?.type === 'REDIRECT' && success.redirectUrl) onNavigate(success.redirectUrl);
      else if (!stayOnSubmit) setResult(res);
    } catch (e) {
      const told = eventActions(definition, { type: 'SUBMIT_ERROR' }, computed, context).find((a) => a.type === 'SHOW_MESSAGE');
      setSubmitError(told?.type === 'SHOW_MESSAGE' ? told.message : e instanceof Error ? e.message : ui('submitFailed'));
      captcha.current?.reset();
    }
  };

  /**
   * Invisible and v3 CAPTCHAs have no token until asked, so fetch one before
   * validation runs - otherwise the required-token check would always fail.
   */
  /** Validate only what's on this step, then move on. */
  const goNext = async () => {
    if (!steps || !step) return;
    const onStep = namesWithin(definition.fields, step.items);
    // Top-level answers; a repeating section is validated as a whole, rows included.
    const names = answerFields(definition.fields)
      .filter((f) => onStep.has(f.name) && states.get(f.name)?.visible !== false)
      .map((f) => f.name);
    if (await form.trigger(names)) {
      setStepIndex((i) => Math.min(i + 1, steps.length - 1));
      containerRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    } else {
      onProblems?.(Object.keys(form.formState.errors));
      setRecheck(true);
      // Go to the first mistake on this step, opening the tab or panel it is in if that is closed.
      const first = problemsOf(definition, form.formState.errors).find((p) => onStep.has(p.key.split('.')[0]));
      if (first) focusField(first.key);
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    // Enter in a text box submits the HTML form; before the last step that means "Next".
    if (!isLastStep) return goNext();
    // A last look first, when the form asks for one. Only complete, valid answers get that far.
    if (definition.layout?.review && !reviewing) {
      // An invisible CAPTCHA has no token until the real submit, so it is not checked here.
      const invisible = captchaField && definition.captcha?.mode !== 'CHECKBOX';
      const names = answerFields(definition.fields).filter((f) => !(invisible && f.id === captchaField.id)).map((f) => f.name);
      if (await form.trigger(names)) {
        setShowSummary(false);
        setSubmitError(null);
        setReviewing(true);
        containerRef.current?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      } else {
        setRecheck(true);
        setShowSummary(true);
      }
      return;
    }
    const mode = definition.captcha?.mode;
    if (captchaField && mode && mode !== 'CHECKBOX' && !form.getValues(captchaField.name) && captcha.current) {
      try {
        form.setValue(captchaField.name, await captcha.current.execute());
      } catch {
        setSubmitError(ui('verifyFailed'));
        return;
      }
    }
    await form.handleSubmit(onValid, (errors) => {
      onProblems?.(Object.keys(errors));
      setReviewing(false);
      setShowSummary(true);
    })();
  };

  const onCancel = () => {
    const cancel = definition.actions?.cancel;
    if (cancel?.behavior === 'REDIRECT' && cancel.redirectUrl) onNavigate(cancel.redirectUrl);
    else resetForm();
  };

  const focusField = (name: string) => {
    if (reviewing) {
      // Leave the review page first; the field is focused once the form is showing again.
      pendingFocus.current = name;
      setReviewing(false);
      return;
    }
    // In steps mode the field may be on another step: go there first, focus after it renders.
    const target = steps?.findIndex((st) => namesWithin(definition.fields, st.items).has(name.split('.')[0])) ?? -1;
    if (steps && target >= 0 && target !== stepIndex) {
      pendingFocus.current = name;
      setStepIndex(target);
      return;
    }
    const wrapper = containerRef.current?.querySelector<HTMLElement>(`[data-field-name="${name}"]`);
    if (!wrapper) return;
    // It may sit on a tab or in a panel that is not showing: have those open first.
    const wasHidden = !!wrapper.closest('[hidden]');
    wrapper.dispatchEvent(new CustomEvent(REVEAL_EVENT, { bubbles: true }));
    const focus = () => {
      wrapper.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
      wrapper.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    };
    if (wasHidden) setTimeout(focus, 0);
    else focus();
  };

  useEffect(() => {
    if (pendingFocus.current) {
      const name = pendingFocus.current;
      pendingFocus.current = null;
      focusField(name);
    }
  });

  // Switched off by a rule, or filled in by one: either way not for typing into.
  const readOnly = useMemo(() => new Set([...formState.disabled, ...formState.calculated]), [formState]);

  const clickable = useMemo(() => clickableButtons(definition), [definition]);
  const onButtonClick = useCallback((name: string) => runEvent({ type: 'CLICK', field: name }), [runEvent]);

  const runtimeValue = useMemo(
    () => ({
      definition,
      values,
      states,
      readOnly,
      allowedOptions: formState.options,
      clickable,
      onButtonClick,
      systemContext: context,
      navigate: onNavigate,
      dataSourceAdapter,
      captchaMode: resolvedCaptchaMode,
      registerCaptcha,
      resetKey,
      layout,
      ui,
      stepSectionId: step?.section?.id,
    }),
    [ui, definition, values, states, readOnly, formState.options, clickable, onButtonClick, context, onNavigate, dataSourceAdapter, resolvedCaptchaMode, registerCaptcha, resetKey, layout, step],
  );

  if (result) {
    return (
      <div className={`space-y-6 ${scope}`}>
        <style>{css}</style>
        {showHeader && <FormHeader definition={definition} />}
        <FormSuccess message={successMessage ?? definition.submission.success?.message ?? ui('thankYou')} reference={result.ref} onReset={resetForm} />
      </div>
    );
  }

  return (
    <FormRuntimeProvider value={runtimeValue}>
      <Form {...form}>
        <style>{css}</style>
        <form ref={containerRef} noValidate aria-label={definition.name} className={`space-y-6 ${scope}`} onSubmit={onSubmit}>
          {showHeader && <FormHeader definition={definition} />}
          {!reviewing && steps && step && steps.length > 1 && (
            <div className="fp-steps" aria-live="polite">
              <div className="fp-steps__label">
                <span className="fp-steps__title">{step.title}</span>
                <span>
                  Step {Math.min(stepIndex, steps.length - 1) + 1} of {steps.length}
                </span>
              </div>
              <div className="fp-steps__bar">
                <div className="fp-steps__fill" style={{ width: `${((Math.min(stepIndex, steps.length - 1) + 1) / steps.length) * 100}%` }} />
              </div>
            </div>
          )}
          {showSummary && (
            <FormErrorSummary definition={definition} errors={formErrors} onSelect={focusField} />
          )}
          {reviewing && <FormReview definition={definition} state={formState} values={values} onEdit={focusField} />}
          {/* Kept mounted while reviewing, so a CAPTCHA that was solved stays solved. */}
          <div hidden={reviewing}>
            <FieldList items={step ? step.items : childrenOf(layout)} />
          </div>
          {notice && (
            <p role="status" className="text-sm text-muted-foreground">
              {notice}
            </p>
          )}
          {submitError && (
            <p role="alert" className="text-sm" style={errorText}>
              {submitError}
            </p>
          )}
          <FormActions
            definition={definition}
            isSubmitting={form.formState.isSubmitting}
            onCancel={onCancel}
            steps={
              reviewing
                ? { canGoBack: true, isLast: true, onBack: () => setReviewing(false) }
                : steps && steps.length > 1
                  ? { canGoBack: stepIndex > 0, isLast: isLastStep, onBack: () => setStepIndex((i) => Math.max(0, i - 1)) }
                  : undefined
            }
          />
        </form>
      </Form>
    </FormRuntimeProvider>
  );
}
