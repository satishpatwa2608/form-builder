import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { FormField, SelectOption } from '../../types';
import { fieldLabel, resolveParams } from '../../engine';
import { readPath } from '../../adapters/data-source/data-source-adapter';
import { useFormRuntime } from '../FormRuntimeContext';

export interface FieldOptions {
  options: SelectOption[];
  /**
   * ready     - options available
   * waiting   - an API param references a field that is still empty
   * loading   - request in flight
   * error     - request failed
   */
  status: 'ready' | 'waiting' | 'loading' | 'error';
  /** Labels of the fields this one is waiting for. */
  waitingFor: string[];
  error?: string;
}

const NO_OPTIONS: SelectOption[] = [];

/**
 * Options for RADIO / DROPDOWN / MULTI_SELECT. STATIC comes straight from the
 * definition. API options are a TanStack Query keyed on the *resolved* params,
 * so when a parent field changes the key changes and the options reload by
 * themselves - no manual refetch wiring for dependent dropdowns.
 */
export function useFieldOptions(field: FormField): FieldOptions {
  const { values, systemContext, dataSourceAdapter, definition } = useFormRuntime();
  const api = field.dataSource?.type === 'API' ? field.dataSource.api : undefined;

  // Cheap to recompute; TanStack hashes the key by value, so an unrelated
  // field changing doesn't refetch - only a change in these resolved params does.
  const resolved = api ? resolveParams(api.params, values, systemContext) : null;

  const query = useQuery({
    queryKey: ['form-platform', 'data-source', api?.url, api?.method, resolved?.params],
    queryFn: () => dataSourceAdapter.fetchRows(api!, resolved!.params),
    enabled: !!api && !!resolved && resolved.unresolved.length === 0,
    staleTime: 5 * 60 * 1000,
  });

  const options = useMemo<SelectOption[]>(() => {
    if (!api) return field.dataSource?.options ?? NO_OPTIONS;
    return (query.data ?? []).map((row) => ({
      value: String(readPath(row, api.valueField) ?? ''),
      label: String(readPath(row, api.labelField) ?? ''),
    }));
  }, [api, field.dataSource, query.data]);

  if (!api) return { options, status: 'ready', waitingFor: [] };
  if (resolved && resolved.unresolved.length) {
    const waitingFor = resolved.unresolved.map((name) => {
      const f = definition.fields.find((x) => x.name === name);
      return f ? fieldLabel(f) : name;
    });
    return { options: NO_OPTIONS, status: 'waiting', waitingFor };
  }
  if (query.isError) return { options: NO_OPTIONS, status: 'error', waitingFor: [], error: (query.error as Error).message };
  if (query.isPending) return { options: NO_OPTIONS, status: 'loading', waitingFor: [] };
  return { options, status: 'ready', waitingFor: [] };
}

/** Placeholder text for a select in each state. */
export function optionsPlaceholder(state: FieldOptions, fallback: string): string {
  switch (state.status) {
    case 'waiting':
      return `Select ${state.waitingFor.join(', ')} first`;
    case 'loading':
      return 'Loading options…';
    case 'error':
      return 'Options unavailable';
    default:
      return state.options.length ? fallback : 'No options';
  }
}
