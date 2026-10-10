import { useEffect } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ui/tabs';
import { MultiSelect } from '@ui/multiselect';
import type { CaptchaConfig, FieldType, FormDefinition, FormField, SystemFieldSource, UserPrefillSource, ValidationConfig } from '../../types';
import { fragmentSectionOf, formShape, isRepeat, isRowField, MAX_ROWS, columnWeights, isBooleanField, isContainerField, isListField, isNumberField, isOptionField, isSectionGroup, isValueField, paramReferences, safeImageUrl } from '../../engine';
import { COLUMN_PRESETS, DEFAULT_CAPTCHA_CONFIG, paletteItem } from '../field-catalog';
import { useCustomFields } from '../../adapters/extensions';
import { useStyles } from '../../adapters/styles/style-master';
import { ConditionEditor, defaultCondition } from './ConditionEditor';
import { FragmentSettings } from './FragmentSettings';
import { useFormBuilderStore } from '../store/useFormBuilderStore';
import { DataSourceEditor } from './DataSourceEditor';
import { NumberSetting, Setting, SelectSetting, SwitchSetting, TextSetting, type Choice } from './settings';
import { DEFAULT_ACCEPT, DEFAULT_MAX_SIZE_MB } from '../../runtime/fields/FileField';

const TEXT_TYPES: ReadonlySet<FieldType> = new Set(['TEXT', 'TEXTAREA', 'EMAIL', 'PHONE']);
const PLACEHOLDER_TYPES: ReadonlySet<FieldType> = new Set(['TEXT', 'TEXTAREA', 'NUMBER', 'EMAIL', 'PHONE', 'DROPDOWN', 'MULTI_SELECT', 'FILE']);
/** Types with no label/help/required of their own. */
const DECORATIVE: ReadonlySet<FieldType> = new Set(['HIDDEN', 'CAPTCHA']);
/** Types with no help text of their own. */
const NO_HELP: ReadonlySet<FieldType> = new Set(['BUTTON', 'HTML', 'IMAGE']);

const SYSTEM_SOURCES: Choice<SystemFieldSource | 'FIXED'>[] = [
  { label: 'Business (from the form)', value: 'BUSINESS_ID' },
  { label: 'Organisation (from the form)', value: 'ORG_ID' },
  { label: 'Signed-in user id', value: 'USER_ID' },
  { label: 'Signed-in user email', value: 'USER_EMAIL' },
  { label: 'Signed-in user name', value: 'USER_NAME' },
  { label: 'Signed-in user phone', value: 'USER_PHONE' },
  { label: 'Signed-in user employee id', value: 'EMPLOYEE_ID' },
  { label: 'Form id', value: 'FORM_ID' },
  { label: 'Form version', value: 'FORM_VERSION' },
  { label: 'Channel (web, app…)', value: 'SOURCE_CHANNEL' },
  { label: 'Date and time of submission', value: 'CURRENT_DATE' },
  { label: 'URL parameter', value: 'URL_PARAMETER' },
  { label: 'Fixed value', value: 'FIXED' },
];

const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface PanelProps {
  field: FormField;
  form: FormDefinition;
  readOnly: boolean;
  onChange: (changes: Partial<FormField>) => void;
  /** Form-level edits a field owns (CAPTCHA provider settings). */
  onFormChange: (changes: Partial<FormDefinition>) => void;
  /** Change a Columns block's layout (moves fields out of removed columns). */
  onSetColumns: (weights: number[]) => void;
  /** May change the organisation's libraries (fragments). */
  canManageLibrary?: boolean;
}

function nameHint(field: FormField, form: FormDefinition) {
  if (!FIELD_NAME.test(field.name)) return 'Use letters, digits and _ only, not starting with a digit.';
  if (form.fields.some((f) => f.id !== field.id && f.name === field.name)) return 'Another field already uses this key.';
  return 'Key in the submitted data. Rules that use this field update automatically when you rename it.';
}

const PREFILL_TYPES: ReadonlySet<FieldType> = new Set(['TEXT', 'EMAIL', 'PHONE']);

const PREFILL_SOURCES: Choice<UserPrefillSource | 'NONE'>[] = [
  { label: "Don't pre-fill", value: 'NONE' },
  { label: 'Name', value: 'USER_NAME' },
  { label: 'Email', value: 'USER_EMAIL' },
  { label: 'Phone', value: 'USER_PHONE' },
  { label: 'Employee ID', value: 'EMPLOYEE_ID' },
  { label: 'User ID', value: 'USER_ID' },
];

