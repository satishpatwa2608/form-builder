import { useState } from 'react';
import { Button } from '@ui/button';
import { formShape, isNumberField, isTimeZone, isValueField, languageName, languagesOf } from '../../engine';
import { LanguagesDialog } from './LanguagesDialog';
import type { FontFamily, FormActionConfig, FormDefinition, FormTheme, SubmissionConfig } from '../../types';
import { Checkbox } from '@ui/checkbox';
import { useSubmitChecks } from '../../adapters/extensions';
import { useStyles } from '../../adapters/styles/style-master';
import { VISIBLE_BORDER } from '../../runtime/styles';
import { ColorSetting, SelectSetting, Setting, SwitchSetting, TextSetting } from './settings';
import { MultiSelect } from '@ui/multiselect';
import { OwnPdfSetting } from './OwnPdfSetting';
import { OpenWithSetting } from './OpenWithSetting';

/** A stored ISO time as the value of a date-and-time box (the person's own time zone), and back. */
function toLocalInput(iso: string | undefined): string {
  const d = iso ? new Date(iso) : undefined;
  if (!d || Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(value: string): string | undefined {
  const d = value ? new Date(value) : undefined;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined;
}

const CURRENCIES = [
  { label: 'Indian rupee (INR)', value: 'INR' },
  { label: 'US dollar (USD)', value: 'USD' },
  { label: 'Canadian dollar (CAD)', value: 'CAD' },
  { label: 'Euro (EUR)', value: 'EUR' },
  { label: 'British pound (GBP)', value: 'GBP' },
  { label: 'UAE dirham (AED)', value: 'AED' },
  { label: 'Singapore dollar (SGD)', value: 'SGD' },
  { label: 'Australian dollar (AUD)', value: 'AUD' },
];

/** Money taken before a response is accepted: which number of the form is the amount, and in what currency. */
function PaymentSettings({ form, onChange }: Pick<FormSettingsPanelProps, 'form' | 'onChange'>) {
  const pay = form.payment;
  const inRows = formShape(form.fields).repeatOf;
  const amounts = form.fields.filter((f) => isNumberField(f) && !inRows.has(f.name)).map((f) => ({ label: f.label || f.name, value: f.name }));
  const set = (changes: Partial<NonNullable<FormDefinition['payment']>>) => onChange({ payment: { enabled: true, amountField: amounts[0]?.value ?? '', currency: 'INR', ...pay, ...changes } });
  return (
    <>
      <SwitchSetting
        label="Take a payment with each response"
        hint="The person pays on your payment service's page, and the response is accepted only once the money has arrived. Choose the service in Organisation settings → Payments."
        checked={pay?.enabled === true}
        onChange={(enabled) => (enabled ? set({ enabled: true }) : onChange({ payment: pay ? { ...pay, enabled: false } : undefined }))}
      />
      {pay?.enabled && (
        <>
          {amounts.length ? (
            <SelectSetting
              label="Amount to pay"
              value={pay.amountField}
              options={amounts}
              onChange={(amountField) => set({ amountField })}
              hint="A number field of this form, usually one a rule works out (a fee, a premium). When it comes to 0, nothing is asked for."
            />
          ) : (
            <p className="fb-setting__hint" role="alert">
              Add a number field for the amount first.
            </p>
          )}
          <SelectSetting label="Currency" value={pay.currency} options={CURRENCIES} onChange={(currency) => set({ currency })} />
          <TextSetting label="What the payment is for" value={pay.description} placeholder={form.name} hint="Shown on the payment page and on the person's statement." onChange={(description) => set({ description: description || undefined })} />
        </>
      )}
    </>
  );
}

interface FormSettingsPanelProps {
  form: FormDefinition;
  readOnly: boolean;
  /** The code is the form's identity across versions - only a never-published v1 may change it. */
  codeLocked: boolean;
  onChange: (changes: Partial<FormDefinition>) => void;
}

/** Kinds of field the PDF never prints anyway, so there is nothing to leave out. */
const NEVER_PRINTED = new Set(['HIDDEN', 'CAPTCHA', 'HTML', 'BUTTON', 'IMAGE']);

/** The PDF settings with nothing left set to nothing; undefined when there is none at all. */
const tidyDocument = (d: NonNullable<FormDefinition['document']>): FormDefinition['document'] => {
  const kept = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined && v !== ''));
  return Object.keys(kept).length ? kept : undefined;
};

