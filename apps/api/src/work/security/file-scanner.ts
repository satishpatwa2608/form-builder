import { connect } from 'node:net';

export const FILE_SCANNER = Symbol('FILE_SCANNER');

export type ScanVerdict = { clean: true } | { clean: false; threat: string };

/**
 * Checks an uploaded file for malware before it can be attached to a
 * submission. A scanner that cannot give an answer throws: the caller then
 * refuses the file rather than letting it through unchecked.
 */
export interface FileScanner {
  /** Shown in logs and kept on the upload: which scanner cleared it. */
  readonly name: string;
  scan(file: Buffer): Promise<ScanVerdict>;
}

/** No scanner configured: every file passes. Development, or a deployment that scans elsewhere. */
export class NoFileScanner implements FileScanner {
  readonly name = 'none';
  async scan(): Promise<ScanVerdict> {
    return { clean: true };
  }
}

const CHUNK = 64 * 1024;

/**
 * ClamAV over its network protocol (clamd INSTREAM): the file is streamed to
 * the daemon in length-prefixed chunks and it answers `stream: OK` or
 * `stream: <signature> FOUND`. Nothing is written to the scanner's disk.
 */
export class ClamAvScanner implements FileScanner {
  readonly name = 'clamav';

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly timeoutMs = 30_000,
  ) {}

  scan(file: Buffer): Promise<ScanVerdict> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      let reply = '';
      let settled = false;
      const finish = (act: () => void) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        act();
      };
      socket.setTimeout(this.timeoutMs, () => finish(() => reject(new Error('The virus scanner did not answer in time'))));
      socket.on('error', (e) => finish(() => reject(new Error(`The virus scanner could not be reached: ${e.message}`))));
      socket.on('data', (chunk) => {
        reply += chunk.toString('utf8');
        // A reply past any sensible length is not clamd.
        if (reply.length > 4096) finish(() => reject(new Error('The virus scanner gave an unreadable answer')));
      });
      socket.on('close', () =>
        finish(() => {
          const answer = reply.replace(/\0/g, '').trim();
          const found = /^stream: (.+) FOUND$/.exec(answer);
          if (answer === 'stream: OK') resolve({ clean: true });
          else if (found) resolve({ clean: false, threat: found[1].slice(0, 200) });
          else reject(new Error(`The virus scanner gave an unreadable answer${answer ? `: ${answer.slice(0, 120)}` : ''}`));
        }),
      );
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        for (let at = 0; at < file.length; at += CHUNK) {
          const part = file.subarray(at, at + CHUNK);
          const size = Buffer.alloc(4);
          size.writeUInt32BE(part.length);
          socket.write(size);
          socket.write(part);
        }
        // A zero-length chunk ends the stream.
        socket.write(Buffer.alloc(4));
      });
    });
  }
}
