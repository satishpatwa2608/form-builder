import { stopStack } from './stack';

export default async function globalTeardown() {
  stopStack();
  // Give the processes a moment to exit and the temporary directory to be removed.
  await new Promise((r) => setTimeout(r, 2000));
}
