import { useQuery } from '@tanstack/react-query';
import type { ApiDataSource } from '../../types';
import { USE_API } from '../backend';

export type DataRow = Record<string, unknown>;

/**
 * Where API-backed dropdown options come from. The mock answers a handful of
 * demo URLs in memory; the HTTP adapter asks the server, which serves
 * allow-listed datasets by key (it never fetches the URL itself).
 */
export interface DataSourceAdapter {
  fetchRows(api: ApiDataSource, params: Record<string, string>): Promise<DataRow[]>;
}

export class UnknownDataSourceError extends Error {
  constructor(url: string) {
    super(`No data source is available at ${url}`);
    this.name = 'UnknownDataSourceError';
  }
}

const BUSINESSES = [
  { id: 'BUSINESS001', name: 'Denim' },
  { id: 'BUSINESS002', name: 'Yarn' },
  { id: 'BUSINESS003', name: 'Retail' },
];

const SECTIONS = [
  { id: 'SEC_WEAVING', name: 'Weaving', businessId: 'BUSINESS001' },
  { id: 'SEC_DYEING', name: 'Dyeing', businessId: 'BUSINESS001' },
  { id: 'SEC_FINISHING', name: 'Finishing', businessId: 'BUSINESS001' },
  { id: 'SEC_SPINNING', name: 'Spinning', businessId: 'BUSINESS002' },
  { id: 'SEC_WINDING', name: 'Winding', businessId: 'BUSINESS002' },
  { id: 'SEC_STORES', name: 'Stores', businessId: 'BUSINESS003' },
  { id: 'SEC_ONLINE', name: 'Online', businessId: 'BUSINESS003' },
];

const SUBSECTIONS = [
  { id: 'SUB_LOOM_A', name: 'Loom shed A', sectionId: 'SEC_WEAVING' },
  { id: 'SUB_LOOM_B', name: 'Loom shed B', sectionId: 'SEC_WEAVING' },
  { id: 'SUB_ROPE', name: 'Rope dyeing', sectionId: 'SEC_DYEING' },
  { id: 'SUB_SLASHER', name: 'Slasher dyeing', sectionId: 'SEC_DYEING' },
  { id: 'SUB_MERCER', name: 'Mercerising', sectionId: 'SEC_FINISHING' },
  { id: 'SUB_RING', name: 'Ring frames', sectionId: 'SEC_SPINNING' },
  { id: 'SUB_OE', name: 'Open-end', sectionId: 'SEC_SPINNING' },
  { id: 'SUB_AUTOCONER', name: 'Autoconer', sectionId: 'SEC_WINDING' },
  { id: 'SUB_MUMBAI', name: 'Mumbai flagship', sectionId: 'SEC_STORES' },
  { id: 'SUB_WEBSITE', name: 'Website orders', sectionId: 'SEC_ONLINE' },
];

const PRODUCTS = [
  { id: 'P1001', name: 'Stretch denim 10 oz', category: 'PRODUCT' },
  { id: 'P1002', name: 'Rigid denim 13 oz', category: 'PRODUCT' },
  { id: 'P1003', name: 'Cotton yarn 30s', category: 'PRODUCT' },
  { id: 'D2001', name: 'Standard delivery', category: 'DELIVERY' },
  { id: 'D2002', name: 'Express delivery', category: 'DELIVERY' },
];

const filterBy = (rows: DataRow[], params: Record<string, string>) =>
  rows.filter((row) => Object.entries(params).every(([k, v]) => v === '' || String(row[k] ?? '') === v));

const MOCK_ROUTES: Record<string, DataRow[]> = {
  '/api/businesses': BUSINESSES,
  '/api/sections': SECTIONS,
  '/api/subsections': SUBSECTIONS,
  '/api/products': PRODUCTS,
};

/** URLs the mock can answer - shown in the builder so designers know what to try. */
export const MOCK_DATA_SOURCE_URLS = Object.keys(MOCK_ROUTES);

