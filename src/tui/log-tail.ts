import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { oneLine, truncate } from './format.ts';

/**
 * Reads the end of a worker log (`~/.salu/logs/<project>/<ticket>-<run>.jsonl`, one Agent SDK
 * message per line) and turns it into short display lines in the claude transcript style:
 *
 *   ⏺ Read(src/auth.ts)
 *   ⏺ I fixed the null check in …
 *   ✓ done · 14 turns · $0.12
 *
 * Unknown shapes fall back to the raw line, so a log from `claude -p --output-format
 * stream-json` renders too. Cheap: reads at most `maxBytes` from the file's tail.
 */
export interface LogLine {
  kind: 'tool' | 'text' | 'result' | 'system' | 'error' | 'raw';
  text: string;
}

export function readTail(path: string, maxBytes = 64 * 1024): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    let s = buf.toString('utf8');
    if (start > 0) {
      const nl = s.indexOf('\n');
      s = nl >= 0 ? s.slice(nl + 1) : '';
    }
    return s;
  } catch {
    return '';
  } finally {
    if (fd != null) closeSync(fd);
  }
}

function shortInput(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const pick =
    input.file_path ?? input.path ?? input.command ?? input.pattern ?? input.query ?? input.url ?? input.description ?? input.prompt;
  if (typeof pick === 'string') return oneLine(pick);
  const keys = Object.keys(input);
  return keys.length ? keys.slice(0, 3).join(', ') : '';
}

/** Turn one JSON line into zero or more display lines. */
export function renderLogLine(line: string): LogLine[] {
  const trimmed = line.trim();
  if (!trimmed) return [];
  let msg: any;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return [{ kind: 'raw', text: oneLine(trimmed) }];
  }
  if (!msg || typeof msg !== 'object') return [{ kind: 'raw', text: oneLine(trimmed) }];
  const type = msg.type;
  if (type === 'assistant' || type === 'user') {
    if (msg.parent_tool_use_id) return []; // subagent chatter
    const content = msg.message?.content ?? msg.content;
    if (typeof content === 'string') return type === 'assistant' ? [{ kind: 'text', text: oneLine(content) }] : [];
    if (!Array.isArray(content)) return [];
    const out: LogLine[] = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && type === 'assistant' && block.text) out.push({ kind: 'text', text: oneLine(String(block.text)) });
      else if (block.type === 'tool_use') {
        const args = shortInput(block.name, block.input);
        out.push({ kind: 'tool', text: args ? `${block.name}(${args})` : String(block.name) });
      } else if (block.type === 'tool_result' && block.is_error) {
        const c = typeof block.content === 'string' ? block.content : Array.isArray(block.content) ? block.content.map((x: any) => x?.text ?? '').join(' ') : '';
        if (c) out.push({ kind: 'error', text: oneLine(c) });
      }
    }
    return out;
  }
  if (type === 'result') {
    const sub = msg.subtype ?? (msg.is_error ? 'error' : 'done');
    const parts = [String(sub)];
    if (msg.num_turns != null) parts.push(`${msg.num_turns} turns`);
    if (msg.total_cost_usd != null) parts.push(`$${Number(msg.total_cost_usd).toFixed(2)}`);
    const lines: LogLine[] = [];
    if (msg.is_error && typeof msg.result === 'string') lines.push({ kind: 'error', text: oneLine(msg.result) });
    else if (typeof msg.result === 'string' && msg.result) lines.push({ kind: 'text', text: oneLine(msg.result) });
    lines.push({ kind: msg.is_error ? 'error' : 'result', text: parts.join(' · ') });
    return lines;
  }
  if (type === 'system') {
    if (msg.subtype === 'init') return [{ kind: 'system', text: `session started${msg.model ? ` · ${msg.model}` : ''}` }];
    if (msg.subtype === 'api_retry') return [{ kind: 'system', text: `retrying API call${msg.attempt ? ` (${msg.attempt}/${msg.max_retries ?? '?'})` : ''}` }];
    return [];
  }
  if (type === 'ticket_start') {
    const o = msg.options ?? {};
    const bits = [o.model && String(o.model), o.effort && String(o.effort), o.maxTurns && `max ${o.maxTurns} turns`].filter(Boolean);
    return [{ kind: 'system', text: `${msg.resume ? 'resuming' : 'starting'}${bits.length ? ' · ' + bits.join(' · ') : ''}` }];
  }
  if (type === 'rate_limit_event') {
    const i = msg.rate_limit_info ?? {};
    if (i.status !== 'rejected') return [];
    return [{ kind: 'error', text: `usage limit (${i.rateLimitType ?? 'unknown'})` }];
  }
  if (type === 'stderr') return msg.text ? [{ kind: 'system', text: `stderr: ${oneLine(String(msg.text))}` }] : [];
  if (type === 'worker_error') return [{ kind: 'error', text: `worker error: ${oneLine(String(msg.error ?? ''))}` }];
  if (type === 'rate_limit' || type === 'api_retry') return [{ kind: 'system', text: oneLine(`${type}${msg.message ? ` · ${msg.message}` : ''}`) }];
  if (type === 'stream_event') return [];
  if (typeof msg.error === 'string') return [{ kind: 'error', text: oneLine(msg.error) }];
  return [{ kind: 'raw', text: truncate(oneLine(trimmed), 200) }];
}

/** The last `count` display lines of a log file. */
export function tailLog(path: string | null | undefined, count = 8): LogLine[] {
  if (!path) return [];
  const raw = readTail(path);
  if (!raw) return [];
  const out: LogLine[] = [];
  for (const line of raw.split('\n')) out.push(...renderLogLine(line));
  return out.slice(-count);
}
