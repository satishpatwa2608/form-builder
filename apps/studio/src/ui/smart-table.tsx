import type { ReactNode } from 'react';

/**
 * The part of Sangam's SmartTable the ported form pages use (columns with a
 * render function, loading and empty states), on the studio's table styles.
 */
export interface SmartTableColumn<T> {
  title: ReactNode;
  dataIndex: string;
  width?: number;
  align?: 'left' | 'center' | 'right';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  render?: (value: any, row: T, index: number) => ReactNode;
}

interface SmartTableProps<T> {
  data: T[];
  columns: SmartTableColumn<T>[];
  loading?: boolean;
  rowKey: keyof T & string;
  /** Paging is done by the page itself. */
  pagination?: false;
  emptyText?: ReactNode;
}

/** `a.b.c` from a row. */
const read = (row: unknown, path: string) => path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), row);

export function SmartTable<T>({ data, columns, loading, rowKey, emptyText = 'Nothing here yet.' }: SmartTableProps<T>) {
  return (
    <div className="st-card st-table-wrap">
      <table className="st-table">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} style={{ width: c.width, textAlign: c.align }}>
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && !data.length ? (
            <tr>
              <td colSpan={columns.length} className="st-empty">
                Loading…
              </td>
            </tr>
          ) : !data.length ? (
            <tr>
              <td colSpan={columns.length} className="st-empty">
                {emptyText}
              </td>
            </tr>
          ) : (
            data.map((row, index) => (
              <tr key={String(row[rowKey])}>
                {columns.map((c, i) => {
                  const value = read(row, c.dataIndex);
                  return (
                    <td key={i} style={{ textAlign: c.align }}>
                      {c.render ? c.render(value, row, index) : value === undefined || value === null ? '' : String(value)}
                    </td>
                  );
                })}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
