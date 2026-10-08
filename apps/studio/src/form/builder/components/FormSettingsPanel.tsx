import { isTimeZone } from '../../engine';
import type { FontFamily, FormActionConfig, FormDefinition, FormTheme, SubmissionConfig } from '../../types';
import { useStyles } from '../../adapters/styles/style-master';
import { ColorSetting, SelectSetting, SwitchSetting, TextSetting } from './settings';

interface FormSettingsPanelProps {
  form: FormDefinition;
  readOnly: boolean;
  /** The code is the form's identity across versions - only a never-published v1 may change it. */
  codeLocked: boolean;
  onChange: (changes: Partial<FormDefinition>) => void;
}

/** Shown when no field is selected: everything about the form as a whole. */
export function FormSettingsPanel({ form, readOnly, codeLocked, onChange }: FormSettingsPanelProps) {
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

        <div className="fb-panel__title">Layout</div>
        <SelectSetting
          label="Show the form"
          value={form.layout?.mode ?? 'single'}
          options={[
            { label: 'All on one page', value: 'single' },
            { label: 'As steps (one per top-level section)', value: 'steps' },
          ]}
          onChange={(mode) => onChange({ layout: mode === 'single' ? undefined : { mode } })}
          hint={
            form.layout?.mode === 'steps'
              ? 'Each Section at the top level becomes a step with Next / Back. Fields between sections form their own step.'
              : undefined
          }
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