/** Email and phone fields: ask the person to prove the address or number is theirs, with a code sent to it. */
function CodeSettings({ field, onChange }: Pick<PanelProps, 'field' | 'onChange'>) {
  const on = field.props?.verify === true;
  return (
    <div className="fb-section fb-settings">
      <SwitchSetting
        label="Confirm with a code"
        checked={on}
        onChange={(verify) => {
          const { verify: _was, ...rest } = field.props ?? {};
          const props = verify ? { ...rest, verify: true } : rest;
          onChange({ props: Object.keys(props).length ? props : undefined });
        }}
        hint={
          field.type === 'EMAIL'
            ? 'The person is sent a 6-digit code by email and types it in. The form cannot be sent until they have.'
            : 'The person is sent a 6-digit code by text message and types it in. Needs your SMS service (Organisation settings → Text messages).'
        }
      />
    </div>
  );
}

/** Pre-fill a visible field from the signed-in user; anonymous visitors type it. */
function PrefillSettings({ field, onChange }: Pick<PanelProps, 'field' | 'onChange'>) {
  return (
    <div className="fb-section fb-settings">
      <SelectSetting
        label="Fill from signed-in user"
        value={field.prefill?.source ?? 'NONE'}
        options={PREFILL_SOURCES}
        onChange={(source) => onChange({ prefill: source === 'NONE' ? undefined : { source, lock: field.prefill?.lock } })}
        hint="Signed-in people see it filled in. Visitors who aren't signed in type it themselves."
      />
      {field.prefill && (
        <SwitchSetting
          label="Lock when filled"
          checked={!!field.prefill.lock}
          onChange={(lock) => onChange({ prefill: { ...field.prefill!, lock } })}
          hint="Read-only for signed-in people, and the server uses the real value - it can't be changed or faked."
        />
      )}
    </div>
  );
}

function DefaultValueSetting({ field, onChange }: Pick<PanelProps, 'field' | 'onChange'>) {
  const value = field.defaultValue;
  if (field.type === 'SIGNATURE' || isListField(field)) return null;
  if (isBooleanField(field)) {
    return <SwitchSetting label={field.type === 'SWITCH' ? 'On by default' : 'Ticked by default'} checked={value === true} onChange={(v) => onChange({ defaultValue: v || undefined })} />;
  }
  if (isNumberField(field)) {
    return <NumberSetting label="Default value" value={typeof value === 'number' ? value : undefined} onChange={(v) => onChange({ defaultValue: v })} />;
  }
  if (isOptionField(field)) {
    const options = field.dataSource?.options ?? [];
    return (
      <SelectSetting
        label="Pre-selected option"
        value={typeof value === 'string' && value ? value : '__none'}
        options={[{ label: 'None', value: '__none' }, ...options.map((o) => ({ label: o.label, value: o.value }))]}
        onChange={(v) => onChange({ defaultValue: v === '__none' ? undefined : v })}
      />
    );
  }
  const type = field.type === 'DATE' ? 'date' : field.type === 'DATETIME' ? 'datetime-local' : field.type === 'TIME' ? 'time' : field.type === 'MONTH' ? 'month' : field.type === 'COLOR' ? 'color' : 'text';
  return (
    <TextSetting
      label="Default value"
      type={type}
      value={typeof value === 'string' ? value : ''}
      onChange={(v) => onChange({ defaultValue: v || undefined })}
    />
  );
}

function FileSettings({ field, onChange }: Pick<PanelProps, 'field' | 'onChange'>) {
  const accept = Array.isArray(field.props?.accept) ? (field.props.accept as string[]) : DEFAULT_ACCEPT;
  const maxSizeMB = typeof field.props?.maxSizeMB === 'number' ? field.props.maxSizeMB : DEFAULT_MAX_SIZE_MB;
  return (
    <>
      <TextSetting
        label="Accepted file types"
        value={accept.join(', ')}
        hint="Comma-separated, e.g. image/*, application/pdf, .docx"
        onChange={(v) => onChange({ props: { ...field.props, accept: v.split(',').map((x) => x.trim()).filter(Boolean) } })}
      />
      <div className="fb-row">
        <NumberSetting label="Max size (MB)" min={1} value={maxSizeMB} onChange={(n) => onChange({ props: { ...field.props, maxSizeMB: n ?? DEFAULT_MAX_SIZE_MB } })} />
        <NumberSetting
          label="Max files"
          min={1}
          value={field.validation?.max ?? 1}
          onChange={(n) => onChange({ validation: { ...field.validation, max: n ?? 1 } })}
        />
      </div>
    </>
  );
}

