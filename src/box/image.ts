/** Did the kernel image recipe change since this box last built it? (`salu kernel setup --if-changed`) */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DOCKERFILE } from '../core/container.ts';
import { ticketHome } from '../core/paths.ts';

export const imageStampFile = () => join(ticketHome(), 'kernel-image.sha');
export const imageStamp = () => createHash('sha256').update(DOCKERFILE).digest('hex').slice(0, 16);

export function imageStampChanged(): boolean {
  try {
    return !existsSync(imageStampFile()) || readFileSync(imageStampFile(), 'utf8').trim() !== imageStamp();
  } catch {
    return true;
  }
}

export function saveImageStamp(): void {
  mkdirSync(ticketHome(), { recursive: true });
  writeFileSync(imageStampFile(), imageStamp() + '\n');
}
