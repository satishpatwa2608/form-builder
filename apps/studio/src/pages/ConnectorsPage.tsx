import { useMemo, useState } from 'react';
import type { SourceField } from '@fb/engine';
import { CheckCircle2, Database, KeyRound, Network, Plug, Plus, RefreshCw, ScanSearch, Trash2, X, XCircle } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { API_URL, api, errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Alert, Badge, Button, Card, PageHead, SelectField, TextField, useSubmit } from '../components/ui';

type ConnectorType = 'mongodb' | 'postgres' | 'mysql' | 'mssql' | 'oracle' | 'db2' | 'supabase' | 'rest' | 'soap' | 'odata' | 'salesforce' | 'google-sheets' | 'excel' | 'microsoft-files' | 'azure-blob' | 'aws-s3' | 'aws-cloudwatch';
type Op = 'list' | 'get' | 'lookup' | 'insert' | 'update' | 'upload' | 'log';

interface ExposedEntity {
  key: string;
  label: string;
  fields: string[];
  keyField: string;
  operations: Op[];
  valueField: string;
  labelField: string;
  about?: SourceField[];
  /** Rows of other tables that belong to a row of this one, brought along with a look-up. */
  related?: { name: string; source: string; field: string; equals: string }[];
}
interface ConnectorView {
  id: string;
  ref: string;
  type: ConnectorType;
  name: string;
  settings: Record<string, string | number | boolean>;
  credentialsSet: boolean;
  writable: boolean;
  allowedHosts: string[];
  entities: ExposedEntity[];
  lastTest: { at: string; ok: boolean; message: string; latencyMs: number } | null;
  permissions: { use: boolean; manage: boolean };
  gatewayId?: string;
  gatewayConnected?: boolean;
}
interface GatewayView {
  id: string;
  name: string;
  registered: boolean;
  connected: boolean;
  lastSeenAt?: string;
  version?: string;
}
interface Discovered {
  key: string;
  label: string;
  fields: (SourceField & { type: string })[];
  /** The field that identifies a row, when the system itself says which it is. */
  keyField?: string;
}
interface Call {
  entity: string;
  kind: string;
  actor: string;
  ok: boolean;
  durationMs: number;
  rows: number;
  error: string;
  at: string;
}

/** What each type asks for. `secret` fields are sent once and never shown again. */
interface FieldSpec {
  name: string;
  label: string;
  secret?: boolean;
  hint?: string;
  kind?: 'text' | 'number' | 'bool' | 'select' | 'textarea' | 'password';
  options?: string[];
  /** What a person reads for each option, when the stored word is not plain enough. */
  optionLabels?: Record<string, string>;
  optional?: boolean;
  /** Asked for only with these ways of signing in (the `auth` choice). */
  showFor?: string[];
}

