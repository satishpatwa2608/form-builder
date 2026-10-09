import { useMemo, useState } from 'react';
import { format } from 'date-fns';
import { ArrowLeft, Download, FileText, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@ui/button';
import { SmartTable, type SmartTableColumn } from '@ui/smart-table';
import type { FormDefinition, FormField } from '../types';
import { answerFields, csvCell, formShape, plainAnswer, rowsText } from '../engine';
import { useFormDoc } from '../adapters/registry/useFormRegistry';
import { fetchAllSubmissions, fileLink, submissionsAvailable, useSubmissions, type SubmissionRow } from '../adapters/submissions';
import { printSubmission } from './print-submission';
import '../styles/form-builder.css';

interface SubmissionsPageProps {
  formId: string | undefined;
  onBack: () => void;
}

const PAGE_SIZE = 20;

/** Payload key for a field (after the form's submission mapping). */
const keyOf = (def: FormDefinition, name: string) => def.submission.mapping?.[name] ?? name;

const display = plainAnswer;

/** One answer as text; a repeating section's rows are listed under the labels of its fields. */
const answer = (def: FormDefinition, f: FormField, value: unknown): string =>
  f.type === 'REPEAT' ? rowsText(formShape(def.fields).repeats.find((r) => r.field.id === f.id)?.valueChildren ?? [], value) : display(value);

/**
 * What came in for one form (all versions), newest first. Columns come from
 * the latest version's fields, so a new form needs no screen changes.
 */
export default function SubmissionsPage({ formId, onBack }: SubmissionsPageProps) {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useSubmissions(formId, page, PAGE_SIZE);
  // Columns come from this version's fields; rows cover every version of the form.
  const { data: doc } = useFormDoc(formId);
  const code = doc?.definition.code;
  const [exporting, setExporting] = useState(false);

  const def = doc?.definition;
  const fields = useMemo(
    () => (def ? answerFields(def.fields).filter((f) => f.type !== 'HIDDEN' && f.type !== 'CAPTCHA') : []),
    [def],
  );

  const openFile = async (row: SubmissionRow, uploadId: string) => {
    try {
      window.open(await fileLink(formId!, row.uuid, uploadId), '_blank', 'noopener');
    } catch {
      toast.error("Couldn't open the file");
    }
  };

  const exportCsv = async () => {
    if (!code || !def) return;
    setExporting(true);
    try {
      const rows = await fetchAllSubmissions(formId!);
      const header = ['Submitted at', 'Version', 'Channel', 'Submitted by', ...fields.map((f) => f.label || f.name)];
      const lines = rows.map((r) =>
        [r.createdAt, r.formVersion, r.channel, r.submittedBy, ...fields.map((f) => answer(def, f, r.payload[keyOf(def, f.name)]))].map(csvCell).join(','),
      );
      const blob = new Blob([`\ufeff${[header.map(csvCell).join(','), ...lines].join('\r\n')}`], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${code}-submissions.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      toast.error("Couldn't export");
    } finally {
      setExporting(false);
    }
  };

  const print = (row: SubmissionRow) => {
    if (!def) return;
    printSubmission({
      formName: def.name,
      code: def.code,
      ref: (row as { ref?: string }).ref,
      submittedAt: row.createdAt,
      submittedBy: row.submittedBy,
      version: row.formVersion,
      channel: row.channel,
      answers: fields.map((f) => ({
        label: f.label || f.name,
        value:
          f.type === 'FILE'
            ? row.files
                .filter((x) => x.fieldName === f.name)
                .map((x) => x.name)
                .join(', ')
            : answer(def, f, row.payload[keyOf(def, f.name)]),
      })),
    });
  };

  /**
   * The document of record: made and kept by the server, the same for whoever asks for it.
   * It is fetched with the session and saved as a file (a tab opened on it from memory
   * is something browsers refuse).
   */
  const downloadDocument = async (row: SubmissionRow) => {
    try {
      const { apiFile } = await import('../../lib/api');
      const url = URL.createObjectURL(await apiFile(`/forms/${encodeURIComponent(formId!)}/submissions/${encodeURIComponent(row.uuid)}/document`));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${((row as { ref?: string }).ref || `${def?.code ?? 'response'}-${row.uuid.slice(0, 8)}`).replace(/[^A-Za-z0-9._-]/g, '_')}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : "Couldn't get the PDF");
    }
  };

  const columns: SmartTableColumn<SubmissionRow>[] = [
    {
      title: '',
      dataIndex: 'uuid',
      width: 76,
      render: (_: unknown, row) => (
        <span className="flex items-center">
          <button type="button" className="fb-icon-btn" aria-label="Download the PDF of this response" title="Download the PDF of this response" onClick={() => void downloadDocument(row)}>
            <FileText size={15} />
          </button>
          <button type="button" className="fb-icon-btn" aria-label="Print" title="Print from this browser" onClick={() => print(row)}>
            <Printer size={15} />
          </button>
        </span>
      ),
    },
    { title: 'Submitted', dataIndex: 'createdAt', width: 150, render: (v: string) => format(new Date(v), 'dd MMM yyyy, HH:mm') },
    { title: 'v', dataIndex: 'formVersion', width: 50, align: 'center' },
    { title: 'Channel', dataIndex: 'channel', width: 90 },
    ...fields.map(
      (f): SmartTableColumn<SubmissionRow> => ({
        title: f.label || f.name,
        dataIndex: `payload.${f.name}`,
        render: (_: unknown, row) => {
          if (f.type === 'FILE') {
            const files = row.files.filter((x) => x.fieldName === f.name);
            return (
              <span className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
                {files.map((x) => (
                  <button key={x.uploadId} type="button" className="fb-link" onClick={() => openFile(row, x.uploadId)}>
                    {x.name}
                  </button>
                ))}
              </span>
            );
          }
          return def ? answer(def, f, row.payload[keyOf(def, f.name)]) : '';
        },
      }),
    ),
  ];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4" style={{ flexWrap: 'wrap' }}>
        <div className="flex items-center gap-3">
          <button type="button" className="fb-icon-btn" aria-label="Back to forms" onClick={onBack}>
            <ArrowLeft size={18} />
          </button>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold text-gray-900">Submissions</h1>
            <p className="text-sm text-muted-foreground">
              {def?.name ?? code} <span className="fb-code">{code}</span>
              {data ? ` · ${data.total} in total` : ''}
            </p>
          </div>
        </div>
        {submissionsAvailable && (
          <Button type="button" variant="outline" onClick={exportCsv} disabled={exporting || !data?.total}>
            <Download /> {exporting ? 'Exporting…' : 'Export CSV'}
          </Button>
        )}
      </div>

      {!submissionsAvailable ? (
        <p className="fb-muted">Submissions are stored by the server. This app is running on local storage only.</p>
      ) : (
        <>
          <SmartTable<SubmissionRow>
            data={data?.rows ?? []}
            columns={columns}
            loading={isLoading}
            rowKey="uuid"
            pagination={false}
            emptyText="No submissions yet."
          />
          {data && data.total > PAGE_SIZE && (
            <div className="flex items-center justify-end gap-3">
              <Button type="button" variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </Button>
              <span className="fb-muted">
                Page {page} of {Math.ceil(data.total / PAGE_SIZE)}
              </span>
              <Button type="button" variant="outline" size="sm" disabled={page * PAGE_SIZE >= data.total} onClick={() => setPage(page + 1)}>
                Next
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
