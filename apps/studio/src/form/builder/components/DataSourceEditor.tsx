import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Input } from '@ui/input';
import { Button } from '@ui/button';
import type { ApiDataSource, DataSourceConfig, FormField, SelectOption } from '../../types';
import { paramReferences, resolveParams } from '../../engine';
import { defaultDataSourceAdapter, readPath, useDataSources } from '../../adapters/data-source/data-source-adapter';
import { OptionsEditor } from './OptionsEditor';
import { SelectSetting, TextSetting } from './settings';
import { errorText } from '../../runtime/styles';

interface DataSourceEditorProps {
  field: FormField;
  /** Other fields - candidates for `{{field}}` params. */
  others: FormField[];
  onChange: (dataSource: DataSourceConfig) => void;
}

const BLANK_API: ApiDataSource = { url: '', method: 'GET', valueField: 'id', labelField: 'name' };

function ParamsEditor({ params, onChange }: { params: Record<string, string>; onChange: (p: Record<string, string>) => void }) {
  const rows = Object.entries(params);
  const setRow = (index: number, key: string, value: string) =>
    onChange(Object.fromEntries(rows.map(([k, v], i) => (i === index ? [key, value] : [k, v]))));
  return (
    <div className="fb-settings" style={{ gap: 6 }}>
      {rows.map(([key, value], index) => (
        <div key={index} className="fb-options-row">
          <Input aria-label={`Param ${index + 1} name`} placeholder="name" value={key} onChange={(e) => setRow(index, e.target.value, value)} />
          <Input
            aria-label={`Param ${index + 1} value`}
            className="fb-code"
            placeholder="{{field}}"
            value={value}
            onChange={(e) => setRow(index, key, e.target.value)}
          />
          <button
            type="button"
            className="fb-icon-btn fb-icon-btn--danger"
            aria-label="Remove param"
            onClick={() => onChange(Object.fromEntries(rows.filter((_, i) => i !== index)))}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...params, [`param${rows.length + 1}`]: '' })}>
          <Plus /> Add parameter
        </Button>
      </div>
    </div>
  );
}

/** Fetch with sample values for referenced fields and show the first options it produces. */
function TestCall({ api, others }: { api: ApiDataSource; others: FormField[] }) {
  const refs = paramReferences(api.params).fields;
  const [samples, setSamples] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ options?: SelectOption[]; count?: number; error?: string } | null>(null);

  const run = async () => {
    const { params, unresolved } = resolveParams(api.params, samples, {});
    if (unresolved.length) return setResult({ error: `Enter a sample value for ${unresolved.join(', ')}` });
    try {
      const rows = await defaultDataSourceAdapter.fetchRows(api, params);
      const options = rows.map((r) => ({ value: String(readPath(r, api.valueField) ?? ''), label: String(readPath(r, api.labelField) ?? '') }));
      setResult({ options: options.slice(0, 5), count: options.length });
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : 'Request failed' });
    }
  };

  return (
    <div className="fb-section fb-settings" style={{ gap: 8 }}>
      {refs.map((name) => {
        const f = others.find((o) => o.name === name);
        return (
          <TextSetting
            key={name}
            label={`Sample value for ${f?.label || name}`}
            value={samples[name]}
            onChange={(v) => setSamples({ ...samples, [name]: v })}
            hint={f?.dataSource?.options?.length ? `e.g. ${f.dataSource.options[0].value}` : undefined}
          />
        );
      })}
      <div>
        <Button type="button" variant="outline" size="sm" onClick={run} disabled={!api.url}>
          Test
        </Button>
      </div>
      {result?.error && (
        <p className="text-xs" style={errorText}>
          {result.error}
        </p>
      )}
      {result?.options && (
        <p className="fb-muted">
          {result.count} option{result.count === 1 ? '' : 's'}
          {result.count ? `: ${result.options.map((o) => o.label).join(', ')}${result.count > 5 ? ', …' : ''}` : ''}
        </p>
      )}
    </div>
  );
}

