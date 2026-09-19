import { cpSync } from 'node:fs';

export function copySyncSafe(from, to) {
  cpSync(from, to, { recursive: true });
}
