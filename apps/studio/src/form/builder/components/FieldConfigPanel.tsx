import { Tabs, TabsContent, TabsList, TabsTrigger } from '@ui/tabs';
import { MultiSelect } from '@ui/multiselect';
import type { CaptchaConfig, FieldType, FormDefinition, FormField, SystemFieldSource, UserPrefillSource, ValidationConfig } from '../../types';
import { columnWeights, isContainerField, isOptionField, isValueField, paramReferences } from '../../engine';
import { COLUMN_PRESETS, DEFAULT_CAPTCHA_CONFIG, paletteItem } from '../field-catalog';
import { useStyles } from '../../adapters/styles/style-master';
import { ConditionEditor, defaultCondition } from './ConditionEditor';
import { DataSourceEditor } from './DataSourceEditor';
import { NumberSetting, Setting, SelectSetting, SwitchSetting, TextSetting, type Choice } from './settings';
import { DEFAULT_ACCEPT, DEFAULT_MAX_SIZE_MB } from '../../runtime/fields/FileField';

const TEXT_TYPES: ReadonlySet<FieldType> = new Set(['TEXT', 'TEXTAREA', 'EMAIL', 'PHONE']);
const PLACEHOLDER_TYPES: ReadonlySet<FieldType> = new Set(['TEXT', 'TEXTAREA', 'NUMBER', 'EMAIL', 'PHONE', 'DROPDOWN', 'MULTI_SELECT', 'FILE']);
/** Types with no label/help/required of their own. */
const DECORATIVE: ReadonlySet<FieldType> = new Set(['HIDDEN', 'CAPTCHA']);

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
  if (field.type === 'CHECKBOX') {
    return <SwitchSetting label="Ticked by default" checked={value === true} onChange={(v) => onChange({ defaultValue: v || undefined })} />;
  }
  if (field.type === 'NUMBER') {
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
  const type = field.type === 'DATE' ? 'date' : field.type === 'DATETIME' ? 'datetime-local' : 'text';
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
        ]}
        onChange={(provider) => set({ provider })}
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

function GeneralTab({ field, form, onChange, onFormChange, onSetColumns }: PanelProps) {
  const hidden = field.type === 'HIDDEN';
  if (field.type === 'COLUMNS' || field.type === 'SECTION') {
    return (
      <div className="fb-settings">
        {field.type === 'COLUMNS' ? <ColumnsSettings field={field} form={form} onSetColumns={onSetColumns} /> : <SectionSettings field={field} onChange={onChange} />}
        <TextSetting label="Block key" value={field.name} onChange={(name) => onChange({ name })} hint="Used by show-when rules. Not submitted." />
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
      {!hidden && (
        <TextSetting
          label={field.type === 'BUTTON' ? 'Button text' : field.type === 'HTML' ? 'Heading' : 'Label'}
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
      {!hidden && field.type !== 'BUTTON' && field.type !== 'HTML' && (
        <TextSetting label="Help text" multiline value={field.helpText} onChange={(helpText) => onChange({ helpText: helpText || undefined })} />
      )}
      {field.type === 'TEXTAREA' && (
        <NumberSetting
          label="Visible rows"
          min={2}
          value={typeof field.props?.rows === 'number' ? field.props.rows : 4}
          onChange={(rows) => onChange({ props: { ...field.props, rows: rows ?? 4 } })}
        />
      )}

      {PREFILL_TYPES.has(field.type) && <PrefillSettings field={field} onChange={onChange} />}
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
      {field.type === 'MULTI_SELECT' && (
        <div className="fb-row">
          <NumberSetting label="Choose at least" min={0} value={v.min} onChange={(min) => set({ min })} />
          <NumberSetting label="Choose at most" min={1} value={v.max} onChange={(max) => set({ max })} />
        </div>
      )}
      {field.type === 'NUMBER' && (
        <div className="fb-row">
          <NumberSetting label="Minimum" value={v.min} onChange={(min) => set({ min })} />
          <NumberSetting label="Maximum" value={v.max} onChange={(max) => set({ max })} />
        </div>
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
  const candidates = form.fields.filter((f) => f.id !== field.id && isValueField(f) && f.type !== 'HIDDEN');
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

      {isValueField(field) && field.type !== 'HIDDEN' && field.type !== 'BUTTON' && (
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
  const hasValidation = TEXT_TYPES.has(field.type) || field.type === 'NUMBER' || field.type === 'MULTI_SELECT';
  const hasOptions = isOptionField(field);
  const hasLogic = !DECORATIVE.has(field.type);
  const hasAppearance = field.type !== 'HIDDEN';

  return (
    <div className="fb-panel" aria-label="Field settings">
      <div className="fb-panel__title">
        {paletteItem(field.type)?.label ?? field.type} {isContainerField(field) ? 'block' : 'field'}
      </div>
      <fieldset disabled={readOnly} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
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