/** The boxes to show: a way of signing in brings its own, and hides the others'. */
export const fieldsFor = (fields: FieldSpec[], values: Record<string, string | boolean>) => fields.filter((f) => !f.showFor || f.showFor.includes(String(values.auth ?? 'none')));
const AUTH_LABELS = { none: 'None', bearer: 'A token (Bearer)', apiKey: 'An API key in a header', basic: 'User name and password', oauth: 'As an application (OAuth client credentials)', oauthUser: 'As a person who signs in (OAuth)' };
/** An application registered in the customer's Microsoft Entra directory, with Files.ReadWrite.All (or Sites.ReadWrite.All) and admin consent. */
const MICROSOFT_APP: FieldSpec[] = [
  { name: 'tenantId', label: 'Directory (tenant) ID', hint: 'From the app registration in Microsoft Entra' },
  { name: 'clientId', label: 'Application (client) ID' },
];
const ROLE: FieldSpec[] = [
  { name: 'region', label: 'AWS region', hint: 'e.g. ap-south-1' },
  { name: 'roleArn', label: 'Role ARN', hint: 'A role in your account that trusts Form Builder' },
  { name: 'externalId', label: 'External ID', hint: 'Put this in the role trust policy (sts:ExternalId)' },
];
export const SPECS: Record<ConnectorType, { label: string; blurb: string; fields: FieldSpec[] }> = {
  mongodb: { label: 'MongoDB', blurb: 'Collections for dropdowns, prefill and saving answers.', fields: [{ name: 'database', label: 'Database' }, { name: 'uri', label: 'Connection string', secret: true, kind: 'password', hint: 'mongodb+srv://user:password@host/ - use a user with only the rights forms need' }] },
  postgres: {
    label: 'PostgreSQL',
    blurb: 'Tables and views, with parameterised queries only.',
    fields: [
      { name: 'host', label: 'Host' },
      { name: 'port', label: 'Port', kind: 'number', optional: true },
      { name: 'database', label: 'Database' },
      { name: 'schema', label: 'Schema', optional: true, hint: 'Default: public' },
      { name: 'ssl', label: 'Use TLS', kind: 'bool' },
      { name: 'user', label: 'User', secret: true },
      { name: 'password', label: 'Password', secret: true, kind: 'password' },
    ],
  },
  mysql: {
    label: 'MySQL',
    blurb: 'Tables and views, with parameterised queries only.',
    fields: [
      { name: 'host', label: 'Host' },
      { name: 'port', label: 'Port', kind: 'number', optional: true },
      { name: 'database', label: 'Database' },
      { name: 'ssl', label: 'Use TLS', kind: 'bool' },
      { name: 'user', label: 'User', secret: true },
      { name: 'password', label: 'Password', secret: true, kind: 'password' },
    ],
  },
  mssql: {
    label: 'SQL Server',
    blurb: 'Tables and views in Microsoft SQL Server or Azure SQL.',
    fields: [
      { name: 'host', label: 'Host' },
      { name: 'port', label: 'Port', kind: 'number', optional: true, hint: 'Default: 1433' },
      { name: 'database', label: 'Database' },
      { name: 'schema', label: 'Schema', optional: true, hint: 'Default: dbo' },
      { name: 'ssl', label: 'Use TLS', kind: 'bool' },
      { name: 'user', label: 'User', secret: true, hint: 'A SQL login with only the rights forms need' },
      { name: 'password', label: 'Password', secret: true, kind: 'password' },
    ],
  },
  oracle: {
    label: 'Oracle Database',
    blurb: 'Tables and views in Oracle Database, with parameterised queries only.',
    fields: [
      { name: 'host', label: 'Host' },
      { name: 'port', label: 'Port', kind: 'number', optional: true, hint: 'Default: 1521' },
      { name: 'database', label: 'Service name', hint: 'The service the database is reached by, e.g. ORCLPDB1 or FREEPDB1' },
      { name: 'schema', label: 'Schema', optional: true, hint: "Default: the user's own (Oracle keeps names in capitals)" },
      { name: 'ssl', label: 'Use TLS', kind: 'bool' },
      { name: 'user', label: 'User', secret: true, hint: 'A user with only the rights forms need' },
      { name: 'password', label: 'Password', secret: true, kind: 'password' },
    ],
  },
  db2: {
    label: 'IBM Db2',
    blurb: "Tables and views in Db2, through a gateway installed near the database (Db2's driver comes from IBM and runs there).",
    fields: [
      { name: 'host', label: 'Host' },
      { name: 'port', label: 'Port', kind: 'number', optional: true, hint: 'Default: 50000' },
      { name: 'database', label: 'Database' },
      { name: 'schema', label: 'Schema', optional: true, hint: "Default: the user's own (Db2 keeps names in capitals)" },
      { name: 'ssl', label: 'Use TLS', kind: 'bool' },
      { name: 'user', label: 'User', secret: true, hint: 'A user with only the rights forms need' },
      { name: 'password', label: 'Password', secret: true, kind: 'password' },
    ],
  },
  supabase: { label: 'Supabase', blurb: 'Your project through its REST API (row level security applies).', fields: [{ name: 'url', label: 'Project URL', hint: 'https://xyz.supabase.co' }, { name: 'apiKey', label: 'API key', secret: true, kind: 'password', hint: 'A restricted key, not service_role' }] },
  rest: {
    label: 'REST API',
    blurb: 'Your own API: define resources as path + fields.',
    fields: [
      { name: 'baseUrl', label: 'Base URL', hint: 'https only' },
      { name: 'auth', label: 'How it signs in', kind: 'select', options: ['none', 'bearer', 'apiKey', 'basic', 'oauth', 'oauthUser'], optionLabels: AUTH_LABELS },
      { name: 'apiKeyHeader', label: 'API key header', optional: true, hint: 'e.g. X-API-Key', showFor: ['apiKey'] },
      { name: 'authUrl', label: 'Sign-in address', showFor: ['oauthUser'], hint: 'Where a person is sent to agree, e.g. https://login.example.com/oauth/authorize. After saving, press Sign in on the connector.' },
      { name: 'tokenUrl', label: 'Token address', showFor: ['oauth', 'oauthUser'], hint: 'Where the API hands out tokens, e.g. https://login.example.com/oauth/token' },
      { name: 'clientId', label: 'Client (application) ID', showFor: ['oauth', 'oauthUser'] },
      { name: 'scope', label: 'Scope', optional: true, showFor: ['oauth', 'oauthUser'], hint: 'For a person signing in, include what makes the sign-in last (often offline_access).' },
      { name: 'resources', label: 'Resources (JSON)', kind: 'textarea', hint: '[{"key":"customers","path":"/customers","fields":["id","name"],"dataPath":"data"}]' },
      { name: 'token', label: 'Token / API key', secret: true, kind: 'password', showFor: ['bearer', 'apiKey'] },
      { name: 'username', label: 'User name', secret: true, showFor: ['basic'] },
      { name: 'password', label: 'Password', secret: true, kind: 'password', showFor: ['basic'] },
      { name: 'clientSecret', label: 'Client secret', secret: true, kind: 'password', showFor: ['oauth', 'oauthUser'] },
    ],
  },
  soap: {
    label: 'SOAP web service',
    blurb: 'An older kind of web service, described by a WSDL. Each of its operations is found for you: to look something up, or to send something.',
    fields: [
      { name: 'wsdlUrl', label: 'Address of the WSDL', hint: 'The description of the service, usually its address with ?wsdl on the end' },
      { name: 'endpoint', label: 'Address to call', optional: true, hint: 'Only when calls go somewhere other than where the WSDL says' },
      { name: 'auth', label: 'How it signs in', kind: 'select', options: ['none', 'basic', 'wsse'], optionLabels: { none: 'It does not', basic: 'A user name and password with each request', wsse: 'A user name and password inside each message (WS-Security)' } },
      { name: 'username', label: 'User name', secret: true, showFor: ['basic', 'wsse'] },
      { name: 'password', label: 'Password', secret: true, kind: 'password', showFor: ['basic', 'wsse'] },
    ],
  },
  odata: {
    label: 'OData',
    blurb: 'Dynamics 365, SAP and other systems that offer an OData service. Their tables and fields are found for you.',
    fields: [
      { name: 'baseUrl', label: 'Service address', hint: 'e.g. https://yourorg.crm.dynamics.com/api/data/v9.2' },
      { name: 'auth', label: 'How it signs in', kind: 'select', options: ['oauth', 'basic', 'bearer', 'apiKey', 'none'], optionLabels: AUTH_LABELS },
      { name: 'tokenUrl', label: 'Token address', showFor: ['oauth'], hint: 'For Microsoft: https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token' },
      { name: 'clientId', label: 'Client (application) ID', showFor: ['oauth'] },
      { name: 'scope', label: 'Scope', optional: true, showFor: ['oauth'], hint: 'For Dynamics: https://yourorg.crm.dynamics.com/.default' },
      { name: 'clientSecret', label: 'Client secret', secret: true, kind: 'password', showFor: ['oauth'] },
      { name: 'username', label: 'User name', secret: true, showFor: ['basic'] },
      { name: 'password', label: 'Password', secret: true, kind: 'password', showFor: ['basic'] },
      { name: 'apiKeyHeader', label: 'API key header', optional: true, hint: 'e.g. X-API-Key', showFor: ['apiKey'] },
      { name: 'token', label: 'Token / API key', secret: true, kind: 'password', showFor: ['bearer', 'apiKey'] },
    ],
  },
  salesforce: {
    label: 'Salesforce',
    blurb: 'Leads, contacts, cases and your own objects. Their fields are found for you.',
    fields: [
      { name: 'instanceUrl', label: 'Your Salesforce address', hint: 'e.g. https://yourcompany.my.salesforce.com (Setup → My Domain)' },
      { name: 'clientId', label: 'Consumer key', hint: 'From a connected app with the client credentials flow switched on and a "run as" user chosen' },
      { name: 'clientSecret', label: 'Consumer secret', secret: true, kind: 'password' },
    ],
  },
  'google-sheets': {
    label: 'Google Sheets',
    blurb: 'Every response a row of a sheet; a sheet can also fill a dropdown.',
    fields: [
      { name: 'spreadsheet', label: "The sheet's address", hint: 'Copy it from the browser while the sheet is open. Its first row must hold the column headings.' },
      { name: 'serviceAccount', label: 'Service account key (JSON)', secret: true, kind: 'textarea', hint: 'In Google Cloud: create a service account, add a JSON key, switch on the Sheets API. Then share the sheet with the account\'s email address as an editor. Paste the whole key file here.' },
    ],
  },
  excel: {
    label: 'Excel (Microsoft 365)',
    blurb: 'Every response a row of a table in a workbook kept in OneDrive or SharePoint.',
    fields: [...MICROSOFT_APP, { name: 'link', label: "The workbook's link", hint: 'In Excel or OneDrive choose Share → Copy link. The workbook needs a table (Insert → Table) whose headings name the columns.' }, { name: 'clientSecret', label: 'Client secret', secret: true, kind: 'password' }],
  },
  'microsoft-files': {
    label: 'SharePoint or OneDrive folder',
    blurb: 'Every response saved in a folder as a file, with its PDF.',
    fields: [...MICROSOFT_APP, { name: 'link', label: "The folder's link", hint: 'In SharePoint or OneDrive choose Share → Copy link on the folder.' }, { name: 'clientSecret', label: 'Client secret', secret: true, kind: 'password' }],
  },
  'azure-blob': {
    label: 'Azure Blob Storage',
    blurb: 'Every response saved in a container as a file, with its PDF.',
    fields: [
      { name: 'containerUrl', label: 'Container address', hint: 'e.g. https://youraccount.blob.core.windows.net/responses' },
      { name: 'prefix', label: 'Folder inside it', optional: true, hint: 'e.g. forms' },
      { name: 'sasToken', label: 'Shared access signature (SAS token)', secret: true, kind: 'password', hint: 'Made for this container, allowing Create, Write and List' },
    ],
  },
  'aws-s3': { label: 'Amazon S3', blurb: "Save answers as JSON files in your bucket (your account, your role).", fields: [...ROLE, { name: 'bucket', label: 'Bucket' }, { name: 'prefix', label: 'Key prefix', optional: true, hint: 'e.g. forms/' }] },
  'aws-cloudwatch': { label: 'CloudWatch Logs', blurb: 'Send form events to your log group.', fields: [...ROLE, { name: 'logGroup', label: 'Log group', hint: 'e.g. /acme/forms' }] },
};
const READS: Op[] = ['list', 'get', 'lookup'];
const WRITES: Op[] = ['insert', 'update', 'upload', 'log'];
const OPS_BY_TYPE: Record<ConnectorType, Op[]> = {
  mongodb: ['list', 'get', 'lookup', 'insert', 'update'],
  postgres: ['list', 'get', 'lookup', 'insert', 'update'],
  mysql: ['list', 'get', 'lookup', 'insert', 'update'],
  mssql: ['list', 'get', 'lookup', 'insert', 'update'],
  oracle: ['list', 'get', 'lookup', 'insert', 'update'],
  db2: ['list', 'get', 'lookup', 'insert', 'update'],
  supabase: ['list', 'get', 'lookup', 'insert', 'update'],
  rest: ['list', 'get', 'lookup', 'insert', 'update'],
  soap: ['list', 'get', 'lookup', 'insert', 'update'],
  odata: ['list', 'get', 'lookup', 'insert', 'update'],
  salesforce: ['list', 'get', 'lookup', 'insert', 'update'],
  'google-sheets': ['list', 'get', 'lookup', 'insert'],
  excel: ['list', 'get', 'lookup', 'insert'],
  'microsoft-files': ['upload'],
  'azure-blob': ['upload'],
  'aws-s3': ['list', 'upload'],
  'aws-cloudwatch': ['log'],
};

