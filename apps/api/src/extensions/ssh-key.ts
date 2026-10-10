import { generateKeyPairSync, randomBytes } from 'node:crypto';

const str = (b: Buffer | string) => {
  const data = typeof b === 'string' ? Buffer.from(b) : b;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, data]);
};

/**
 * A new ed25519 key pair in the form `ssh` and git hosts use: the one-line public key to add to a repository,
 * and the private key file (OpenSSH's own format, unencrypted: it is sealed before it is stored).
 */
export function newSshKey(comment: string): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const seed = Buffer.from(privateKey.export({ format: 'jwk' }).d!, 'base64url');
  const blob = Buffer.concat([str('ssh-ed25519'), str(pub)]);
  const check = randomBytes(4);
  let inner = Buffer.concat([check, check, str('ssh-ed25519'), str(pub), str(Buffer.concat([seed, pub])), str(comment)]);
  // Padded to the cipher's block size (8 for "none") with 1, 2, 3, …
  for (let i = 1; inner.length % 8; i++) inner = Buffer.concat([inner, Buffer.from([i])]);
  const one = Buffer.alloc(4);
  one.writeUInt32BE(1);
  const file = Buffer.concat([Buffer.from('openssh-key-v1\0'), str('none'), str('none'), str(''), one, str(blob), str(inner)]);
  const body = file.toString('base64').replace(/(.{70})/g, '$1\n').trimEnd();
  return { publicKey: `ssh-ed25519 ${blob.toString('base64')} ${comment}`, privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n` };
}