/**
 * Checks the organisation's own code runs before a submission is accepted.
 * Nothing is shown unless its extension offers some, or the form names one.
 */
function SubmitChecks({ form, onChange }: Pick<FormSettingsPanelProps, 'form' | 'onChange'>) {
  const { data: offered = [], isSuccess } = useSubmitChecks();
  const chosen = form.submitChecks ?? [];
  // One the form still names although the extension stopped offering it: shown so it can be removed.
  const gone = isSuccess ? chosen.filter((key) => !offered.some((c) => c.key === key)) : [];
  if (!offered.length && !chosen.length) return null;
  const set = (key: string, on: boolean) => {
    const next = on ? [...chosen, key] : chosen.filter((k) => k !== key);
    onChange({ submitChecks: next.length ? next : undefined });
  };
  return (
    <div className="fb-setting" role="group" aria-label="Checks from your extension">
      <span className="fb-setting__label">Checks from your extension</span>
      <div className="fb-checks">
        {offered.map((c) => (
          <label key={c.key}>
            <Checkbox className={VISIBLE_BORDER} checked={chosen.includes(c.key)} onCheckedChange={(v) => set(c.key, v === true)} />
            <span>
              {c.label}
              {c.description && <span className="fb-muted" style={{ display: 'block' }}>{c.description}</span>}
            </span>
          </label>
        ))}
        {gone.map((key) => (
          <label key={key}>
            <Checkbox className={VISIBLE_BORDER} checked onCheckedChange={() => set(key, false)} />
            <span style={{ color: 'var(--destructive)' }}>A check that is no longer offered. Untick it to publish.</span>
          </label>
        ))}
      </div>
      <span className="fb-setting__hint">Run after the form's own rules pass. A submission is refused if a check objects, or cannot be run.</span>
    </div>
  );
}