const newExternalId = () => `fb-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

function NewConnector({ onDone, onCancel }: { onDone: (c: ConnectorView) => void; onCancel: () => void }) {
  const [type, setType] = useState<ConnectorType>('postgres');
  const [name, setName] = useState('');
  const [values, setValues] = useState<Record<string, string | boolean>>({ ssl: true, auth: 'none', externalId: newExternalId() });
  const [writable, setWritable] = useState(false);
  const [gatewayId, setGatewayId] = useState('');
  const gateways = useQuery({ queryKey: ['gateways'], queryFn: () => api<GatewayView[]>('/gateways') });
  const spec = SPECS[type];
  const viaGateway = !!gatewayId;
  // OData is most often an application signing in as itself; the others start with nothing.
  const forType: Record<string, string | boolean> = { ...values, auth: values[`auth:${type}`] ?? (type === 'odata' ? 'oauth' : 'none') };
  const asked = fieldsFor(spec.fields, forType);
  const shownFields = viaGateway ? asked.filter((f) => !f.secret) : asked;
  const create = useSubmit(async () => {
    const settings: Record<string, unknown> = {};
    const secrets: Record<string, unknown> = {};
    // Only what is on the screen is sent: a box from another way of signing in must not ride along.
    for (const f of asked) {
      const v = forType[f.name];
      if (v === undefined || v === '' || (f.secret && viaGateway)) continue;
      (f.secret ? secrets : settings)[f.name] = f.kind === 'number' ? Number(v) : v;
    }
    onDone(await api<ConnectorView>('/connectors', { method: 'POST', body: viaGateway ? { type, name, settings, writable, gatewayId } : { type, name, settings, secrets, writable } }));
  });
  // The way of signing in is remembered per type, so switching type does not carry one type's choice to another.
  const set = (k: string, v: string | boolean) => setValues((x) => ({ ...x, [k === 'auth' ? `auth:${type}` : k]: v }));
  const fieldError = (n: string) => create.fields[`settings.${n}`] ?? create.fields[`secrets.${n}`];

  return (
    <Card title="New connector" subtitle="Credentials are encrypted with their own key and never shown again." actions={<Button variant="ghost" size="sm" aria-label="Close" onClick={onCancel}><X size={16} /></Button>}>
      <form className="st-stack" onSubmit={create.submit} noValidate>
        {create.error && !Object.keys(create.fields).length && <Alert tone="error">{create.error}</Alert>}
        <div className="st-row" role="radiogroup" aria-label="Type" style={{ alignItems: 'stretch' }}>
          {(Object.keys(SPECS) as ConnectorType[]).map((t) => (
            <label key={t} className="st-card" style={{ flex: '1 1 160px', padding: 12, cursor: 'pointer', borderColor: type === t ? 'var(--fb-accent)' : undefined, boxShadow: type === t ? 'var(--fb-ring)' : undefined }}>
              <input type="radio" name="type" value={t} checked={type === t} onChange={() => setType(t)} style={{ position: 'absolute', opacity: 0 }} />
              <strong>{SPECS[t].label}</strong>
              <div className="st-muted" style={{ fontSize: 12 }}>
                {SPECS[t].blurb}
              </div>
            </label>
          ))}
        </div>
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sales database" error={create.fields.name} />
        {!!gateways.data?.length && !type.startsWith('aws-') && (
          <SelectField label="Where it runs" value={gatewayId} onChange={(e) => setGatewayId(e.target.value)} hint="A gateway reaches databases on your private network; credentials then stay on the gateway machine.">
            <option value="">From Form Builder's cloud (credentials encrypted here)</option>
            {gateways.data.map((g) => (
              <option key={g.id} value={g.id}>
                Through gateway: {g.name}
                {g.connected ? '' : ' (offline)'}
              </option>
            ))}
          </SelectField>
        )}
        {viaGateway && <Alert tone="info">After creating, add this connector's host/URL and credentials to the gateway's connectors.json under its reference (shown on the card). Where it connects is decided on the gateway, and the credentials never leave that machine.</Alert>}
        <div className="st-grid-2">
          {shownFields.map((f) =>
            f.kind === 'bool' ? (
              <label key={f.name} className="st-check" style={{ alignSelf: 'end', paddingBottom: 10 }}>
                <input type="checkbox" checked={!!forType[f.name]} onChange={(e) => set(f.name, e.target.checked)} />
                {f.label}
              </label>
            ) : f.kind === 'select' ? (
              <SelectField key={f.name} label={f.label} value={String(forType[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)} error={fieldError(f.name)}>
                {f.options!.map((o) => (
                  <option key={o} value={o}>
                    {f.optionLabels?.[o] ?? o}
                  </option>
                ))}
              </SelectField>
            ) : f.kind === 'textarea' ? (
              <div key={f.name} className="st-field" style={{ gridColumn: '1 / -1' }}>
                <label htmlFor={`cx-${f.name}`}>{f.label}</label>
                <textarea id={`cx-${f.name}`} className="st-input st-mono" style={{ height: 90, padding: 10 }} value={String(forType[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value)} />
                <span className={fieldError(f.name) ? 'st-field__error' : 'st-field__hint'}>{fieldError(f.name) ?? f.hint}</span>
              </div>
            ) : (
              <TextField
                key={f.name}
                label={`${f.label}${f.optional ? ' (optional)' : ''}`}
                type={f.kind === 'password' ? 'password' : f.kind === 'number' ? 'number' : 'text'}
                autoComplete={f.secret ? 'new-password' : 'off'}
                value={String(forType[f.name] ?? '')}
                onChange={(e) => set(f.name, e.target.value)}
                hint={f.hint}
                error={fieldError(f.name)}
                readOnly={f.name === 'externalId'}
              />
            ),
          )}
        </div>
        {(type === 'aws-s3' || type === 'aws-cloudwatch') && (
          <Alert tone="info">
            In your AWS account, create a role that trusts Form Builder's account with the condition <code className="st-mono">"sts:ExternalId": "{String(values.externalId)}"</code>, and give it only {type === 'aws-s3' ? 's3:PutObject / s3:ListBucket on this bucket' : 'logs:CreateLogStream / logs:PutLogEvents on this log group'}.
          </Alert>
        )}
        <label className="st-check">
          <input type="checkbox" checked={writable} onChange={(e) => setWritable(e.target.checked)} />
          <span>
            <strong>Allow writes</strong>
            <span className="st-field__hint" style={{ display: 'block' }}>
              Off = forms can only read. You can change this later.
            </span>
          </span>
        </label>
        <div className="st-row">
          <Button type="submit" busy={create.busy} disabled={!name.trim()}>
            <Plug size={16} /> Create connector
          </Button>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

function ExposeEditor({ c, onSaved }: { c: ConnectorView; onSaved: (msg: string) => void }) {
  const qc = useQueryClient();
  const [found, setFound] = useState<Discovered[]>();
  const [draft, setDraft] = useState<Record<string, ExposedEntity>>(() => Object.fromEntries(c.entities.map((e) => [e.key, e])));
  const discover = useSubmit(async () => setFound(await api<Discovered[]>(`/connectors/${c.id}/discover`, { method: 'POST' })));
  const save = useSubmit(async () => {
    // What the source said about each exposed field (must it be filled, how long may it be) is kept with it,
    // so a form started from the table begins with the table's own limits.
    const entities = Object.values(draft).map((d) => {
      const seen = found?.find((f) => f.key === d.key)?.fields.filter((f) => d.fields.includes(f.name) && f.type);
      return { ...d, about: seen?.length ? seen.map((f) => ({ name: f.name, type: f.type, nullable: f.nullable, maxLength: f.maxLength, hasDefault: f.hasDefault, min: f.min, max: f.max, minLength: f.minLength, pattern: f.pattern })) : (d.about ?? []) };
    });
    await api(`/connectors/${c.id}/entities`, { method: 'PUT', body: { entities } });
    await qc.invalidateQueries({ queryKey: ['connectors'] });
    onSaved(`What ${c.name} exposes was saved.`);
  });
  const ops = OPS_BY_TYPE[c.type];
  const entities = found ?? c.entities.map((e) => ({ key: e.key, label: e.label, fields: e.fields.map((f) => ({ name: f, type: '' })) }));
  const toggle = (e: Discovered, on: boolean) =>
    setDraft((d) => {
      const next = { ...d };
      // A system that says which field identifies a row (OData does) saves the person choosing it.
      if (on) next[e.key] = d[e.key] ?? { key: e.key, label: e.label, fields: [...new Set([...(e.keyField ? [e.keyField] : []), ...e.fields.slice(0, 20).map((f) => f.name)])], keyField: e.keyField ?? '', operations: ['list'], valueField: '', labelField: '' };
      else delete next[e.key];
      return next;
    });
  const patch = (key: string, p: Partial<ExposedEntity>) => setDraft((d) => ({ ...d, [key]: { ...d[key]!, ...p } }));
  // Tables whose rows can belong to a row of another: this connector's as they are being set here, and those already saved on the others.
  const others = (qc.getQueryData<ConnectorView[]>(['connectors']) ?? []).filter((x) => x.id !== c.id);
  const tables = [
    ...Object.values(draft).map((e) => ({ source: `/connectors/${c.ref}/${e.key}`, label: e.label, fields: e.fields, listed: e.operations.includes('list') })),
    ...others.flatMap((x) => x.entities.map((e) => ({ source: `/connectors/${x.ref}/${e.key}`, label: `${x.name} · ${e.label}`, fields: e.fields, listed: e.operations.includes('list') }))),
  ].filter((t) => t.listed);

  return (
    <div className="st-stack">
      <div className="st-row">
        <Button variant="secondary" size="sm" busy={discover.busy} onClick={() => void discover.submit()}>
          <ScanSearch size={14} /> Discover tables / collections
        </Button>
        <span className="st-muted" style={{ fontSize: 12 }}>
          Nothing is visible to forms until you tick it here.
        </span>
      </div>
      {discover.error && <Alert tone="error">{discover.error}</Alert>}
      {entities.length === 0 ? (
        <p className="st-muted" style={{ margin: 0 }}>
          Discover first to see what's there.
        </p>
      ) : (
        entities.map((e) => {
          const d = draft[e.key];
          return (
            <div key={e.key} className="st-card" style={{ padding: 12, animation: 'none' }}>
              <label className="st-check">
                <input type="checkbox" checked={!!d} onChange={(ev) => toggle(e, ev.target.checked)} aria-label={`Expose ${e.key}`} />
                <strong>{e.label}</strong>
              </label>
              {d && (
                <div className="st-stack" style={{ gap: 10, marginTop: 10 }}>
                  <div className="st-row" style={{ gap: 6 }}>
                    <span className="st-muted" style={{ fontSize: 12 }}>
                      Fields:
                    </span>
                    {e.fields.map((f) => (
                      <label key={f.name} className="st-badge" style={{ cursor: 'pointer', background: d.fields.includes(f.name) ? 'var(--fb-accent-soft)' : undefined }}>
                        <input
                          type="checkbox"
                          checked={d.fields.includes(f.name)}
                          onChange={(ev) => patch(e.key, { fields: ev.target.checked ? [...d.fields, f.name] : d.fields.filter((x) => x !== f.name) })}
                          style={{ margin: 0 }}
                        />
                        {f.name}
                      </label>
                    ))}
                  </div>
                  <div className="st-row" style={{ gap: 6 }}>
                    <span className="st-muted" style={{ fontSize: 12 }}>
                      Forms may:
                    </span>
                    {ops.map((op) => (
                      <label key={op} className="st-badge" style={{ cursor: 'pointer', background: d.operations.includes(op) ? (WRITES.includes(op) ? 'var(--fb-warn-soft)' : 'var(--fb-accent-soft)') : undefined }}>
                        <input type="checkbox" checked={d.operations.includes(op)} onChange={(ev) => patch(e.key, { operations: ev.target.checked ? [...d.operations, op] : d.operations.filter((x) => x !== op) })} style={{ margin: 0 }} />
                        {op}
                      </label>
                    ))}
                    {d.operations.some((o) => WRITES.includes(o)) && !c.writable && <Badge tone="warn">Writes are off for this connector</Badge>}
                  </div>
                  <div className="st-row">
                    {(['keyField', 'valueField', 'labelField'] as const).map((k) => (
                      <select key={k} className="st-select" style={{ width: 180, height: 32 }} aria-label={`${k} of ${e.key}`} value={d[k]} onChange={(ev) => patch(e.key, { [k]: ev.target.value })}>
                        <option value="">{k === 'keyField' ? 'Key field (get/update)' : k === 'valueField' ? 'Dropdown value' : 'Dropdown label'}</option>
                        {d.fields.map((f) => (
                          <option key={f} value={f}>
                            {f}
                          </option>
                        ))}
                      </select>
                    ))}
                  </div>
                  <RelatedRows entity={d} tables={tables.filter((t) => t.source !== `/connectors/${c.ref}/${d.key}`)} onChange={(related) => patch(e.key, { related })} />
                </div>
              )}
            </div>
          );
        })
      )}
      {save.error && <Alert tone="error">{save.error}</Alert>}
      <div>
        <Button size="sm" busy={save.busy} onClick={() => void save.submit()}>
          Save what's exposed
        </Button>
      </div>
    </div>
  );
}

/**
 * "A customer has many orders": rows of another table that belong to a row of this one. When a form looks a row
 * up, they come along under the name given here, and can fill a repeating section.
 */
function RelatedRows({ entity, tables, onChange }: { entity: ExposedEntity; tables: { source: string; label: string; fields: string[] }[]; onChange: (related: NonNullable<ExposedEntity['related']>) => void }) {
  const related = entity.related ?? [];
  const set = (i: number, p: Partial<NonNullable<ExposedEntity['related']>[number]>) => onChange(related.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const start = () => {
    const first = tables[0];
    if (!first) return;
    // The likeliest match: a field of the other table with the same name as one of this table's.
    const shared = first.fields.find((f) => entity.fields.includes(f));
    onChange([...related, { name: first.source.split('/').pop()!.replace(/[^A-Za-z0-9_]/g, '_').replace(/^[^A-Za-z_]+/, '') || 'rows', source: first.source, field: shared ?? first.fields[0] ?? '', equals: shared ?? entity.keyField ?? entity.fields[0] ?? '' }]);
  };
  return (
    <div className="st-stack" style={{ gap: 6 }} role="group" aria-label={`Rows related to ${entity.key}`}>
      <span className="st-muted" style={{ fontSize: 12 }}>
        Related rows{related.length ? '' : ': none. Add them when rows of another table belong to a row of this one (a customer\'s orders), so one look-up brings both.'}
      </span>
      {related.map((r, i) => {
        const table = tables.find((t) => t.source === r.source);
        return (
          <div key={i} className="st-row" style={{ gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 13 }}>The rows of</span>
            <select className="st-select" style={{ width: 220, height: 32 }} aria-label={`Related table ${i + 1} of ${entity.key}`} value={r.source} onChange={(ev) => set(i, { source: ev.target.value, field: tables.find((t) => t.source === ev.target.value)?.fields[0] ?? '' })}>
              {!table && <option value={r.source}>No longer exposed</option>}
              {tables.map((t) => (
                <option key={t.source} value={t.source}>
                  {t.label}
                </option>
              ))}
            </select>
            <span style={{ fontSize: 13 }}>whose</span>
            <select className="st-select" style={{ width: 160, height: 32 }} aria-label={`Their field, related table ${i + 1} of ${entity.key}`} value={r.field} onChange={(ev) => set(i, { field: ev.target.value })}>
              {(table?.fields ?? [r.field]).map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <span style={{ fontSize: 13 }}>is this row's</span>
            <select className="st-select" style={{ width: 160, height: 32 }} aria-label={`This table's field, related table ${i + 1} of ${entity.key}`} value={r.equals} onChange={(ev) => set(i, { equals: ev.target.value })}>
              {entity.fields.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
            <span style={{ fontSize: 13 }}>, called</span>
            <input
              className="st-input"
              style={{ width: 140, height: 32 }}
              aria-label={`Name of related rows ${i + 1} of ${entity.key}`}
              value={r.name}
              onChange={(ev) => set(i, { name: ev.target.value.replace(/[^A-Za-z0-9_]/g, '').replace(/^[^A-Za-z_]+/, '').slice(0, 40) })}
            />
            <Button variant="ghost" size="sm" aria-label={`Remove related rows ${i + 1} of ${entity.key}`} onClick={() => onChange(related.filter((_, j) => j !== i))}>
              <X size={14} />
            </Button>
          </div>
        );
      })}
      {tables.length > 0 && related.length < 5 && (
        <div>
          <Button size="sm" variant="ghost" onClick={start}>
            <Plus size={14} /> Add related rows
          </Button>
        </div>
      )}
    </div>
  );
}

