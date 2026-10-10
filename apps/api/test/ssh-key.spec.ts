import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newSshKey } from '../src/extensions/ssh-key';

describe('The key an organisation adds to its repository', () => {
  it('is a pair ssh itself reads: the private file gives back the public line', () => {
    if (spawnSync('ssh-keygen', ['-?']).error) return; // No ssh tools on this machine.
    const dir = mkdtempSync(join(tmpdir(), 'fbkey-'));
    try {
      const key = newSshKey('form-builder');
      const file = join(dir, 'id');
      writeFileSync(file, key.privateKey, { mode: 0o600 });
      const derived = execFileSync('ssh-keygen', ['-y', '-f', file], { encoding: 'utf8' }).trim();
      expect(derived.split(' ').slice(0, 2)).toEqual(key.publicKey.split(' ').slice(0, 2));
      expect(key.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/=]+ form-builder$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is different every time', () => {
    expect(newSshKey('a').publicKey).not.toBe(newSshKey('a').publicKey);
  });
});