/** Where a choice field gets its options: a list typed here, or an API. */
export function DataSourceEditor({ field, others, onChange }: DataSourceEditorProps) {
  const ds: DataSourceConfig = field.dataSource ?? { type: 'STATIC', options: [] };
  const api = ds.api ?? BLANK_API;
  const setApi = (changes: Partial<ApiDataSource>) => onChange({ type: 'API', api: { ...api, ...changes } });
  const refs = paramReferences(api.params).fields;
  const { data: sources = [] } = useDataSources();
  const chosen = sources.find((s) => s.key === api.url);

  return (
    <div className="fb-settings">
      <SelectSetting
        label="Options come from"
        value={ds.type}
        options={[
          { label: 'A list I type here', value: 'STATIC' },
          { label: 'A shared list, or my systems', value: 'API' },
        ]}
        onChange={(type) =>
          onChange(
            type === 'STATIC'
              ? { type: 'STATIC', options: ds.options?.length ? ds.options : [{ label: 'Option 1', value: 'OPTION_1' }] }
              : { type: 'API', api },
          )
        }
      />

      {ds.type === 'STATIC' ? (
        <OptionsEditor options={ds.options ?? []} onChange={(options) => onChange({ type: 'STATIC', options })} />
      ) : (
        <>
          <SelectSetting
            label="Which one"
            value={chosen?.key}
            placeholder={sources.length ? 'Pick a list or a data source…' : 'Nothing to pick from yet'}
            options={sources.map((s) => ({ label: s.list ? `List: ${s.name}` : `${s.name}${s.code ? ' (from the system)' : ''}`, value: s.key }))}
            onChange={(key) => {
              const s = sources.find((x) => x.key === key);
              setApi({
                url: key,
                valueField: s?.valueField || api.valueField,
                labelField: s?.labelField || api.labelField,
                // A list has its own settings: nothing of another source's is carried over.
                params: s?.list ? undefined : s?.params?.length ? { ...Object.fromEntries(s.params.map((p) => [p, ''])), ...api.params } : api.params,
              });
            }}
            hint={
              chosen?.list
                ? `${chosen.description ? `${chosen.description}. ` : ''}Kept under Lists in the menu: change it there and this dropdown follows.`
                : chosen?.code
                ? `${chosen.description ?? ''}${chosen.access === 'PUBLIC' ? '' : ' Signed-in users only - use it on sign-in-only forms.'}`
                : sources.length
                  ? undefined
                  : 'An administrator can add a list under Lists in the menu, or connect one of your systems under Connectors.'
            }
          />
          {chosen?.list && chosen.dependsOnName && (
            <SelectSetting
              label={`Offer the items for the ${chosen.dependsOnName} chosen in`}
              value={refs[0]}
              placeholder="Pick the field…"
              options={others.filter((o) => o.type === 'DROPDOWN' || o.type === 'RADIO').map((o) => ({ label: o.label || o.name, value: o.name }))}
              onChange={(name) => setApi({ params: { parent: `{{${name}}}` } })}
              hint={refs[0] ? 'The options change when that field changes.' : `This list depends on ${chosen.dependsOnName}: say which field of this form holds it, or every item is offered.`}
            />
          )}
          {!chosen?.list && (
            <>
          <TextSetting label="URL" value={api.url} placeholder="/api/sections" onChange={(url) => setApi({ url })} />
          <div className="fb-row">
            <TextSetting label="Value property" value={api.valueField} onChange={(valueField) => setApi({ valueField })} />
            <TextSetting label="Label property" value={api.labelField} onChange={(labelField) => setApi({ labelField })} />
          </div>
          <div className="fb-setting">
            <span className="fb-setting__label">Parameters</span>
            <ParamsEditor params={api.params ?? {}} onChange={(params) => setApi({ params: Object.keys(params).length ? params : undefined })} />
            <span className="fb-setting__hint">
              Use {'{{fieldKey}}'} to send another field's value, e.g. businessId = {'{{business}}'}. The options reload when that field
              changes{refs.length ? ` (here: ${refs.join(', ')})` : ''}.
            </span>
          </div>
          <TestCall api={api} others={others} />
            </>
          )}
        </>
      )}
    </div>
  );
}
