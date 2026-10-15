import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * What one request (or the job it queued) is about, carried through everything it calls without being passed by
 * hand: the request ID, written on every log line and sent on to the jobs, gateway calls and extension calls it
 * makes, so one response can be followed end to end.
 */
export interface RequestContext {
  requestId: string;
  /** Set once the caller is known. */
  orgId?: string;
}

const store = new AsyncLocalStorage<RequestContext>();

/** An ID a caller (a load balancer, another service) passed in, when it looks like one. */
const GIVEN = /^[A-Za-z0-9._:-]{8,100}$/;

export const newRequestId = (given?: unknown): string => (typeof given === 'string' && GIVEN.test(given) ? given : randomUUID());

/** Runs `fn` as part of the request with this ID. */
export const withRequest = <T>(context: RequestContext, fn: () => T): T => store.run(context, fn);

export const currentRequest = (): RequestContext | undefined => store.getStore();

export const currentRequestId = (): string | undefined => store.getStore()?.requestId;

/** Notes who the caller is, once authentication has found out. */
export const noteOrg = (orgId: string) => {
  const context = store.getStore();
  if (context) context.orgId = orgId;
};