const TRY_ROWS = 20;

/**
 * "Try it": read one of the exposed tables now, with the filter values typed here, and see what comes back.
 * It is the same call a form's dropdown or look-up makes, so what shows here is what a form would get.
 */
export function TryIt({ c }: { c: ConnectorView }) {
  const readable = c.entities.filter((e) => e.operations.includes('list'));
  const [key, setKey] = useState(readable[0]?.key ?? '');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [rows, setRows] = useState<Record<string, unknown>[]>();
  const entity = readable.find((e) => e.key === key);
  const read = useSubmit(async () => {
    setRows(undefined);
    const params = Object.fromEntries(Object.entries(filters).filter(([, v]) => v.trim() !== ''));
    setRows(await api<Record<string, unknown>[]>('/connectors/query', { method: 'POST', body: { key: `/connectors/${c.ref}/${key}`, params } }));
  });
  const shown = (rows ?? []).slice(0, TRY_ROWS);
  const columns = [...new Set(shown.flatMap((r) => Object.keys(r)))].slice(0, 12);
  const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  return (
    <form className="st-stack" onSubmit={read.submit} aria-label={`Try ${c.name}`}>
      <div className="st-away">
        <SelectField
          label="Read from"
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setFilters({});
            setRows(undefined);
          }}
        >
          {readable.map((e) => (
            <option key={e.key} value={e.key}>
              {e.label}
            </option>
          ))}
        </SelectField>
        {(entity?.fields ?? []).slice(0, 8).map((f) => (
          <TextField key={f} label={`Only where ${f} is`} placeholder="anything" value={filters[f] ?? ''} onChange={(e) => setFilters((was) => ({ ...was, [f]: e.target.value }))} />
        ))}
      </div>
      <div>
        <Button type="submit" variant="secondary" size="sm" busy={read.busy}>
          Read now
        </Button>
      </div>
      {read.error && <Alert tone="error">{read.error}</Alert>}
      {rows && rows.length === 0 && <Alert tone="info">It answered, with no rows. A form's dropdown would be empty, and a look-up would find nothing.</Alert>}
      {shown.length > 0 && (
        <>
          <p className="st-muted">
            {rows!.length > TRY_ROWS ? `The first ${TRY_ROWS} of ${rows!.length} rows.` : `${rows!.length} ${rows!.length === 1 ? 'row' : 'rows'}.`} This is what a form gets.
          </p>
          <div className="st-table-wrap" style={{ overflowX: 'auto' }}>
            <table className="st-table" aria-label="Rows that came back">
              <thead>
                <tr>
                  {columns.map((col) => (
                    <th key={col}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((r, i) => (
                  <tr key={i}>
                    {columns.map((col) => (
                      <td key={col}>{cell(r[col]).slice(0, 120)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </form>
  );
}

/**
 * "Try adding a row": one real row written to an exposed table with the values typed here, exactly as a
 * workflow step would write it. It asks first, because the row really is added to the other system.
 */
export function TryWrite({ c }: { c: ConnectorView }) {
  const writable = c.entities.filter((e) => e.operations.includes('insert'));
  const [key, setKey] = useState(writable[0]?.key ?? '');
  const [values, setValues] = useState<Record<string, string>>({});
  const [sure, setSure] = useState(false);
  const [done, setDone] = useState<{ added: number; row: Record<string, unknown> | null }>();
  const entity = writable.find((e) => e.key === key);
  const add = useSubmit(async () => {
    setDone(undefined);
    setDone(await api<{ added: number; row: Record<string, unknown> | null }>(`/connectors/${c.id}/try-insert`, { method: 'POST', body: { entity: key, values } }));
    setSure(false);
  });
  const filled = Object.values(values).some((v) => v.trim() !== '');
  return (
    <form className="st-stack" onSubmit={add.submit} aria-label={`Try adding a row to ${c.name}`}>
      <strong>Try adding a row</strong>
      <div className="st-away">
        <SelectField
          label="Add to"
          value={key}
          onChange={(e) => {
            setKey(e.target.value);
            setValues({});
            setDone(undefined);
            setSure(false);
          }}
        >
          {writable.map((e) => (
            <option key={e.key} value={e.key}>
              {e.label}
            </option>
          ))}
        </SelectField>
        {(entity?.fields ?? []).slice(0, 12).map((f) => (
          <TextField key={f} label={f} value={values[f] ?? ''} onChange={(e) => setValues((was) => ({ ...was, [f]: e.target.value }))} />
        ))}
      </div>
      <label className="st-row" style={{ gap: 8 }}>
        <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
        I understand this adds a real row to {c.name}.
      </label>
      <div>
        <Button type="submit" variant="secondary" size="sm" busy={add.busy} disabled={!sure || !filled}>
          Add the row
        </Button>
      </div>
      {add.error && <Alert tone="error">{add.error}</Alert>}
      {done && <Alert tone="success">{done.added === 1 ? 'One row was added.' : `${done.added} rows were added.`}{done.row ? ` It came back as: ${JSON.stringify(done.row).slice(0, 300)}` : ''}</Alert>}
    </form>
  );
}

function ConnectorCard({ c, onMessage }: { c: ConnectorView; onMessage: (tone: 'success' | 'error', text: string) => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState<'expose' | 'calls' | 'secrets' | 'try' | null>(null);
  const [secret, setSecret] = useState<Record<string, string>>({});
  const refresh = () => qc.invalidateQueries({ queryKey: ['connectors'] });
  const calls = useQuery({ queryKey: ['connector-calls', c.id], queryFn: () => api<Call[]>(`/connectors/${c.id}/calls`), enabled: open === 'calls' });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      await refresh();
      onMessage('success', ok);
    } catch (e) {
      onMessage('error', errorMessage(e));
    }
  };
  const test = () =>
    run(async () => {
      const r = await api<{ ok: boolean; message: string }>(`/connectors/${c.id}/test`, { method: 'POST' });
      if (!r.ok) throw new Error(r.message);
    }, `${c.name}: connected.`);
  const secretFields = SPECS[c.type].fields.filter((f) => f.secret);

  return (
    <Card
      title={c.name}
      subtitle={
        <span className="st-row" style={{ gap: 6 }}>
          <Badge>{SPECS[c.type].label}</Badge>
          {c.gatewayId && (
            <Badge tone={c.gatewayConnected ? 'success' : 'danger'}>
              <Network size={12} /> Gateway {c.gatewayConnected ? 'online' : 'offline'}
            </Badge>
          )}
          {c.writable ? <Badge tone="warn">Read & write</Badge> : <Badge>Read only</Badge>}
          {c.lastTest ? (
            c.lastTest.ok ? (
              <Badge tone="success">
                <CheckCircle2 size={12} /> OK · {c.lastTest.latencyMs} ms
              </Badge>
            ) : (
              <Badge tone="danger">
                <XCircle size={12} /> {c.lastTest.message}
              </Badge>
            )
          ) : (
            <Badge>Not tested</Badge>
          )}
          <span className="st-muted">{c.entities.length} exposed</span>
        </span>
      }
      actions={
        c.permissions.manage && (
          <div className="st-row">
            <Button variant="secondary" size="sm" onClick={() => void test()}>
              <RefreshCw size={14} /> Test
            </Button>
            {c.settings.auth === 'oauthUser' && !c.gatewayId && (
              <Button
                size="sm"
                onClick={() =>
                  // The browser goes to the other system to agree, and comes back to this page.
                  void api<{ url: string }>(`/connectors/${c.id}/sign-in`, { method: 'POST' }).then(
                    (r) => window.location.assign(r.url),
                    (e) => onMessage('error', errorMessage(e)),
                  )
                }
              >
                Sign in
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={() => setOpen(open === 'expose' ? null : 'expose')}>
              <Database size={14} /> Expose
            </Button>
            {!c.gatewayId && (
              <Button variant="secondary" size="sm" onClick={() => setOpen(open === 'secrets' ? null : 'secrets')}>
                <KeyRound size={14} /> Credentials
              </Button>
            )}
            {c.entities.some((e) => e.operations.includes('list')) && (
              <Button variant="secondary" size="sm" onClick={() => setOpen(open === 'try' ? null : 'try')}>
                Try it
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={() => setOpen(open === 'calls' ? null : 'calls')}>
              Calls
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void run(() => api(`/connectors/${c.id}`, { method: 'PATCH', body: { writable: !c.writable } }), c.writable ? `${c.name} is now read only.` : `${c.name} now allows writes.`)}
            >
              {c.writable ? 'Make read only' : 'Allow writes'}
            </Button>
            <Button variant="danger" size="sm" aria-label={`Delete ${c.name}`} onClick={() => window.confirm(`Delete ${c.name}? Forms using it stop getting data.`) && void run(() => api(`/connectors/${c.id}`, { method: 'DELETE' }), `${c.name} was deleted.`)}>
              <Trash2 size={14} />
            </Button>
          </div>
        )
      }
    >
      {open === 'expose' && <ExposeEditor c={c} onSaved={(m) => onMessage('success', m)} />}
      {open === 'try' && <TryIt c={c} />}
      {open === 'try' && c.writable && c.permissions.manage && c.entities.some((e) => e.operations.includes('insert')) && <TryWrite c={c} />}
      {open === 'secrets' && (
        <form
          className="st-stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api(`/connectors/${c.id}/secrets`, { method: 'PUT', body: { secrets: secret } }), 'New credentials saved (and encrypted with a new key).').then(() => setSecret({}));
          }}
        >
          <Alert tone="info">Replaces the current credentials. They're never shown back.</Alert>
          <div className="st-grid-2">
            {secretFields.map((f) => (
              <TextField key={f.name} label={f.label} type={f.kind === 'password' ? 'password' : 'text'} autoComplete="new-password" value={secret[f.name] ?? ''} onChange={(e) => setSecret({ ...secret, [f.name]: e.target.value })} />
            ))}
          </div>
          <div>
            <Button type="submit" size="sm">
              Replace credentials
            </Button>
          </div>
        </form>
      )}
      {open === 'calls' && (
        <div className="st-table-wrap">
          <table className="st-table">
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>By</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {(calls.data ?? []).map((x, i) => (
                <tr key={i}>
                  <td className="st-muted">{new Date(x.at).toLocaleString()}</td>
                  <td>
                    {x.kind} <span className="st-mono">{x.entity}</span>
                  </td>
                  <td className="st-mono st-muted">{x.actor}</td>
                  <td>{x.ok ? <Badge tone="success">{x.rows} row(s) · {x.durationMs} ms</Badge> : <Badge tone="danger">{x.error}</Badge>}</td>
                </tr>
              ))}
              {!calls.data?.length && (
                <tr>
                  <td colSpan={4} className="st-empty">
                    No calls yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {!open && (
        <div className="st-row" style={{ gap: 6 }}>
          {c.entities.length ? (
            c.entities.map((e) => (
              <Badge key={e.key} tone="accent">
                {e.label}: {e.operations.join(', ')}
              </Badge>
            ))
          ) : (
            <span className="st-muted">Nothing exposed yet{c.permissions.manage ? ' - use Expose.' : '.'}</span>
          )}
          {c.gatewayId && c.permissions.manage && (
            <span className="st-muted" style={{ fontSize: 12 }}>
              Gateway credentials key: <code className="st-mono">{c.ref}</code>
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

/** Gateway agents: create (token shown once), see status, revoke. */
function GatewaysPanel({ onMessage }: { onMessage: (tone: 'success' | 'error', text: string) => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['gateways'], queryFn: () => api<GatewayView[]>('/gateways'), refetchInterval: 15_000 });
  const [name, setName] = useState('');
  const [issued, setIssued] = useState<{ name: string; registrationToken: string; expiresAt: string }>();
  const create = useSubmit(async () => {
    setIssued(await api<{ name: string; registrationToken: string; expiresAt: string }>('/gateways', { method: 'POST', body: { name } }));
    setName('');
    await qc.invalidateQueries({ queryKey: ['gateways'] });
  });
  const revoke = async (g: GatewayView) => {
    if (!window.confirm(`Revoke ${g.name}? It disconnects now and its connectors stop working.`)) return;
    try {
      await api(`/gateways/${g.id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['gateways'] });
      await qc.invalidateQueries({ queryKey: ['connectors'] });
      onMessage('success', `${g.name} was revoked.`);
    } catch (e) {
      onMessage('error', errorMessage(e));
    }
  };
  return (
    <Card title="Gateways" subtitle="For databases on your private network: a small agent runs next to them and connects out to Form Builder. No inbound firewall rules; credentials stay on your machine.">
      <div className="st-stack">
        {issued && (
          <Alert tone="success">
            <strong>{issued.name}</strong>: copy this now - it is shown only once and expires {new Date(issued.expiresAt).toLocaleString()}.
            <pre className="st-mono" style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0', fontSize: 12 }}>
              {`FB_API_URL=${API_URL} FB_GATEWAY_TOKEN=${issued.registrationToken} fb-gateway`}
            </pre>
          </Alert>
        )}
        {(data ?? []).map((g) => (
          <div key={g.id} className="st-row" style={{ justifyContent: 'space-between' }}>
            <span className="st-row" style={{ gap: 8 }}>
              <Network size={16} />
              <strong>{g.name}</strong>
              {!g.registered ? <Badge tone="warn">Waiting for agent</Badge> : g.connected ? <Badge tone="success">Online</Badge> : <Badge tone="danger">Offline</Badge>}
              {g.lastSeenAt && <span className="st-muted" style={{ fontSize: 12 }}>last seen {new Date(g.lastSeenAt).toLocaleString()}</span>}
              {g.version && <span className="st-muted st-mono" style={{ fontSize: 12 }}>v{g.version}</span>}
            </span>
            <Button variant="danger" size="sm" aria-label={`Revoke ${g.name}`} onClick={() => void revoke(g)}>
              <Trash2 size={14} />
            </Button>
          </div>
        ))}
        <form className="st-row" onSubmit={create.submit} noValidate>
          <TextField label="New gateway" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Pune plant LAN" error={create.fields.name ?? create.error} />
          <Button type="submit" size="sm" busy={create.busy} disabled={!name.trim()} style={{ alignSelf: 'end', marginBottom: 4 }}>
            <Plus size={14} /> Create gateway
          </Button>
        </form>
      </div>
    </Card>
  );
}

export default function ConnectorsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['connectors'], queryFn: () => api<ConnectorView[]>('/connectors') });
  const [creating, setCreating] = useState(false);
  // Back from signing a connector in at another system: say how it went, once, and tidy the address.
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | undefined>(() => {
    const q = new URLSearchParams(window.location.search);
    const ok = q.get('signedIn');
    const failed = q.get('signInFailed');
    if (!ok && !failed) return undefined;
    window.history.replaceState(null, '', window.location.pathname);
    return ok ? { tone: 'success', text: `${ok} is signed in. Press Test to check it.` } : { tone: 'error', text: failed! };
  });
  const list = useMemo(() => data ?? [], [data]);

  return (
    <>
      <PageHead
        title="Connectors"
        subtitle="Your databases and APIs, for dropdowns, prefill and saving answers. Credentials are encrypted; forms only see what you expose."
        actions={
          can('connector.manage') &&
          !creating && (
            <Button onClick={() => setCreating(true)}>
              <Plus size={16} /> New connector
            </Button>
          )
        }
      />
      <div className="st-stack">
        {message && <Alert tone={message.tone}>{message.text}</Alert>}
        {creating && (
          <NewConnector
            onCancel={() => setCreating(false)}
            onDone={(c) => {
              setCreating(false);
              setMessage({ tone: 'success', text: `${c.name} was created. Test it, then choose what to expose.` });
              void qc.invalidateQueries({ queryKey: ['connectors'] });
            }}
          />
        )}
        {isLoading ? (
          <p className="st-empty">Loading…</p>
        ) : list.length ? (
          list.map((c) => <ConnectorCard key={c.id} c={c} onMessage={(tone, text) => setMessage({ tone, text })} />)
        ) : (
          !creating && (
            <Card>
              <p className="st-empty" style={{ padding: 24 }}>
                No connectors yet. {can('connector.manage') ? 'Add one to fill dropdowns from your data or save answers into it.' : 'Ask an admin to add one.'}
              </p>
            </Card>
          )
        )}
        {can('connector.manage') && <GatewaysPanel onMessage={(tone, text) => setMessage({ tone, text })} />}
        <p className="st-muted" style={{ margin: 0, fontSize: 12 }}>
          Reads: {READS.join(', ')} · Writes: {WRITES.join(', ')} (writes also need "Allow writes"). Databases on a private network need the gateway agent.
        </p>
      </div>
    </>
  );
}
