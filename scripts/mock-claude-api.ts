// A stand-in for the Anthropic Messages API, so the REAL Claude Code (and its OS sandbox: Seatbelt on macOS,
// bubblewrap on Linux) can be driven with no login and no model. It reads the numbered attempts out of the
// sandbox-check ticket and answers each turn with the next one as a tool call, so the fence is tested for real.
// Used by scripts/fence-test.ts; point Claude Code at it with ANTHROPIC_BASE_URL and a dummy ANTHROPIC_API_KEY.

type Call = { name: string; input: Record<string, unknown> };

/** "1. With the Bash tool run: cat X" -> { Bash, {command} }; Read and Write the same way. */
export function attemptsFrom(text: string): Call[] {
  const calls: Call[] = [];
  for (const line of text.split('\n')) {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^\d+\. With the Bash tool run: (.+)$/))) calls.push({ name: 'Bash', input: { command: m[1], description: 'sandbox self-test' } });
    else if ((m = line.match(/^\d+\. With the Read tool read the file (.+)$/))) calls.push({ name: 'Read', input: { file_path: m[1] } });
    else if ((m = line.match(/^\d+\. With the Write tool write the text "(.*)" to (.+)$/))) calls.push({ name: 'Write', input: { file_path: m[2], content: m[1] } });
  }
  return calls;
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

function stream(model: string, id: string, block: { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }): string {
  const usage = { input_tokens: 10, output_tokens: 5 };
  let out = sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } });
  if (block.type === 'text') {
    out += sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    out += sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } });
  } else {
    out += sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } });
    out += sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
  }
  out += sse('content_block_stop', { type: 'content_block_stop', index: 0 });
  out += sse('message_delta', { type: 'message_delta', delta: { stop_reason: block.type === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } });
  out += sse('message_stop', { type: 'message_stop' });
  return out;
}

const textOf = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b: any) => (b?.type === 'text' ? b.text : '')).join('\n') : '');

/** Positive control: only a command that really ran inside the sandbox, with a write in its own folder allowed, prints this. */
export const CONTROL_COMMAND = 'echo SALU-WROTE-$((6*7)) > ./fence-control.txt && cat ./fence-control.txt';
export const CONTROL_OUTPUT = 'SALU-WROTE-42';

export function startMockApi(): { url: string; stop: () => void; requests: () => number } {
  let seen = 0;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (path.endsWith('/count_tokens')) return Response.json({ input_tokens: 10 });
      if (!path.endsWith('/messages')) return Response.json({});
      seen++;
      const body: any = await req.json().catch(() => ({}));
      const model = String(body.model ?? 'mock');
      const msgs: any[] = body.messages ?? [];
      const first = msgs.find((m) => m.role === 'user');
      const attempts = attemptsFrom(textOf(first?.content));
      const plan = attempts.length ? [{ name: 'Bash', input: { command: CONTROL_COMMAND, description: 'sandbox control' } }, ...attempts] : [];
      const done = msgs.reduce((n, m) => n + (Array.isArray(m.content) ? m.content.filter((b: any) => b?.type === 'tool_result').length : 0), 0);
      const mainTurn = Array.isArray(body.tools) && body.tools.length > 0 && plan.length > 0;
      let block: Parameters<typeof stream>[2];
      if (mainTurn && done < plan.length) block = { type: 'tool_use', id: `toolu_mock_${done + 1}`, name: plan[done]!.name, input: plan[done]!.input };
      else if (mainTurn) block = { type: 'text', text: attempts.map((_, i) => `ATTEMPT ${i + 1}: refused`).join('\n') + '\nTICKET: done' };
      else block = { type: 'text', text: 'ok' }; // title generation and other side calls
      const id = `msg_mock_${seen}`;
      if (body.stream) return new Response(stream(model, id, block), { headers: { 'content-type': 'text/event-stream' } });
      return Response.json({ id, type: 'message', role: 'assistant', model, content: [block.type === 'text' ? block : { type: 'tool_use', id: block.id, name: block.name, input: block.input }], stop_reason: block.type === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), requests: () => seen };
}