/** The demo datasets, for seeding an org's allow-listed data sources ("Load samples"). */
export const DEMO_DATA_SOURCES: { key: string; name: string; rows: DataRow[] }[] = [
  { key: '/api/businesses', name: 'Businesses (demo)', rows: BUSINESSES },
  { key: '/api/sections', name: 'Sections (demo)', rows: SECTIONS },
  { key: '/api/subsections', name: 'Sub-sections (demo)', rows: SUBSECTIONS },
  { key: '/api/products', name: 'Products (demo)', rows: PRODUCTS },
];

export function createMockDataSourceAdapter({ delayMs = 250 } = {}): DataSourceAdapter {
  return {
    async fetchRows(api, params) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const rows = MOCK_ROUTES[api.url.split('?')[0]];
      if (!rows) throw new UnknownDataSourceError(api.url);
      return filterBy(rows, params);
    },
  };
}

/** Signed-in reads (builder preview, New work item): connector sources the user may use. */
export const connectorSourceAdapter: DataSourceAdapter = {
  async fetchRows(api, params) {
    return (await import('../../../lib/api')).api<DataRow[]>('/connectors/query', { method: 'POST', body: { key: api.url.split('?')[0], params } });
  },
};

export const defaultDataSourceAdapter: DataSourceAdapter = USE_API ? connectorSourceAdapter : createMockDataSourceAdapter();

/** Read `a.b.c` from a row, so valueField/labelField can point into nested data. */
export function readPath(row: DataRow, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => (acc && typeof acc === 'object' ? (acc as DataRow)[key] : undefined), row);
}

/** Keys designers can use as an API data source URL: the org's allow-listed datasets (or the mock routes offline). */
/** An allow-listed data source: an admin dataset, or one backed by code (@FormDataProvider). */
export interface DataSourceInfo {
  key: string;
  name: string;
  code?: boolean;
  access?: 'PUBLIC' | 'SIGNED_IN';
  description?: string;
  params?: string[];
  valueField?: string;
  labelField?: string;
  /** One of the organisation's own lists (Lists in the menu), which needs no technical settings. */
  list?: boolean;
  /** For a list that depends on another: that other list's name. */
  dependsOnName?: string;
  /** Lists of related rows a row of this source brings along (a customer's orders), with what each of their rows holds. */
  related?: { name: string; fields: string[] }[];
}

/** Tests: the organisation's lists as dropdown sources. */
let localListSources: DataSourceInfo[] = [];
export const seedLocalListSources = (sources: DataSourceInfo[]) => {
  localListSources = sources;
};

export function useDataSources() {
  return useQuery({
    queryKey: ['form-platform', 'data-sources-info'],
    queryFn: async (): Promise<DataSourceInfo[]> => {
      if (!USE_API) return [...localListSources, ...MOCK_DATA_SOURCE_URLS.map((key) => ({ key, name: key }))];
      const { api } = await import('../../../lib/api');
      type Source = { key: string; name: string; params: string[]; valueField?: string; labelField?: string; list?: boolean; dependsOnName?: string; description?: string; related?: { name: string; fields: string[] }[] };
      // Connector sources, then the lists the organisation's extension offers. Either may be absent.
      const [lists, connectors, extensions] = await Promise.all([api<Source[]>('/lists/sources').catch(() => []), api<Source[]>('/connectors/sources').catch(() => []), api<Source[]>('/extensions/sources').catch(() => [])]);
      // The organisation's own lists first: they are what most dropdowns want.
      return [...lists, ...connectors, ...extensions].map((x) => ({ key: x.key, name: x.name, params: x.params, valueField: x.valueField, labelField: x.labelField, list: x.list, dependsOnName: x.dependsOnName, description: x.list ? x.description : undefined, related: x.related }));
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useDataSourceKeys() {
  const q = useDataSources();
  return { ...q, data: q.data?.map((d) => d.key) };
}
