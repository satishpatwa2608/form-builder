import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { FormStyle } from '../../types';
import { formStyleSchema } from '../../engine';
import { adminApi, toFormError, unwrap, USE_API } from '../backend';

/**
 * The style master: named looks designers pick for fields, containers and
 * whole forms. Local until Phase 4 moves it to an org-scoped API collection
 * (like other masters). Published forms embed a snapshot of the styles they
 * use, so editing a style here only affects drafts and future publishes.
 */

export const PRESET_STYLES: FormStyle[] = [
  {
    id: 'highlight-box',
    name: 'Highlight box',
    description: 'Soft blue panel for important questions',
    props: { backgroundColor: '#eff6ff', borderColor: '#bfdbfe', borderWidth: 1, borderRadius: 10, padding: 16 },
  },
  {
    id: 'muted-note',
    name: 'Muted note',
    description: 'Small grey text for instructions',
    props: { textColor: '#6b7280', fontSize: 13 },
  },
  {
    id: 'brand-heading',
    name: 'Brand heading',
    description: 'Large, bold, brand-coloured',
    props: { textColor: '#1458e2', fontSize: 22, fontWeight: 700 },
  },
  {
    id: 'card',
    name: 'Card',
    description: 'White card with a subtle shadow',
    props: { backgroundColor: '#ffffff', borderColor: '#e5e7eb', borderWidth: 1, borderRadius: 12, padding: 20, shadow: 'md' },
  },
  {
    id: 'warning-panel',
    name: 'Warning panel',
    description: 'Amber panel for cautions',
    props: { backgroundColor: '#fffbeb', borderColor: '#fcd34d', borderWidth: 1, borderRadius: 8, padding: 14, labelColor: '#92400e' },
  },
];

interface StyleMasterState {
  styles: FormStyle[];
  upsert: (style: FormStyle) => void;
  remove: (id: string) => void;
}

const isValidStyle = (s: unknown): s is FormStyle => formStyleSchema.safeParse(s).success;

export const useStyleMaster = create<StyleMasterState>()(
  persist(
    (set, get) => ({
      styles: PRESET_STYLES,
      upsert: (style) =>
        set({
          styles: get().styles.some((s) => s.id === style.id)
            ? get().styles.map((s) => (s.id === style.id ? style : s))
            : [...get().styles, style],
        }),
      remove: (id) => set({ styles: get().styles.filter((s) => s.id !== id) }),
    }),
    {
      name: 'form-platform:styles',
      version: 1,
      storage: createJSONStorage(() => localStorage),
      merge: (stored, current) => {
        const styles = ((stored as Partial<StyleMasterState> | undefined)?.styles ?? current.styles).filter(isValidStyle);
        return { ...current, styles };
      },
    },
  ),
);

export const getStyles = (ids: string[]): FormStyle[] => {
  const all = useStyleMaster.getState().styles;
  return ids.map((id) => all.find((s) => s.id === id)).filter((s): s is FormStyle => !!s);
};

/** `Highlight box` -> `highlight-box`, unique among existing ids. */
export function styleIdFor(name: string, taken: string[]): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'style';
  let id = base;
  for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
  return id;
}

// ── Adapter + hooks (local store for tests/offline, API otherwise) ───────────

export interface StyleMasterAdapter {
  list(): Promise<FormStyle[]>;
  upsert(style: FormStyle): Promise<FormStyle>;
  remove(id: string): Promise<void>;
}

export const localStyleAdapter: StyleMasterAdapter = {
  async list() {
    return useStyleMaster.getState().styles;
  },
  async upsert(style) {
    useStyleMaster.getState().upsert(style);
    return style;
  },
  async remove(id) {
    useStyleMaster.getState().remove(id);
  },
};

export const httpStyleAdapter: StyleMasterAdapter = {
  async list() {
    return unwrap<FormStyle[]>(await adminApi.get('/styles'));
  },
  async upsert(style) {
    try {
      await adminApi.put(`/styles/${encodeURIComponent(style.id)}`, style);
      return style;
    } catch (e) {
      throw toFormError(e);
    }
  },
  async remove(id) {
    await adminApi.delete(`/styles/${encodeURIComponent(id)}`);
  },
};

export const styleAdapter: StyleMasterAdapter = USE_API ? httpStyleAdapter : localStyleAdapter;

const STYLES_KEY = ['form-platform', 'styles'] as const;

export function useStyles() {
  return useQuery({ queryKey: STYLES_KEY, queryFn: () => styleAdapter.list(), staleTime: 60_000 });
}

export function useSaveStyle() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (style: FormStyle) => styleAdapter.upsert(style), onSuccess: () => qc.invalidateQueries({ queryKey: STYLES_KEY }) });
}

export function useDeleteStyle() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => styleAdapter.remove(id), onSuccess: () => qc.invalidateQueries({ queryKey: STYLES_KEY }) });
}
