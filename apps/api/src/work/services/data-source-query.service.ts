import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConnectorsService } from '../../connectors/connectors.service';
import { ExtensionFailure, ExtensionsService } from '../../extensions/extensions.service';
import { ListsService } from '../../lists/lists.service';

export type DataRow = Record<string, unknown>;

/**
 * Rows behind a dropdown that reads its options from somewhere: the organisation's own lists (/lists/<key>),
 * connector sources (/connectors/<ref>/<entity>) and lists its extension offers (/extensions/<ref>/<list>).
 * Used to render options and to check submitted values on the server.
 */
@Injectable()
export class DataSourceQueryService {
  constructor(
    private readonly connectors: ConnectorsService,
    private readonly extensions: ExtensionsService,
    private readonly lists: ListsService,
  ) {}

  async queryDataSource(orgId: string, key: unknown, params: unknown, user?: { uuid: string; orgId: string }, actor?: string): Promise<DataRow[]> {
    if (typeof key !== 'string' || key.length > 200) throw new BadRequestException('Unknown data source');
    const entries = params && typeof params === 'object' && !Array.isArray(params) ? Object.entries(params as Record<string, unknown>) : [];
    if (entries.length > 10) throw new BadRequestException('Too many parameters');
    for (const [k, v] of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(k) || !['string', 'number', 'boolean'].includes(typeof v) || String(v).length > 200) throw new BadRequestException('Invalid parameter');
    }
    const path = key.split('?')[0]!;
    // The organisation's own master data: a list kept in its library.
    if (path.startsWith('/lists/')) return this.lists.items(orgId, path, Object.fromEntries(entries));
    if (path.startsWith('/extensions/')) {
      return this.extensions.readList(orgId, path, Object.fromEntries(entries)).catch((e) => {
        // The form shows "couldn't load options"; the reason is for the organisation's admins, not the public.
        if (e instanceof ExtensionFailure) throw new ServiceUnavailableException('These options are not available right now');
        throw e;
      });
    }
    return this.connectors.readSource(orgId, key.split('?')[0]!, Object.fromEntries(entries), actor ?? (user ? user.uuid : 'public'));
  }
}
