import { useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@ui/dialog';
import type { FormDefinition, FormValues } from '../../types';
import { FormContainer } from '../../runtime/FormContainer/FormContainer';
import { createMockSubmissionAdapter } from '../../adapters/submission/submission-adapter';
import { monoBlock } from '../../runtime/styles';
import { useStyles } from '../../adapters/styles/style-master';
import { exampleAnswers, isRtl, languageName, languagesOf } from '../../engine';
import { Button } from '@ui/button';
import { SelectSetting } from './settings';

interface PreviewDialogProps {
  form: FormDefinition;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The builder's preview is the real runtime - same FormContainer the
 * published form uses - fed the unsaved definition, with the mock adapter.
 */
/** Preview never stores anything, even when the app talks to the API. */
const previewAdapter = createMockSubmissionAdapter({ delayMs: 150 });

export function PreviewDialog({ form, open, onOpenChange }: PreviewDialogProps) {
  const [payload, setPayload] = useState<FormValues | null>(null);
  const languages = languagesOf(form);
  const [language, setLanguage] = useState<string>();
  const shown = language && languages.includes(language) ? language : languages[0]!;
  const { data: styles } = useStyles();
  // Example answers: the form filled in as a careful person would, so its rules, totals and later steps can be seen
  // without typing. Each press starts the preview afresh with them (or empty again).
  const [example, setExample] = useState<{ values: FormValues; round: number }>();
  const [filling, setFilling] = useState(false);
  const fill = async () => {
    setFilling(true);
    try {
      const { values } = await exampleAnswers(form, { everything: true });
      setExample((was) => ({ values, round: (was?.round ?? 0) + 1 }));
      setPayload(null);
    } finally {
      setFilling(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setPayload(null);
        onOpenChange(next);
      }}
    >
      <DialogContent size="large" closeOnOutsideClick style={{ maxHeight: 'calc(100vh - 2rem)', overflowY: 'auto' }}>
        <DialogHeader>
          <DialogTitle>Preview</DialogTitle>
          <DialogDescription>Try the form as a respondent would. Nothing is saved - submissions show the payload below.</DialogDescription>
        </DialogHeader>
        {languages.length > 1 && (
          <div style={{ maxWidth: 260 }}>
            <SelectSetting label="Preview in" value={shown} options={languages.map((l) => ({ label: languageName(l), value: l }))} onChange={setLanguage} />
          </div>
        )}
        <div className="flex items-center gap-2" style={{ flexWrap: 'wrap' }}>
          <Button type="button" variant="outline" size="sm" disabled={filling} onClick={() => void fill()}>
            {filling ? 'Filling…' : 'Fill with example answers'}
          </Button>
          {example && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setExample(undefined)}>
              Empty it again
            </Button>
          )}
          <span className="fb-muted">Made-up answers of the right kind for each question. Files are left for you to add.</span>
        </div>
        {open && (
          <div dir={isRtl(shown) ? 'rtl' : 'ltr'} lang={shown}>
          <FormContainer
            key={example?.round ?? 0}
            initialValues={example?.values}
            definition={form}
            systemContext={{ language: shown }}
            captchaMode="mock"
            liveStyles={styles}
            submissionAdapter={previewAdapter}
            onSubmitted={(result) => setPayload(result.payload)}
            onNavigate={(url) => toast.info(`Would go to ${url}`)}
          />
          </div>
        )}
        {payload && (
          <div className="fb-settings" style={{ gap: 6 }}>
            <div className="fb-panel__title">Submitted payload</div>
            <pre className="rounded-md bg-gray-50 p-3" style={monoBlock}>
              {JSON.stringify(payload, null, 2)}
            </pre>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