function CaptchaSettings({ form, onFormChange }: Pick<PanelProps, 'form' | 'onFormChange'>) {
  const config: CaptchaConfig = form.captcha ?? { ...DEFAULT_CAPTCHA_CONFIG };
  const set = (changes: Partial<CaptchaConfig>) => onFormChange({ captcha: { ...config, ...changes, enabled: true } });
  return (
    <>
      <SelectSetting
        label="Provider"
        value={config.provider}
        options={[
          { label: 'Google reCAPTCHA', value: 'RECAPTCHA' },
          { label: 'Cloudflare Turnstile', value: 'TURNSTILE' },
          { label: 'hCaptcha', value: 'HCAPTCHA' },
        ]}
        // Only reCAPTCHA has the score-based style: another provider falls back to the tick box.
        onChange={(provider) => set({ provider, ...(provider !== 'RECAPTCHA' && config.mode === 'V3' ? { mode: 'CHECKBOX' } : {}) })}
      />
      <SelectSetting
        label="Style"
        value={config.mode}
        options={[
          { label: 'Checkbox ("I\'m not a robot")', value: 'CHECKBOX' },
          { label: 'Invisible (checks on submit)', value: 'INVISIBLE' },
          ...(config.provider === 'RECAPTCHA' ? [{ label: 'Score-based (reCAPTCHA v3)', value: 'V3' as const }] : []),
        ]}
        onChange={(mode) => set({ mode })}
      />
      <TextSetting
        label="Site key"
        value={config.siteKey}
        placeholder="Public site key from the provider"
        onChange={(siteKey) => set({ siteKey: siteKey.trim() })}
        hint="Only the public site key goes here - the secret key stays on the server. Leave empty to use a test check in previews."
      />
    </>
  );
}

function ColumnsSettings({ field, form, onSetColumns }: Pick<PanelProps, 'field' | 'form' | 'onSetColumns'>) {
  const current = columnWeights(field).join('-');
  const inside = form.fields.filter((f) => f.parentId === field.id).length;
  return (
    <SelectSetting
      label="Columns"
      value={COLUMN_PRESETS.some((p) => p.value === current) ? current : undefined}
      options={COLUMN_PRESETS.map((p) => ({ label: p.label, value: p.value }))}
      onChange={(v) => onSetColumns(COLUMN_PRESETS.find((p) => p.value === v)!.weights)}
      hint={`Drag fields into each column on the canvas. On phones the columns stack.${inside ? ` ${inside} field${inside === 1 ? '' : 's'} inside.` : ''}`}
    />
  );
}

function SectionSettings({ field, onChange }: Pick<PanelProps, 'field' | 'onChange'>) {
  const props = field.props ?? {};
  return (
    <>
      <TextSetting label="Title" value={field.label} onChange={(label) => onChange({ label })} />
      <TextSetting
        label="Description"
        multiline
        value={typeof props.description === 'string' ? props.description : ''}
        onChange={(description) => onChange({ props: { ...props, description } })}
      />
      <SwitchSetting
        label="Can be collapsed"
        checked={props.collapsible === true}
        onChange={(collapsible) => onChange({ props: { ...props, collapsible, collapsed: collapsible ? props.collapsed : false } })}
        hint="In a multi-step form, each top-level section is a step instead."
      />
      {props.collapsible === true && (
        <SwitchSetting label="Start collapsed" checked={props.collapsed === true} onChange={(collapsed) => onChange({ props: { ...props, collapsed } })} />
      )}
    </>
  );
}

