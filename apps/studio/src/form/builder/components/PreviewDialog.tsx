import { useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@ui/dialog';
import type { FormDefinition, FormValues } from '../../types';
import { FormContainer } from '../../runtime/FormContainer/FormContainer';
import { createMockSubmissionAdapter } from '../../adapters/submission/submission-adapter';
import { monoBlock } from '../../runtime/styles';
import { useStyles } from '../../adapters/styles/style-master';
import { isRtl, languageName, languagesOf } from '../../engine';
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
        {open && (
          <div dir={isRtl(shown) ? 'rtl' : 'ltr'} lang={shown}>
          <FormContainer
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