/** Shown when no field is selected: everything about the form as a whole. */
export function FormSettingsPanel({ form, readOnly, codeLocked, onChange }: FormSettingsPanelProps) {
  const [languagesOpen, setLanguagesOpen] = useState(false);
  const submit = form.actions?.submit ?? { enabled: true, label: 'Submit' };
  const cancel = form.actions?.cancel ?? { enabled: false, label: 'Cancel', behavior: 'RESET' as const };
  const success = form.submission.success ?? { type: 'MESSAGE' as const };

  const setActions = (changes: Partial<FormActionConfig>) => onChange({ actions: { ...form.actions, ...changes } });
  const setSubmission = (changes: Partial<SubmissionConfig>) => onChange({ submission: { ...form.submission, ...changes } });
  const theme = form.theme ?? {};
  const setTheme = (changes: Partial<FormTheme>) => {
    const next = { ...theme, ...changes };
    const empty = Object.values(next).every((v) => v === undefined || v === '' || v === 'default');
    onChange({ theme: empty ? undefined : next });
  };
  const { data: styles = [] } = useStyles();

  return (
    <div className="fb-panel" aria-label="Form settings">
      <fieldset disabled={readOnly} className="fb-settings" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <div className="fb-panel__title">Form</div>
        <TextSetting label="Form name" value={form.name} onChange={(name) => onChange({ name })} />
        <TextSetting
          label="Description"
          multiline
          value={form.description}
          hint="Shown under the title."
          onChange={(description) => onChange({ description: description || undefined })}
        />
        <TextSetting
          label="Form code"
          value={form.code}
          disabled={codeLocked}
          hint={codeLocked ? 'Fixed once a form has been published - links and pages point at it.' : 'UPPER_SNAKE_CASE. Used in the form link.'}
          onChange={(code) => onChange({ code: code.toUpperCase() })}
        />
        <TextSetting label="Business" value={form.businessId} hint="Business id this form belongs to." onChange={(businessId) => onChange({ businessId })} />
        <SelectSetting
          label="Who can open it"
          value={form.access}
          options={[
            { label: 'Anyone - signed in or not', value: 'PUBLIC' },
            { label: 'Signed-in users only', value: 'AUTHENTICATED' },
          ]}
          onChange={(access) => onChange({ access })}
        />

        <div className="fb-setting">
          <span className="fb-setting__label">Languages</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span>{languagesOf(form).map(languageName).join(', ')}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => setLanguagesOpen(true)}>
              {readOnly ? 'See translations' : 'Languages and translations'}
            </Button>
          </div>
        </div>
        <LanguagesDialog form={form} readOnly={readOnly} open={languagesOpen} onOpenChange={setLanguagesOpen} onChange={onChange} />
        <TextSetting
          label="Time zone"
          value={form.timeZone}
          placeholder="Each person's own"
          hint={
            form.timeZone && !isTimeZone(form.timeZone)
              ? 'Not a time zone yet. Use a name such as Asia/Kolkata or Europe/London.'
              : 'What "today" means in rules. Leave empty to use the zone of whoever is filling in the form.'
          }
          onChange={(timeZone) => onChange({ timeZone: timeZone.trim() || undefined })}
        />

        <div className="fb-panel__title">Availability</div>
        <div className="fb-row">
          <TextSetting label="Opens" type="datetime-local" value={toLocalInput(form.opensAt)} onChange={(v) => onChange({ opensAt: fromLocalInput(v) })} />
          <TextSetting label="Closes" type="datetime-local" value={toLocalInput(form.closesAt)} onChange={(v) => onChange({ closesAt: fromLocalInput(v) })} />
        </div>
        <span className="fb-setting__hint">
          {form.opensAt || form.closesAt
            ? 'Outside these times the public sees a notice instead of the form. Staff can still raise items from inside.'
            : 'Leave both empty for a form that is always open once published.'}
        </span>
        {form.closesAt && (
          <TextSetting
            label="Message once closed"
            multiline
            value={form.closedMessage}
            placeholder="This form is closed and no longer takes answers."
            onChange={(closedMessage) => onChange({ closedMessage: closedMessage || undefined })}
          />
        )}
        <OpenWithSetting form={form} onChange={(openWith) => onChange({ openWith })} />
        <SwitchSetting
          label="Let people save and continue later"
          hint="They get a private link to come back to their answers within 30 days."
          checked={form.saveForLater !== false}
          onChange={(on) => onChange({ saveForLater: on ? undefined : false, ...(on ? {} : { saveAsYouGo: undefined }) })}
        />
        {form.saveForLater !== false && (
          <SwitchSetting
            label="Save answers as people go"
            hint="Nothing to press: answers are kept every few seconds and are there when the person comes back on the same phone or computer. Leave off for forms filled in on a shared computer."
            checked={!!form.saveAsYouGo}
            onChange={(on) => onChange({ saveAsYouGo: on || undefined })}
          />
        )}
        {form.access === 'PUBLIC' && (
          <SwitchSetting
            label="List on the requests portal"
            hint="Shown under 'Start something new' on your organisation's portal, once the portal is switched on (Organisation settings)."
            checked={form.listOnPortal === true}
            onChange={(on) => onChange({ listOnPortal: on || undefined })}
          />
        )}
        <PaymentSettings form={form} onChange={onChange} />
        <SwitchSetting
          label="Keep a PDF of each response"
          hint="Made by the server as each response arrives and stored with it. Without this, a PDF is still made the first time someone opens it from Responses."
          checked={form.document?.keep === true}
          onChange={(keep) => onChange({ document: tidyDocument({ ...form.document, keep: keep || undefined }) })}
        />
        <TextSetting
          label="Title on the PDF"
          value={form.document?.title}
          placeholder={form.name}
          onChange={(title) => onChange({ document: tidyDocument({ ...form.document, title: title || undefined }) })}
        />
        <TextSetting
          label="Line at the foot of each page"
          value={form.document?.footer}
          placeholder="e.g. Confidential"
          onChange={(footer) => onChange({ document: tidyDocument({ ...form.document, footer: footer || undefined }) })}
        />
        <SwitchSetting
          label="List questions nobody answered"
          checked={form.document?.showEmpty === true}
          onChange={(showEmpty) => onChange({ document: tidyDocument({ ...form.document, showEmpty: showEmpty || undefined }) })}
        />
        <Setting label="Leave out of the PDF" hint="Still asked on the form and kept on the record; just not printed. A section takes everything in it along.">
          {() => (
            <MultiSelect
              options={form.fields.filter((f) => !NEVER_PRINTED.has(f.type) && (f.type === 'SECTION' || f.type === 'REPEAT' || isValueField(f))).map((f) => ({ label: `${f.label || f.name}${f.type === 'SECTION' ? ' (section)' : ''}`, value: f.name }))}
              value={form.document?.leaveOut ?? []}
              onChange={(leaveOut) => onChange({ document: tidyDocument({ ...form.document, leaveOut: leaveOut.length ? leaveOut : undefined }) })}
              placeholder="Everything is printed"
              maxVisibleTags={6}
            />
          )}
        </Setting>
        {form.fields.some((f) => f.type === 'SECTION') && (
          <Setting label="Start on a new page" hint="Sections that begin a fresh page of the PDF.">
            {() => (
              <MultiSelect
                options={form.fields.filter((f) => f.type === 'SECTION').map((f) => ({ label: f.label || f.name, value: f.name }))}
                value={form.document?.newPage ?? []}
                onChange={(newPage) => onChange({ document: tidyDocument({ ...form.document, newPage: newPage.length ? newPage : undefined }) })}
                placeholder="No page breaks"
                maxVisibleTags={6}
              />
            )}
          </Setting>
        )}
        <TextSetting
          label="Closing note"
          multiline
          value={form.document?.note}
          placeholder="e.g. This document is a record of what was submitted and is not an approval."
          onChange={(note) => onChange({ document: tidyDocument({ ...form.document, note: note || undefined }) })}
        />
        <SelectSetting
          label="Typeface of the PDF"
          value={form.document?.font ?? 'sans'}
          options={[
            { label: 'Plain (sans-serif)', value: 'sans' },
            { label: 'Bookish (serif)', value: 'serif' },
          ]}
          hint="For English and other Latin-letter text. Hindi and the other Indian scripts keep their own fonts."
          onChange={(font) => onChange({ document: tidyDocument({ ...form.document, font: font === 'serif' ? 'serif' : undefined }) })}
        />
        <SwitchSetting
          label="Archival PDF (PDF/A)"
          hint="For records that must be readable for decades: the file carries its own fonts and colour description, to the PDF/A-2b standard. It does not apply to your own PDF."
          checked={form.document?.archival === true}
          onChange={(archival) => onChange({ document: tidyDocument({ ...form.document, archival: archival || undefined }) })}
        />
        <OwnPdfSetting form={form} onChange={(document) => onChange({ document: tidyDocument(document) })} />
        <SubmitChecks form={form} onChange={onChange} />

        <div className="fb-panel__title">Layout</div>
        <SelectSetting
          label="Show the form"
          value={form.layout?.mode ?? 'single'}
          options={[
            { label: 'All on one page', value: 'single' },
            { label: 'As steps (one per top-level section)', value: 'steps' },
          ]}
          onChange={(mode) => onChange({ layout: mode === 'single' && !form.layout?.review ? undefined : { ...form.layout, mode } })}
          hint={
            form.layout?.mode === 'steps'
              ? 'Each Section at the top level becomes a step with Next / Back. Fields between sections form their own step.'
              : undefined
          }
        />

        <SwitchSetting
          label="Review before sending"
          hint="People see all their answers, and can go back to change any, before the form is submitted."
          checked={!!form.layout?.review}
          onChange={(review) => {
            const mode = form.layout?.mode ?? 'single';
            onChange({ layout: !review && mode === 'single' ? undefined : { mode, ...(review ? { review } : {}) } });
          }}
        />

        <div className="fb-panel__title">Look and feel</div>
        <ColorSetting label="Brand colour" value={theme.primaryColor} onChange={(primaryColor) => setTheme({ primaryColor })} hint="Buttons, focus rings and progress." />
        <ColorSetting label="Background" value={theme.backgroundColor} onChange={(backgroundColor) => setTheme({ backgroundColor })} />
        <SelectSetting<FontFamily>
          label="Font"
          value={theme.fontFamily ?? 'default'}
          options={[
            { label: 'Form Builder default', value: 'default' },
            { label: 'Serif', value: 'serif' },
            { label: 'Rounded', value: 'rounded' },
            { label: 'Monospace', value: 'mono' },
          ]}
          onChange={(fontFamily) => setTheme({ fontFamily: fontFamily === 'default' ? undefined : fontFamily })}
        />
        <ColorSetting label="Colour of mistakes" value={theme.errorColor} onChange={(errorColor) => setTheme({ errorColor })} hint="The message under a question that needs fixing, and the edge of its box." />
        <SelectSetting
          label="Corners"
          value={theme.corners ?? 'default'}
          options={[
            { label: 'Form Builder default', value: 'default' },
            { label: 'Square', value: 'square' },
            { label: 'Rounded', value: 'rounded' },
            { label: 'Very round', value: 'pill' },
          ]}
          onChange={(corners) => setTheme({ corners: corners === 'default' ? undefined : (corners as 'square' | 'rounded' | 'pill') })}
        />
        <SelectSetting
          label="Room between questions"
          value={theme.spacing ?? 'default'}
          options={[
            { label: 'Form Builder default', value: 'default' },
            { label: 'Compact', value: 'compact' },
            { label: 'Comfortable', value: 'comfortable' },
            { label: 'Roomy', value: 'roomy' },
          ]}
          hint="On a phone, Roomy is shown as Comfortable."
          onChange={(spacing) => setTheme({ spacing: spacing === 'default' ? undefined : (spacing as 'compact' | 'comfortable' | 'roomy') })}
        />
        <TextSetting
          label="Logo URL"
          value={theme.logoUrl}
          placeholder="https://…/logo.png"
          onChange={(logoUrl) => setTheme({ logoUrl: logoUrl.trim() || undefined })}
          hint="https:// or a site path (/…). Shown above the title."
        />
        <SelectSetting
          label="Form style"
          value={theme.styleId ?? '__none'}
          options={[{ label: 'None', value: '__none' }, ...styles.map((s) => ({ label: s.name, value: s.id }))]}
          onChange={(v) => setTheme({ styleId: v === '__none' ? undefined : v })}
          hint="A style from Form → Styles applied to the whole form."
        />

        <div className="fb-panel__title">Buttons</div>
        <TextSetting label="Submit button text" value={submit.label} onChange={(label) => setActions({ submit: { ...submit, label } })} />
        <SwitchSetting label="Show a cancel button" checked={cancel.enabled} onChange={(enabled) => setActions({ cancel: { ...cancel, enabled } })} />
        {cancel.enabled && (
          <>
            <TextSetting label="Cancel button text" value={cancel.label} onChange={(label) => setActions({ cancel: { ...cancel, label } })} />
            <SelectSetting
              label="Cancel does"
              value={cancel.behavior}
              options={[
                { label: 'Clear the form', value: 'RESET' },
                { label: 'Go to a link', value: 'REDIRECT' },
              ]}
              onChange={(behavior) => setActions({ cancel: { ...cancel, behavior } })}
            />
            {cancel.behavior === 'REDIRECT' && (
              <TextSetting label="Cancel link" value={cancel.redirectUrl} placeholder="/ or https://…" onChange={(redirectUrl) => setActions({ cancel: { ...cancel, redirectUrl } })} />
            )}
          </>
        )}

        <div className="fb-panel__title">After submit</div>
        <SelectSetting
          label="Then"
          value={success.type}
          options={[
            { label: 'Show a thank-you message', value: 'MESSAGE' },
            { label: 'Go to a link', value: 'REDIRECT' },
          ]}
          onChange={(type) => setSubmission({ success: { ...success, type } })}
        />
        {success.type === 'MESSAGE' ? (
          <TextSetting
            label="Message"
            multiline
            value={success.message}
            placeholder="Thank you. Your response has been submitted."
            onChange={(message) => setSubmission({ success: { ...success, message: message || undefined } })}
          />
        ) : (
          <TextSetting label="Link" value={success.redirectUrl} placeholder="/thank-you" onChange={(redirectUrl) => setSubmission({ success: { ...success, redirectUrl } })} />
        )}
        <TextSetting
          label="Submission endpoint"
          value={form.submission.endpointId}
          hint="Logical id the backend maps to a handler (e.g. complaint-submit). Not a URL."
          onChange={(endpointId) => setSubmission({ endpointId })}
        />
      </fieldset>
    </div>
  );
}
