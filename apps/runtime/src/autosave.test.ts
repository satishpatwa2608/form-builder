import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAutosave } from './autosave';

function memory() {
  const kept = new Map<string, string>();
  return { kept, getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('answers that save themselves', () => {
  it('many changes in a row are one save, of the latest answers', async () => {
    const save = vi.fn(async () => ({ token: 't1' }));
    const storage = memory();
    const auto = createAutosave({ key: 'k', save, storage, everyMs: 1000 });
    auto.changed({ name: 'A' });
    auto.changed({ name: 'As' });
    auto.changed({ name: 'Asha' });
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ name: 'Asha' }, undefined);
    expect(storage.kept.get('k')).toBe('t1');
    // Nothing changed since: nothing more is sent.
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('each save hands back the last token, so the server keeps one draft, not a trail of them', async () => {
    let n = 0;
    const save = vi.fn(async (_values: unknown, _token: string | undefined) => ({ token: `t${++n}` }));
    const auto = createAutosave({ key: 'k', save, storage: memory(), everyMs: 1000 });
    auto.changed({ a: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    auto.changed({ a: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(save.mock.calls.map((c) => c[1])).toEqual([undefined, 't1']);
    expect(auto.token()).toBe('t2');
  });

  it('a save that fails is tried again with the next tick, and never throws at the person', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ token: 't1' });
    const auto = createAutosave({ key: 'k', save, storage: memory(), everyMs: 1000 });
    auto.changed({ a: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(auto.token()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ a: 1 }, undefined);
    expect(auto.token()).toBe('t1');
  });

  it('answers changed while a save is on its way go with the next one', async () => {
    let finish: (v: { token: string }) => void = () => undefined;
    const save = vi.fn().mockImplementationOnce(() => new Promise<{ token: string }>((r) => (finish = r))).mockResolvedValue({ token: 't2' });
    const auto = createAutosave({ key: 'k', save, storage: memory(), everyMs: 1000 });
    auto.changed({ a: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    auto.changed({ a: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    finish({ token: 't1' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenLastCalledWith({ a: 2 }, 't1');
  });

  it('leaving the page sends what is waiting at once', async () => {
    const save = vi.fn(async () => ({ token: 't1' }));
    const auto = createAutosave({ key: 'k', save, storage: memory(), everyMs: 60_000 });
    auto.changed({ a: 1 });
    await auto.flush();
    expect(save).toHaveBeenCalledWith({ a: 1 }, undefined);
  });

  it('once submitted (or started again) the device forgets the draft and nothing more is saved', async () => {
    const save = vi.fn(async () => ({ token: 't1' }));
    const storage = memory();
    storage.kept.set('k', 'old');
    const auto = createAutosave({ key: 'k', save, storage, everyMs: 1000 });
    expect(auto.token()).toBe('old');
    auto.changed({ a: 1 });
    auto.forget();
    auto.changed({ a: 2 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(save).not.toHaveBeenCalled();
    expect(storage.kept.has('k')).toBe(false);
  });

  it('a browser with no storage still saves; it just cannot find the answers again by itself', async () => {
    const save = vi.fn(async () => ({ token: 't1' }));
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => { throw new Error('denied'); } };
    const auto = createAutosave({ key: 'k', save, storage: broken, everyMs: 1000 });
    auto.changed({ a: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(auto.token()).toBeUndefined();
    expect(() => auto.forget()).not.toThrow();
  });
});
