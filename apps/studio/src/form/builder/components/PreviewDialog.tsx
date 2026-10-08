import { useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@ui/dialog';
import type { FormDefinition, FormValues } from '../../types';
import { FormContainer } from '../../runtime/FormContainer/FormContainer';
import { createMockSubmissionAdapter } from '../../adapters/submission/submission-adapter';
import { monoBlock } from '../../runtime/styles';
import { useStyles } from '../../adapters/styles/style-master';

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
        {open && (
          <FormContainer
            definition={form}
            captchaMode="mock"
            liveStyles={styles}
            submissionAdapter={previewAdapter}
            onSubmitted={(result) => setPayload(result.payload)}
            onNavigate={(url) => toast.info(`Would go to ${url}`)}
          />
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
