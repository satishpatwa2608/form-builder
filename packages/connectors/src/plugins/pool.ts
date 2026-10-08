import { createHash } from 'node:crypto';

/**
 * Connections reused per connector + credentials (a changed password gets a
 * new connection). Idle ones are closed; at most `max` are kept.
 */
export class ConnectionPool<T> {
  private readonly items = new Map<string, { conn: Promise<T>; at: number }>();

  constructor(
    private readonly close: (conn: T) => Promise<void>,
    private readonly max = 20,
    private readonly idleMs = 5 * 60_000,
  ) {}

  static key(connectorId: string, secret: unknown) {
    return `${connectorId}:${createHash('sha256').update(JSON.stringify(secret)).digest('hex').slice(0, 16)}`;
  }

  async get(key: string, make: () => Promise<T>): Promise<T> {
    this.sweep();
    const hit = this.items.get(key);
    if (hit) {
      hit.at = Date.now();
      return hit.conn;
    }
    const conn = make().catch((e) => {
      this.items.delete(key);
      throw e;
    });
    this.items.set(key, { conn, at: Date.now() });
    if (this.items.size > this.max) {
      const oldest = [...this.items.entries()].sort((a, b) => a[1].at - b[1].at)[0]!;
      this.items.delete(oldest[0]);
      void oldest[1].conn.then(this.close).catch(() => undefined);
    }
    return conn;
  }

  private sweep() {
    const cutoff = Date.now() - this.idleMs;
    for (const [k, v] of this.items) {
      if (v.at < cutoff) {
        this.items.delete(k);
        void v.conn.then(this.close).catch(() => undefined);
      }
    }
  }

  async closeAll() {
    const all = [...this.items.values()];
    this.items.clear();
    await Promise.all(all.map((v) => v.conn.then(this.close).catch(() => undefined)));
  }
}
