import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminApi, unwrap, USE_API } from './backend';

export type ReviewStatus = 'NONE' | 'REQUESTED' | 'CHANGES_REQUESTED' | 'APPROVED';
interface Person {
  id: string;
  name: string;
}

export interface ReviewComment {
  id: string;
  /** The field it is about; empty for the form as a whole. */
  fieldId: string;
  fieldLabel: string;
  text: string;
  author: Person | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: Person | null;
}

/** Where a draft stands with its reviewers, and what the signed-in person may do about it. */
export interface ReviewState {
  /** The organisation publishes only what has been approved. */
  required: boolean;
  review: {
    status: ReviewStatus;
    requestedBy: Person | null;
    requestedAt: string | null;
    note: string;
    decidedBy: Person | null;
    decidedAt: string | null;
    decisionNote: string;
    /** Approved, but changed since. */
    stale: boolean;
  };
  comments: ReviewComment[];
  can: { request: boolean; decide: boolean; decideBlocked: string; comment: boolean };
}

const EMPTY: ReviewState = {
  required: false,
  review: { status: 'NONE', requestedBy: null, requestedAt: null, note: '', decidedBy: null, decidedAt: null, decisionNote: '', stale: false },
  comments: [],
  can: { request: false, decide: false, decideBlocked: '', comment: false },
};

/** Without the API (tests, local storage only) a test supplies the state. */
let local: ReviewState = EMPTY;
export const seedLocalReview = (state: Partial<ReviewState>) => {
  local = { ...EMPTY, ...state };
};
export const localReviewCalls: { path: string; body?: unknown }[] = [];

const key = (formId: string) => ['form-platform', 'review', formId] as const;

export function useFormReview(formId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: key(formId ?? ''),
    queryFn: async () => (USE_API ? unwrap<ReviewState>(await adminApi.get(`/forms/${encodeURIComponent(formId!)}/review`)) : local),
    enabled: enabled && !!formId,
  });
}

/** One action on a draft's review or comments; the server answers with the whole state, which replaces what is shown. */
export function useReviewAction(formId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ path, body, method = 'post' }: { path: string; body?: unknown; method?: 'post' | 'delete' }) => {
      if (!USE_API) {
        localReviewCalls.push({ path, body });
        return local;
      }
      const url = `/forms/${encodeURIComponent(formId)}/${path}`;
      return unwrap<ReviewState>(method === 'delete' ? await adminApi.delete(url) : await adminApi.post(url, body ?? {}));
    },
    onSuccess: (state) => {
      qc.setQueryData(key(formId), state);
      // The forms list shows who is waiting for a review.
      void qc.invalidateQueries({ queryKey: ['form-platform', 'forms'] });
    },
  });
}
