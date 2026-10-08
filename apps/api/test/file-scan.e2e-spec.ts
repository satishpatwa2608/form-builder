import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClamAvScanner } from '../src/work/security/file-scanner';
import { startApp, type Harness } from './harness';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/**
 * A stand-in for the clamd daemon: reads an INSTREAM request, hands the bytes
 * it was sent to `judge`, and answers with what that returns.
 */
function fakeClamd(judge: (file: Buffer) => string | null) {
  const received: Buffer[] = [];
  const server: Server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let answered = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const start = buffer.indexOf('zINSTREAM\0');
      if (start !== 0 || answered) return;
      let at = 'zINSTREAM\0'.length;
      const parts: Buffer[] = [];
      while (buffer.length >= at + 4) {
        const size = buffer.readUInt32BE(at);
        if (size === 0) {
          answered = true;
          const file = Buffer.concat(parts);
          received.push(file);
          const reply = judge(file);
          if (reply === null) return; // never answers
          socket.end(`${reply}\0`);
          return;
        }
        if (buffer.length < at + 4 + size) return;
        parts.push(buffer.subarray(at + 4, at + 4 + size));
        at += 4 + size;
      }
    });
    socket.on('error', () => undefined);
  });
  return new Promise<{ port: number; received: Buffer[]; close: () => Promise<void> }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ port: (server.address() as AddressInfo).port, received, close: () => new Promise<void>((done) => server.close(() => done())) }),
    ),
  );
}

describe('ClamAV client', () => {
  it('streams the whole file and reads a clean answer', async () => {
    const clamd = await fakeClamd(() => 'stream: OK');
    const big = Buffer.alloc(200_000, 7);
    expect(await new ClamAvScanner('127.0.0.1', clamd.port).scan(big)).toEqual({ clean: true });
    expect(Buffer.compare(clamd.received[0], big)).toBe(0);
    await clamd.close();
  });

  it('reads what was found', async () => {
    const clamd = await fakeClamd(() => 'stream: Win.Test.EICAR_HDB-1 FOUND');
    expect(await new ClamAvScanner('127.0.0.1', clamd.port).scan(Buffer.from('x'))).toEqual({ clean: false, threat: 'Win.Test.EICAR_HDB-1' });
    await clamd.close();
  });

  it('fails, rather than passing the file, when the scanner is down, silent or talks nonsense', async () => {
    const down = await fakeClamd(() => 'stream: OK');
    await down.close();
    await expect(new ClamAvScanner('127.0.0.1', down.port).scan(Buffer.from('x'))).rejects.toThrow(/could not be reached/);

    const silent = await fakeClamd(() => null);
    await expect(new ClamAvScanner('127.0.0.1', silent.port, 150).scan(Buffer.from('x'))).rejects.toThrow(/did not answer in time/);
    await silent.close();

    const odd = await fakeClamd(() => 'INSTREAM size limit exceeded. ERROR');
    await expect(new ClamAvScanner('127.0.0.1', odd.port).scan(Buffer.from('x'))).rejects.toThrow(/unreadable answer/);
    await odd.close();
  });
});

describe('Uploads are scanned before they can be attached (e2e)', () => {
  let h: Harness;
  let dir: string;
  let orgId: string;
  let clamd: Awaited<ReturnType<typeof fakeClamd>>;
  let answer: string | null = 'stream: OK';

  const form = {
    name: 'Claim',
    code: 'CLAIM',
    businessId: '',
    access: 'PUBLIC',
    submission: { method: 'POST', endpointId: 'default-submit' },
    fields: [
      { id: 'a', type: 'TEXT', name: 'who', label: 'Who', required: true },
      { id: 'b', type: 'FILE', name: 'receipt', label: 'Receipt', props: { accept: ['image/*'], maxSizeMB: 1 }, validation: { max: 2 } },
    ],
    rules: [{ id: 'r', when: { expr: 'who == "auditor" && length(receipt) < 1' }, then: [{ type: 'ERROR', target: 'receipt', message: 'An auditor must attach a receipt' }] }],
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fb-scan-'));
    clamd = await fakeClamd(() => answer);
    h = await startApp({ LOCAL_STORAGE_DIR: dir, FILE_SCANNER: 'clamav', CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(clamd.port) });
    await h.signUp('Asha', 'asha@acme.test', 'Acme');
    const owner = (await h.login('asha@acme.test')).token;
    orgId = (await h.api().get('/auth/me').set(h.bearer(owner))).body.org.id;
    const folder = (await h.api().post('/folders').set(h.bearer(owner)).send({ name: 'Claims' }).expect(201)).body[0].id;
    const id = (await h.api().post('/forms').set(h.bearer(owner)).send({ folderId: folder, definition: form }).expect(201)).body.definition.id;
    await h.api().post(`/forms/${id}/publish`).set(h.bearer(owner)).expect(200);
  });
  afterAll(async () => {
    await h?.close();
    await clamd?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const upload = async () => {
    const ticket = (await h.api().post(`/public/forms/CLAIM/uploads?org=${orgId}`).send({ fieldName: 'receipt', fileName: 'receipt.png', contentType: 'image/png', size: PNG.length }).expect(201)).body;
    await h.api().put(h.localUrl(ticket.url).replace(h.base, '')).set('Content-Type', 'image/png').send(PNG).expect(200);
    return ticket.uploadId as string;
  };
  const verify = (id: string) => h.api().post(`/public/uploads/${id}/verify?org=${orgId}`);
  const submit = (values: object) => h.api().post(`/public/forms/CLAIM/submissions?org=${orgId}`).send({ values });

  it('a clean file is verified, scanned whole, and can be attached', async () => {
    answer = 'stream: OK';
    const id = await upload();
    await verify(id).expect(200);
    expect(Buffer.compare(clamd.received.at(-1)!, PNG)).toBe(0);
    await submit({ who: 'Asha', receipt: [{ uploadId: id }] }).expect(201);
  });

  it('an infected file is blocked, removed, and cannot be attached', async () => {
    answer = 'stream: Win.Test.EICAR_HDB-1 FOUND';
    const id = await upload();
    const res = await verify(id).expect(422);
    expect(res.body.message).toBe('This file was blocked because it may be harmful');
    await verify(id).expect(422); // stays rejected
    await submit({ who: 'Asha', receipt: [{ uploadId: id }] }).expect(400);
  });

  it('a file the scanner could not check is not let through, and can be tried again', async () => {
    answer = 'something clamd would never say';
    const id = await upload();
    await verify(id).expect(503);
    await submit({ who: 'Asha', receipt: [{ uploadId: id }] }).expect(400);
    answer = 'stream: OK';
    await verify(id).expect(200);
    await submit({ who: 'Asha', receipt: [{ uploadId: id }] }).expect(201);
  });

  it('a rule can require an attachment', async () => {
    const res = await submit({ who: 'auditor' }).expect(422);
    expect(res.body.errors).toEqual([{ field: 'receipt', message: 'An auditor must attach a receipt' }]);
  });
});
