import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { toast } from 'sonner';
import type { FieldType, FormDefinition, FormField } from '../types';
import { descendantFields, FormDefinitionError, isContainerField } from '../engine';
import { useFormBuilderStore } from '../builder/store/useFormBuilderStore';
import { useCreateNewVersion, useFormDoc, useFormFamily, usePublishForm, useSaveFormDraft } from '../adapters/registry/useFormRegistry';
import { paletteItem } from '../builder/field-catalog';
import { fieldsReferencing } from '../builder/definition-edits';
import { publishIssues } from '../builder/publish-issues';
import { BuilderHeader } from '../builder/components/BuilderHeader';
import { FieldPalette } from '../builder/components/FieldPalette';
import { BuilderCanvas, type DropData } from '../builder/components/BuilderCanvas';
import { FieldConfigPanel } from '../builder/components/FieldConfigPanel';
import { FormSettingsPanel } from '../builder/components/FormSettingsPanel';
import { PreviewDialog } from '../builder/components/PreviewDialog';
import { WorkflowDialog } from '../builder/workflow/WorkflowDialog';
import { RulesDialog } from '../builder/rules/RulesDialog';
import { IssuesList } from '../builder/components/IssuesList';
import { ConfirmDialog, type ConfirmRequest } from '../builder/components/ConfirmDialog';
import { copyPublicFormLink } from '../links';
import { useAuth } from '../../lib/auth';
import '../styles/form-builder.css';

interface BuilderPageProps {
  formId: string | undefined;
  onBack: () => void;
  /** Switch the builder to another definition (e.g. a freshly created version). */
  onOpenForm: (id: string) => void;
}

type DragData = { source: 'palette'; type: FieldType } | { source: 'canvas'; id: string };

/**
 * Drop targets nest (a column inside a Columns card inside the canvas), so the
 * innermost target under the pointer must win: sort hits by area, smallest first.
 */
const innermostFirst: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  if (!hits.length) return rectIntersection(args);
  const area = (id: string | number) => {
    const r = args.droppableRects.get(id);
    return r ? r.width * r.height : Number.MAX_SAFE_INTEGER;
  };
  return [...hits].sort((a, b) => area(a.id) - area(b.id));
};