/** A repeating section: its title, how many rows, how rows are laid out and which numbers are totalled. */
/** Which of the fields the organisation's extension draws this one is. With only one on offer it is chosen already. */
function CustomFieldSetting({ field, onChange }: Pick<PanelProps, 'field' | 'onChange'>) {
  const { data: offered = [], isSuccess } = useCustomFields();
  const chosen = typeof field.props?.custom === 'string' ? field.props.custom : '';
  const choose = (key: string) => {
    const offer = offered.find((o) => o.key === key);
    onChange({ props: { ...field.props, custom: key, ...(offer ? { height: offer.height } : {}) } });
  };
  useEffect(() => {
    if (!chosen && offered.length === 1) choose(offered[0].key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen, offered]);
  const gone = isSuccess && !!chosen && !offered.some((o) => o.key === chosen);
  return (
    <SelectSetting
      label="Which field"
      value={chosen || undefined}
      options={[...offered.map((o) => ({ label: o.label, value: o.key })), ...(gone ? [{ label: 'No longer offered', value: chosen }] : [])]}
      placeholder={offered.length ? 'Choose a field' : 'Your extension offers no fields'}
      onChange={choose}
      hint={gone ? 'Your extension no longer offers this field. Choose another, or remove it.' : (offered.find((o) => o.key === chosen)?.description ?? 'Drawn by your own code. Its answer is stored as text.')}
    />
  );
}

/** Kinds of question with nothing to seal: files are kept in file storage, and a hidden or CAPTCHA value is not an answer. */
const SENSITIVE_NOT_FOR = new Set(['FILE', 'HIDDEN', 'CAPTCHA', 'SIGNATURE', 'REPEAT']);

const ADD_BY_HAND = '__by_hand__';

function RepeatSettings({ field, form, onChange }: Pick<PanelProps, 'field' | 'form' | 'onChange'>) {
  const props = field.props ?? {};
  const v = field.validation ?? {};
  const numbers = (formShape(form.fields).repeats.find((r) => r.field.id === field.id)?.valueChildren ?? []).filter(isNumberField);
  const totals = new Set(Array.isArray(props.totals) ? (props.totals as string[]) : []);
  // Number questions outside any repeating section: the ones a row count can follow.
  const inRepeat = formShape(form.fields).repeatOf;
  const rowCounters = form.fields.filter((f) => isNumberField(f) && !inRepeat.has(f.name));
  const limits = (changes: Partial<ValidationConfig>) => {
    const next = { ...v, ...changes };
    onChange({ validation: next.min === undefined && next.max === undefined && !next.messages ? undefined : next });
  };
  return (
    <>
      <TextSetting label="Title" value={field.label} onChange={(label) => onChange({ label })} />
      <TextSetting label="Help text" multiline value={field.helpText} onChange={(helpText) => onChange({ helpText: helpText || undefined })} />
      <TextSetting label="Add button text" value={typeof props.addLabel === 'string' ? props.addLabel : ''} placeholder="Add another" onChange={(addLabel) => onChange({ props: { ...props, addLabel } })} />
      <div className="fb-row">
        <NumberSetting label="Rows at least" min={0} value={v.min} onChange={(min) => limits({ min })} />
        <NumberSetting label="Rows at most" min={1} value={v.max} onChange={(max) => limits({ max: max === undefined ? undefined : Math.min(max, MAX_ROWS) })} />
      </div>
      <SelectSetting
        label="How many rows"
        value={typeof props.rowsFrom === 'string' && rowCounters.some((f) => f.name === props.rowsFrom) ? (props.rowsFrom as string) : ADD_BY_HAND}
        options={[{ label: 'People add and remove rows', value: ADD_BY_HAND }, ...rowCounters.map((f) => ({ label: `As many as the answer to "${f.label || f.name}"`, value: f.name }))]}
        hint={props.rowsFrom ? 'The rows appear as the number is answered, within the limits above. People fill them in; they do not add or remove them.' : rowCounters.length ? undefined : 'To have the rows follow an answer, add a number question outside this section first.'}
        onChange={(from) => onChange({ props: { ...props, rowsFrom: from === ADD_BY_HAND ? undefined : from } })}
      />
      <SelectSetting
        label="Rows look like"
        value={props.layout === 'table' ? 'table' : 'cards'}
        options={[
          { label: 'Cards, one under another', value: 'cards' },
          { label: 'A table, one line per row', value: 'table' },
        ]}
        hint="A table suits a few short fields. Phones always show cards."
        onChange={(layout) => onChange({ props: { ...props, layout } })}
      />
      {numbers.length > 0 && (
        <Setting label="Show a total of" hint="Shown under the rows. To save a total with the answers, add a rule: sum(field).">
          {() => (
            <div className="fb-settings" style={{ gap: 6 }}>
              {numbers.map((n) => (
                <SwitchSetting
                  key={n.id}
                  label={n.label || n.name}
                  checked={totals.has(n.name)}
                  onChange={(on) => {
                    const next = new Set(totals);
                    if (on) next.add(n.name);
                    else next.delete(n.name);
                    onChange({ props: { ...props, totals: numbers.map((x) => x.name).filter((name) => next.has(name)) } });
                  }}
                />
              ))}
            </div>
          )}
        </Setting>
      )}
      <p className="fb-muted">People add a copy of the fields inside for every row. Uploads, signatures and other sections cannot go inside.</p>
    </>
  );
}

function GeneralTab({ field, form, onChange, onFormChange, onSetColumns, canManageLibrary }: PanelProps) {
  const hidden = field.type === 'HIDDEN';
  if (isContainerField(field)) {
    return (
      <div className="fb-settings">
        {field.type === 'COLUMNS' && <ColumnsSettings field={field} form={form} onSetColumns={onSetColumns} />}
        {field.type === 'SECTION' && <SectionSettings field={field} onChange={onChange} />}
        {field.type === 'SECTION' && <FragmentSettings field={field} form={form} canManageLibrary={!!canManageLibrary} onFormChange={onFormChange} />}
        {field.type === 'REPEAT' && <RepeatSettings field={field} form={form} onChange={onChange} />}
        {isSectionGroup(field) && (
          <>
            <TextSetting label="Name" value={field.label} hint="Read out by screen readers; not shown." onChange={(label) => onChange({ label: label || undefined })} />
            {field.type === 'TABS' && (
              <SelectSetting
                label="Tabs run"
                value={field.props?.orientation === 'vertical' ? 'vertical' : 'horizontal'}
                options={[
                  { label: 'Across the top', value: 'horizontal' },
                  { label: 'Down the side', value: 'vertical' },
                ]}
                onChange={(orientation) => onChange({ props: { ...field.props, orientation } })}
              />
            )}
            <p className="fb-muted">Each Section inside is one {field.type === 'TABS' ? 'tab' : 'panel'}: its title is the {field.type === 'TABS' ? 'tab' : 'panel'} name. Drop another Section in to add one.</p>
          </>
        )}
        <TextSetting
          label="Block key"
          value={field.name}
          onChange={(name) => onChange({ name })}
          hint={field.type === 'REPEAT' ? 'Key in the submitted data: a list with one entry per row.' : 'Used by show-when rules. Not submitted.'}
        />
      </div>
    );
  }
  if (field.type === 'CAPTCHA') {
    return (
      <div className="fb-settings">
        <p className="fb-muted">
          Stops automated spam. The token is sent as <span className="fb-code">{field.name}</span> and verified by the server.
        </p>
        <CaptchaSettings form={form} onFormChange={onFormChange} />
      </div>
    );
  }
  const source: SystemFieldSource | 'FIXED' = field.systemSource ?? 'FIXED';
  return (
    <div className="fb-settings">
      {field.type === 'CUSTOM' && <CustomFieldSetting field={field} onChange={onChange} />}
      {!hidden && (
        <TextSetting
          label={field.type === 'BUTTON' ? 'Button text' : field.type === 'HTML' ? 'Heading' : field.type === 'IMAGE' ? 'Caption' : field.type === 'CONSENT' ? 'Tick-box text' : 'Label'}
          value={field.label}
          onChange={(label) => onChange({ label })}
        />
      )}
      {field.type === 'HTML' && (
        <TextSetting
          label="Text"
          multiline
          value={typeof field.props?.content === 'string' ? field.props.content : ''}
          hint="Plain text shown between fields. Line breaks are kept."
          onChange={(content) => onChange({ props: { ...field.props, content } })}
        />
      )}
      {field.type === 'CONSENT' && (
        <TextSetting
          label="Terms"
          multiline
          value={typeof field.props?.text === 'string' ? field.props.text : ''}
          hint="What people are accepting. Plain text; line breaks are kept."
          onChange={(text) => onChange({ props: { ...field.props, text } })}
        />
      )}
      {field.type === 'IMAGE' && (
        <>
          <TextSetting
            label="Picture address"
            value={typeof field.props?.src === 'string' ? field.props.src : ''}
            placeholder="https://… or /images/…"
            hint={field.props?.src && !safeImageUrl(field.props.src) ? 'Must start with https:// or be a path on this site (/…).' : undefined}
            onChange={(src) => onChange({ props: { ...field.props, src } })}
          />
          <TextSetting
            label="Description"
            value={typeof field.props?.alt === 'string' ? field.props.alt : ''}
            hint="Read out to people who cannot see the picture."
            onChange={(alt) => onChange({ props: { ...field.props, alt } })}
          />
          <NumberSetting
            label="Widest it may be (pixels)"
            min={16}
            value={typeof field.props?.maxWidth === 'number' ? field.props.maxWidth : undefined}
            onChange={(maxWidth) => onChange({ props: { ...field.props, maxWidth } })}
          />
        </>
      )}
      {field.type === 'FILE' && <FileSettings field={field} onChange={onChange} />}
      <TextSetting label="Field key" value={field.name} onChange={(name) => onChange({ name })} hint={nameHint(field, form)} />

      {hidden && (
        <>
          <SelectSetting
            label="Value comes from"
            value={source}
            options={SYSTEM_SOURCES}
            onChange={(v) => onChange(v === 'FIXED' ? { systemSource: undefined } : { systemSource: v })}
            hint="Sent with every submission. The server re-checks these values - never rely on them for security."
          />
          {source === 'URL_PARAMETER' && (
            <TextSetting
              label="Parameter name"
              value={field.systemParam}
              placeholder="e.g. source"
              onChange={(systemParam) => onChange({ systemParam })}
              hint={`Reads ?${field.systemParam || 'name'}=… from the form's link.`}
            />
          )}
          {source === 'FIXED' && (
            <TextSetting label="Value" value={typeof field.defaultValue === 'string' ? field.defaultValue : ''} onChange={(v) => onChange({ defaultValue: v })} />
          )}
        </>
      )}

      {field.type === 'BUTTON' && (
        <TextSetting
          label="Link"
          value={typeof field.props?.href === 'string' ? field.props.href : ''}
          placeholder="https://…"
          onChange={(href) => onChange({ props: { ...field.props, href } })}
        />
      )}

      {PLACEHOLDER_TYPES.has(field.type) && (
        <TextSetting label="Placeholder" value={field.placeholder} onChange={(placeholder) => onChange({ placeholder: placeholder || undefined })} />
      )}
      {!hidden && !NO_HELP.has(field.type) && (
        <TextSetting label="Help text" multiline value={field.helpText} onChange={(helpText) => onChange({ helpText: helpText || undefined })} />
      )}
      {field.type === 'TEXT' && (
        <SelectSetting
          label="Letters"
          value={typeof field.props?.letters === 'string' ? (field.props.letters as string) : 'typed'}
          options={[
            { label: 'As typed', value: 'typed' },
            { label: 'CAPITALS', value: 'upper' },
            { label: 'small letters', value: 'lower' },
            { label: 'First Letter Of Each Word', value: 'title' },
          ]}
          hint="Put right as the person leaves the box, and kept that way. CAPITALS suits an ID or vehicle number; the last suits a name."
          onChange={(letters) => {
            const { letters: _was, ...rest } = field.props ?? {};
            onChange({ props: letters === 'typed' ? (Object.keys(rest).length ? rest : undefined) : { ...rest, letters } });
          }}
        />
      )}
      {field.type === 'TEXT' && (
        <>
          <SelectSetting
            label="Spacing"
            value={typeof field.props?.spacing !== 'string' ? 'none' : ['fours', 'threes', 'phone'].includes(field.props.spacing) ? (field.props.spacing as string) : 'own'}
            options={[
              { label: 'As typed', value: 'none' },
              { label: 'In fours: 1234 5678 9012', value: 'fours' },
              { label: 'In threes: 123 456 789', value: 'threes' },
              { label: 'Like a phone number: 98765 43210', value: 'phone' },
              { label: 'A shape of our own', value: 'own' },
            ]}
            hint="However it is typed, the answer is set out this way as the person leaves the box, and kept that way."
            onChange={(spacing) => {
              const { spacing: _was, ...rest } = field.props ?? {};
              onChange({ props: spacing === 'none' ? (Object.keys(rest).length ? rest : undefined) : { ...rest, spacing: spacing === 'own' ? '##-####' : spacing } });
            }}
          />
          {typeof field.props?.spacing === 'string' && !['fours', 'threes', 'phone'].includes(field.props.spacing) && (
            <TextSetting
              label="The shape"
              value={field.props.spacing as string}
              hint="Put # for each letter or digit, and whatever goes between them as itself: ##-#### gives AB-1234."
              onChange={(shape) => onChange({ props: { ...field.props, spacing: shape.slice(0, 60) } })}
            />
          )}
        </>
      )}
      {isValueField(field) && !SENSITIVE_NOT_FOR.has(field.type) && (
        <SwitchSetting
          label="Sensitive"
          hint="For an ID number, a bank account and the like. The answer is stored encrypted and is left out of the inbox summary. It cannot be searched or filtered on. People who may open the record or export responses still see it."
          checked={!!field.sensitive}
          onChange={(on) => onChange({ sensitive: on || undefined })}
        />
      )}
      {field.type === 'TEXTAREA' && (
        <NumberSetting
          label="Visible rows"
          min={2}
          value={typeof field.props?.rows === 'number' ? field.props.rows : 4}
          onChange={(rows) => onChange({ props: { ...field.props, rows: rows ?? 4 } })}
        />
      )}

      {PREFILL_TYPES.has(field.type) && !isRowField(form.fields, field) && <PrefillSettings field={field} onChange={onChange} />}
      {(field.type === 'EMAIL' || field.type === 'PHONE') && !isRowField(form.fields, field) && <CodeSettings field={field} onChange={onChange} />}
      {isValueField(field) && !hidden && (
        <>
          <SwitchSetting label="Required" checked={!!field.required} onChange={(required) => onChange({ required: required || undefined })} />
          <DefaultValueSetting field={field} onChange={onChange} />
        </>
      )}
      {isValueField(field) && !hidden && <SwitchSetting label="Read-only" checked={!!field.disabled} onChange={(disabled) => onChange({ disabled: disabled || undefined })} />}
    </div>
  );
}

function ValidationTab({ field, onChange }: PanelProps) {
  const v = field.validation ?? {};
  const set = (changes: Partial<ValidationConfig>) => {
    const next: ValidationConfig = { ...v, ...changes };
    const empty = Object.values(next).every((x) => x === undefined || x === '');
    onChange({ validation: empty ? undefined : next });
  };
  const setMessage = (key: keyof NonNullable<ValidationConfig['messages']>, text: string) =>
    set({ messages: { ...v.messages, [key]: text || undefined } });

  return (
    <div className="fb-settings">
      {TEXT_TYPES.has(field.type) && (
        <>
          {field.type !== 'EMAIL' && (
            <div className="fb-row">
              <NumberSetting label="Min characters" min={0} value={v.minLength} onChange={(minLength) => set({ minLength })} />
              <NumberSetting label="Max characters" min={1} value={v.maxLength} onChange={(maxLength) => set({ maxLength })} />
            </div>
          )}
          {field.type === 'EMAIL' && <NumberSetting label="Max characters" min={1} value={v.maxLength} onChange={(maxLength) => set({ maxLength })} />}
          {field.type !== 'EMAIL' && (
            <>
              <TextSetting
                label="Pattern (regular expression)"
                value={v.pattern}
                placeholder={field.type === 'PHONE' ? 'Default: international phone number' : 'e.g. ^[A-Z]{3}[0-9]{4}$'}
                onChange={(pattern) => set({ pattern: pattern || undefined })}
              />
              {v.pattern && <TextSetting label="Message when the pattern doesn't match" value={v.messages?.pattern} onChange={(t) => setMessage('pattern', t)} />}
            </>
          )}
        </>
      )}
      {isListField(field) && (
        <div className="fb-row">
          <NumberSetting label="Choose at least" min={0} value={v.min} onChange={(min) => set({ min })} />
          <NumberSetting label="Choose at most" min={1} value={v.max} onChange={(max) => set({ max })} />
        </div>
      )}
      {isNumberField(field) && (
        <div className="fb-row">
          <NumberSetting label="Minimum" value={v.min} onChange={(min) => set({ min })} />
          <NumberSetting label="Maximum" value={v.max} onChange={(max) => set({ max })} />
        </div>
      )}
      {field.type === 'SLIDER' && (
        <NumberSetting
          label="One notch is"
          min={0}
          value={typeof field.props?.step === 'number' ? field.props.step : 1}
          onChange={(step) => onChange({ props: { ...field.props, step: step && step > 0 ? step : 1 } })}
        />
      )}
      {field.type === 'STEPPER' && (
        <NumberSetting
          label="One press changes it by"
          min={0}
          value={typeof field.props?.step === 'number' ? field.props.step : 1}
          onChange={(step) => onChange({ props: { ...field.props, step: step && step > 0 ? step : 1 } })}
        />
      )}
      <TextSetting
        label="Message when left empty"
        value={v.messages?.required}
        placeholder={`${field.label || field.name} is required`}
        onChange={(t) => setMessage('required', t)}
      />
    </div>
  );
}

function LogicTab({ field, form, onChange }: PanelProps) {
  // A rule tests one answer: not a whole repeating section, and a field in a row only from inside that same section.
  const shape = formShape(form.fields);
  const home = shape.repeatOf.get(field.name);
  const candidates = form.fields.filter(
    (f) => f.id !== field.id && isValueField(f) && f.type !== 'HIDDEN' && !isRepeat(f) && (!isRowField(form.fields, f) || shape.repeatOf.get(f.name) === home),
  );
  return (
    <div className="fb-settings">
      <SwitchSetting
        label="Show only when…"
        hint="Hidden fields are skipped by validation and left out of the submission."
        checked={!!field.visibility}
        onChange={(on) => onChange({ visibility: on ? { when: defaultCondition(candidates[0]) } : undefined })}
      />
      {field.visibility && (
        <ConditionEditor condition={field.visibility.when} candidates={candidates} onChange={(when) => onChange({ visibility: { when } })} />
      )}

      {isValueField(field) && field.type !== 'HIDDEN' && field.type !== 'BUTTON' && (
        <div className="fb-section fb-settings">
          <SwitchSetting
            label="Required only when…"
            hint={field.required ? 'Turn off "Required" on the General tab to make this conditional.' : undefined}
            disabled={!!field.required}
            checked={!!field.requiredWhen}
            onChange={(on) => onChange({ requiredWhen: on ? defaultCondition(candidates[0]) : undefined })}
          />
          {field.requiredWhen && !field.required && (
            <ConditionEditor condition={field.requiredWhen} candidates={candidates} onChange={(requiredWhen) => onChange({ requiredWhen })} />
          )}
        </div>
      )}

      {isValueField(field) && field.type !== 'HIDDEN' && field.type !== 'BUTTON' && !isRepeat(field) && !home && (
        <DependencySettings field={field} candidates={candidates} onChange={onChange} />
      )}
    </div>
  );
}

/** "Clear this field when X changes" - explicit parents plus any the API params imply. */
function DependencySettings({ field, candidates, onChange }: { field: FormField; candidates: FormField[]; onChange: PanelProps['onChange'] }) {
  const fromParams = paramReferences(field.dataSource?.api?.params).fields;
  const explicit = field.dependency?.dependsOn ?? [];
  const resetOnChange = field.dependency?.resetOnChange !== false;
  const setDependency = (dependsOn: string[], reset = resetOnChange) =>
    onChange({ dependency: dependsOn.length || !reset ? { dependsOn, resetOnChange: reset } : undefined });

  return (
    <div className="fb-section fb-settings">
      <Setting
        label="Clear this field when these change"
        hint={
          fromParams.length
            ? `Its options also reload from ${fromParams.join(', ')} (set in the API parameters).`
            : 'e.g. clear Section when Business changes, so a stale choice is never submitted.'
        }
      >
        {() => (
          <MultiSelect
            options={candidates.map((f) => ({ value: f.name, label: f.label || f.name }))}
            value={explicit}
            onChange={(next) => setDependency(next)}
            placeholder="Choose fields"
          />
        )}
      </Setting>
      {(explicit.length > 0 || fromParams.length > 0) && (
        <SwitchSetting
          label="Clear the value when they change"
          checked={resetOnChange}
          onChange={(reset) => setDependency(explicit, reset)}
        />
      )}
    </div>
  );
}

const WIDTHS: Choice<'full' | 'half' | 'third' | 'two-thirds'>[] = [
  { label: 'Full width', value: 'full' },
  { label: 'Half', value: 'half' },
  { label: 'One third', value: 'third' },
  { label: 'Two thirds', value: 'two-thirds' },
];

function AppearanceTab({ field, onChange }: Pick<PanelProps, 'field' | 'onChange'>) {
  const { data: styles = [] } = useStyles();
  const missing = field.styleId && !styles.some((s) => s.id === field.styleId);
  return (
    <div className="fb-settings">
      <SelectSetting
        label="Width"
        value={field.width ?? 'full'}
        options={WIDTHS}
        onChange={(width) => onChange({ width: width === 'full' ? undefined : width })}
        hint="Fields next to each other share a row when their widths fit. Phones always show full width."
      />
      <SelectSetting
        label="Style"
        value={field.styleId ?? '__none'}
        options={[{ label: 'None', value: '__none' }, ...styles.map((s) => ({ label: s.name, value: s.id }))]}
        onChange={(v) => onChange({ styleId: v === '__none' ? undefined : v })}
        hint={missing ? `"${field.styleId}" is no longer in the style master.` : 'Styles are managed in Form → Styles.'}
      />
    </div>
  );
}

/** Settings for the selected field, grouped into tabs that only appear when relevant. */
export function FieldConfigPanel(props: PanelProps) {
  const { field, readOnly, onChange } = props;
  // A field inside a fragment section is the library's copy: shown, not changed here.
  const owner = fragmentSectionOf(props.form.fields, field.id);
  const unlocked = useFormBuilderStore((s) => s.unlockedFragment);
  const copy = !!owner && owner.id !== unlocked;
  const hasValidation = TEXT_TYPES.has(field.type) || isNumberField(field) || isListField(field) || isBooleanField(field) || field.type === 'SIGNATURE';
  const hasOptions = isOptionField(field);
  const hasLogic = !DECORATIVE.has(field.type);
  const hasAppearance = field.type !== 'HIDDEN';

  return (
    <div className="fb-panel" aria-label="Field settings">
      <div className="fb-panel__title">
        {paletteItem(field.type)?.label ?? field.type} {isContainerField(field) ? 'block' : 'field'}
      </div>
      {copy && (
        <div className="fb-banner" style={{ marginBottom: 10 }}>
          Part of the fragment section <strong>{owner.label || owner.name}</strong>. Its fields are changed in the library: select that section.
        </div>
      )}
      <fieldset disabled={readOnly || copy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <Tabs key={field.id} defaultValue="general">
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            {hasOptions && <TabsTrigger value="options">Options</TabsTrigger>}
            {hasValidation && <TabsTrigger value="validation">Validation</TabsTrigger>}
            {hasLogic && <TabsTrigger value="logic">Logic</TabsTrigger>}
            {hasAppearance && <TabsTrigger value="appearance">Look</TabsTrigger>}
          </TabsList>
          <TabsContent value="general" style={{ paddingTop: 12 }}>
            <GeneralTab {...props} />
          </TabsContent>
          {hasOptions && (
            <TabsContent value="options" style={{ paddingTop: 12 }}>
              <DataSourceEditor
                field={field}
                others={props.form.fields.filter((f) => f.id !== field.id)}
                onChange={(dataSource) => onChange({ dataSource })}
              />
            </TabsContent>
          )}
          {hasValidation && (
            <TabsContent value="validation" style={{ paddingTop: 12 }}>
              <ValidationTab {...props} />
            </TabsContent>
          )}
          {hasLogic && (
            <TabsContent value="logic" style={{ paddingTop: 12 }}>
              <LogicTab {...props} />
            </TabsContent>
          )}
          {hasAppearance && (
            <TabsContent value="appearance" style={{ paddingTop: 12 }}>
              <AppearanceTab field={field} onChange={onChange} />
            </TabsContent>
          )}
        </Tabs>
      </fieldset>
    </div>
  );
}
