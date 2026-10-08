import { ArrowLeft, Eye, GitBranch, Link2, Redo2, Save, Send, Sigma, Undo2, Workflow } from 'lucide-react';
import { Button } from '@ui/button';
import type { FormDefinition } from '../../types';
import { FormStatusBadge } from './FormStatusBadge';

interface BuilderHeaderProps {
  form: FormDefinition;
  isDirty: boolean;
  readOnly: boolean;
  canUndo: boolean;
  canRedo: boolean;
  busy: boolean;
  canDesign: boolean;
  canPublish: boolean;
  onBack: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onPreview: () => void;
  onRules: () => void;
  onWorkflow: () => void;
  onSave: () => void;
  onPublish: () => void;
  onNewVersion: () => void;
  onCopyLink: () => void;
}

export function BuilderHeader(props: BuilderHeaderProps) {
  const { form, isDirty, readOnly, canUndo, canRedo, busy, canDesign, canPublish } = props;
  return (
    <header className="fb-header">
      <div className="fb-header__left">
        <button type="button" className="fb-icon-btn" aria-label="Back to forms" onClick={props.onBack}>
          <ArrowLeft size={18} />
        </button>
        <div style={{ minWidth: 0 }}>
          <div className="fb-header__title">{form.name}</div>
          <div className="fb-header__meta">
            <FormStatusBadge status={form.status} />
            <span>v{form.version}</span>
            <span className="fb-code">{form.code}</span>
            {!readOnly && <span>{isDirty ? '• Unsaved changes' : 'All changes saved'}</span>}
          </div>
        </div>
      </div>
      <div className="fb-header__actions">
        {!readOnly && (
          <>
            <button type="button" className="fb-icon-btn" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={props.onUndo}>
              <Undo2 size={16} />
            </button>
            <button type="button" className="fb-icon-btn" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={props.onRedo}>
              <Redo2 size={16} />
            </button>
          </>
        )}
        <Button type="button" variant="outline" onClick={props.onRules} title="Calculations and conditional behaviour">
          <Sigma /> Rules
          {!!(form.rules?.length || form.events?.length) && <span className="fb-chip">{(form.rules?.length ?? 0) + (form.events?.length ?? 0)}</span>}
        </Button>
        <Button type="button" variant="outline" onClick={props.onWorkflow} title="What happens after a submission">
          <Workflow /> Workflow
          {(form.workflow?.enabled || !!form.automations?.length) && <span className="fb-chip">On</span>}
        </Button>
        <Button type="button" variant="outline" onClick={props.onPreview}>
          <Eye /> Preview
        </Button>
        {form.status === 'PUBLISHED' && form.access === 'PUBLIC' && (
          <Button type="button" variant="outline" onClick={props.onCopyLink}>
            <Link2 /> Copy link
          </Button>
        )}
        {readOnly ? (
          form.status === 'DRAFT' ? (
            // A publisher who can't design still reviews and publishes drafts.
            canPublish && (
              <Button type="button" onClick={props.onPublish} disabled={busy}>
                <Send /> Publish
              </Button>
            )
          ) : (
            canDesign && (
              <Button type="button" onClick={props.onNewVersion} disabled={busy}>
                <GitBranch /> Edit as new version
              </Button>
            )
          )
        ) : (
          <>
            <Button type="button" variant="outline" onClick={props.onSave} disabled={busy || !isDirty} title="Save draft (Ctrl+S)">
              <Save /> Save draft
            </Button>
            {canPublish && (
              <Button type="button" onClick={props.onPublish} disabled={busy}>
                <Send /> Publish
              </Button>
            )}
          </>
        )}
      </div>
    </header>
  );
}