function errorMessage(e: unknown): string {
  if (e instanceof FormDefinitionError) {
    return e.issues
      .slice(0, 3)
      .map((i) => `${i.path}: ${i.message}`)
      .join('\n');
  }
  return e instanceof Error ? e.message : 'Something went wrong';
}

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export default function BuilderPage({ formId, onBack, onOpenForm }: BuilderPageProps) {
  const { data: doc, isLoading } = useFormDoc(formId);
  const loaded = doc?.definition;
  // The form's other versions (their workflow status keys must keep their meaning).
  const { data: family = [] } = useFormFamily(formId);
  const store = useFormBuilderStore();
  const { me } = useAuth();
  // Rights come from the form's folder (docs/plan.md, section 4).
  const permissions = { canDesign: !!doc?.permissions.includes('form.edit'), canPublish: !!doc?.permissions.includes('form.publish') };
  const { form, selectedFieldId, isDirty } = store;

  const save = useSaveFormDraft();
  const publish = usePublishForm();
  const newVersion = useCreateNewVersion();
  const busy = save.isPending || publish.isPending || newVersion.isPending;

  const [previewOpen, setPreviewOpen] = useState(false);
  const [workflowOpen, setWorkflowOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const [dragging, setDragging] = useState<DragData | null>(null);

  // Load into the store only when switching forms, so a refetch after saving
  // never clobbers edits made in the meantime.
  useEffect(() => {
    if (loaded && useFormBuilderStore.getState().form?.id !== loaded.id) store.load(loaded);
  }, [loaded, store]);

  useEffect(() => () => useFormBuilderStore.getState().reset(), []);

  const readOnly = !form || form.status !== 'DRAFT' || !permissions.canDesign;
  // The code is fixed once other versions exist.
  const codeLocked = family.length > 0;
  const issues = useMemo(() => (form ? publishIssues(form) : []), [form]);
  const selectedField = form?.fields.find((f) => f.id === selectedFieldId);

  const doSave = useCallback(async (): Promise<FormDefinition | null> => {
    const current = useFormBuilderStore.getState().form;
    if (!current) return null;
    try {
      const saved = await save.mutateAsync(current);
      if (saved) useFormBuilderStore.getState().markSaved(saved);
      return saved || null;
    } catch (e) {
      toast.error(`Couldn't save: ${errorMessage(e)}`);
      return null;
    }
  }, [save]);

  const onSave = async () => {
    if (await doSave()) toast.success('Draft saved');
  };

  const onPublish = () => {
    if (!form) return;
    if (issues.length) {
      setShowIssues(true);
      toast.error(`Fix ${issues.length === 1 ? 'the issue' : `${issues.length} issues`} before publishing`);
      return;
    }
    setConfirm({
      title: `Publish ${form.name} v${form.version}?`,
      description: (
        <>
          It goes live under the code <strong>{form.code}</strong>
          {form.version > 1 ? ' and replaces the currently published version' : ''}. A published version can't be edited -
          changes are made in a new version.
        </>
      ),
      confirmLabel: 'Publish',
      onConfirm: async () => {
        const saved = isDirty ? await doSave() : form;
        if (!saved) return;
        try {
          const published = await publish.mutateAsync(saved.id);
          if (published) store.load(published);
          toast.success(`Published ${form.code} v${form.version}`);
        } catch (e) {
          toast.error(`Couldn't publish: ${errorMessage(e)}`);
        }
      },
    });
  };

  const onNewVersion = async () => {
    if (!form) return;
    try {
      const draft = await newVersion.mutateAsync(form.id);
      if (draft) {
        toast.success(`Editing v${draft.version} (draft)`);
        onOpenForm(draft.id);
      }
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const onBackClick = () => {
    if (!isDirty) return onBack();
    setConfirm({
      title: 'Leave without saving?',
      description: 'Your unsaved changes to this form will be lost.',
      confirmLabel: 'Leave',
      destructive: true,
      onConfirm: onBack,
    });
  };

  const onRemove = (field: FormField) => {
    if (!form) return;
    const inside = isContainerField(field) ? descendantFields(form.fields, field.id) : [];
    if (inside.length) {
      setConfirm({
        title: `Delete this ${field.type === 'COLUMNS' ? 'Columns block' : 'section'}?`,
        description: `It contains ${inside.length} field${inside.length === 1 ? '' : 's'}. Keep them (they move out of the block) or delete them too?`,
        confirmLabel: 'Delete everything',
        destructive: true,
        onConfirm: () => store.removeField(field.id, false),
        secondary: { label: 'Keep the fields', onConfirm: () => store.removeField(field.id, true) },
      });
      return;
    }
    const dependents = fieldsReferencing(form, field.name);
    if (!dependents.length) return store.removeField(field.id);
    setConfirm({
      title: `Delete "${field.label || field.name}"?`,
      description: `Rules on ${dependents.map((d) => `"${d.label || d.name}"`).join(', ')} use this field and will need fixing before you can publish.`,
      confirmLabel: 'Delete',
      destructive: true,
      onConfirm: () => store.removeField(field.id),
    });
  };

  // Keyboard: Ctrl/Cmd+S saves; Ctrl/Cmd+Z / Shift+Z undo/redo when not typing in a box.
  useEffect(() => {
    if (readOnly) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      if (key === 's') {
        e.preventDefault();
        if (useFormBuilderStore.getState().isDirty) void doSave().then((ok) => ok && toast.success('Draft saved'));
      } else if (key === 'z' && !isTyping(e.target)) {
        e.preventDefault();
        if (e.shiftKey) useFormBuilderStore.getState().redo();
        else useFormBuilderStore.getState().undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [readOnly, doSave]);

  // Warn before closing the tab with unsaved work.
  useEffect(() => {
    if (!isDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [isDirty]);

  // A small movement threshold keeps clicks (select / add) separate from drags.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const onDragStart = (e: DragStartEvent) => setDragging((e.active.data.current as DragData) ?? null);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    if (!over || !form) return;
    const data = active.data.current as DragData | undefined;
    const place = over.data.current as DropData;
    if (data?.source === 'palette') store.addField(data.type, place);
    if (data?.source === 'canvas' && place.beforeId !== data.id) store.moveField(data.id, place);
  };

  if (!formId) return <p className="p-6 text-sm text-muted-foreground">No form selected.</p>;
  if (isLoading || (loaded && form?.id !== loaded.id)) return <p className="p-6 text-sm text-muted-foreground">Loading form…</p>;
  if (!loaded || !form) return <p className="p-6 text-sm text-muted-foreground">This form doesn't exist.</p>;

  const draggedField = dragging?.source === 'canvas' ? form.fields.find((f) => f.id === dragging.id) : undefined;
  const overlayLabel =
    dragging?.source === 'palette' ? paletteItem(dragging.type)?.label : draggedField ? draggedField.label || draggedField.name : undefined;

  return (
    <div className="fb-page">
      <BuilderHeader
        form={form}
        isDirty={isDirty}
        readOnly={readOnly}
        canUndo={store.past.length > 0}
        canRedo={store.future.length > 0}
        busy={busy}
        canDesign={permissions.canDesign}
        canPublish={permissions.canPublish}
        onBack={onBackClick}
        onUndo={store.undo}
        onRedo={store.redo}
        onPreview={() => setPreviewOpen(true)}
        onRules={() => setRulesOpen(true)}
        onWorkflow={() => setWorkflowOpen(true)}
        onSave={onSave}
        onPublish={onPublish}
        onNewVersion={onNewVersion}
        onCopyLink={() => copyPublicFormLink(me?.org.id ?? '', form.code)}
      />

      {readOnly && form.status === 'DRAFT' && (
        <div className="fb-banner">You can view this draft but not change it - editing needs a designer role on this form's folder.</div>
      )}
      {readOnly && form.status !== 'DRAFT' && (
        <div className="fb-banner">
          This is <strong>v{form.version}</strong> and it's {form.status.toLowerCase()}, so it can't be changed. Use{' '}
          <strong>Edit as new version</strong> to make changes. The published form keeps working until the new version is published.
        </div>
      )}

      <DndContext sensors={sensors} collisionDetection={innermostFirst} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setDragging(null)}>
        <div className="fb-workspace">
          <aside className="fb-column">{!readOnly && <FieldPalette fields={form.fields} onAdd={(type) => store.addField(type)} />}</aside>

          <main style={{ minWidth: 0 }}>
            <BuilderCanvas
              form={form}
              selectedFieldId={selectedFieldId}
              readOnly={readOnly}
              onSelectForm={() => store.selectField(undefined)}
              onSelect={store.selectField}
              onMove={store.moveSibling}
              onDuplicate={store.duplicateField}
              onRemove={onRemove}
            />
          </main>

          <aside className="fb-column fb-config fb-settings">
            {!readOnly && showIssues && <IssuesList issues={issues} onSelectField={store.selectField} />}
            {selectedField ? (
              <FieldConfigPanel
                field={selectedField}
                form={form}
                readOnly={readOnly}
                onChange={(changes) => store.updateField(selectedField.id, changes)}
                onFormChange={store.updateForm}
                onSetColumns={(weights) => store.setColumns(selectedField.id, weights)}
              />
            ) : (
              <FormSettingsPanel form={form} readOnly={readOnly} codeLocked={codeLocked} onChange={store.updateForm} />
            )}
          </aside>
        </div>

        <DragOverlay dropAnimation={null}>{overlayLabel ? <div className="fb-drag-overlay">{overlayLabel}</div> : null}</DragOverlay>
      </DndContext>

      <PreviewDialog form={form} open={previewOpen} onOpenChange={setPreviewOpen} />
      <RulesDialog form={form} readOnly={readOnly} open={rulesOpen} onOpenChange={setRulesOpen} onChange={store.updateForm} />
      <WorkflowDialog
        form={form}
        versions={family}
        readOnly={readOnly}
        open={workflowOpen}
        onOpenChange={setWorkflowOpen}
        onChange={store.updateForm}
      />
      <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
    </div>
  );
}
