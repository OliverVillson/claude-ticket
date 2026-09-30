import { style as st } from './style.ts';
import { paint } from './theme.ts';

/** A short-lived note shown in the footer after an action ("added …", "paused …"). */
export interface Message {
  text: string;
  tone: 'ok' | 'err' | 'info';
}

export function messageText(m: Message): string {
  if (m.tone === 'ok') return paint(st, 'green', '✓ ' + m.text);
  if (m.tone === 'err') return paint(st, 'red', '✗ ' + m.text);
  return paint(st, 'accent', '· ' + m.text);
}
