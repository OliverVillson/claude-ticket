# Control channel contract (easy install and project setup)

Status: draft, agreed by the build pieces before code. Plan: the Claude Doc "Salu easy install and project
setup plan". Change this file in a PR of its own, so every piece sees it.

The Mac and a salu box talk through one private GitHub repo, the **control repo** (`<user>/salu-control`).
ssh is used only once, to pair. Same style as `src/sync/format.ts`: write-once files, unique names, no
conflicts, 64 KiB max per file.

## Layout of the control repo (default branch)

```
boxes/<box>/commands/<id>.json   Mac -> box   a signed command
boxes/<box>/replies/<id>.json    box -> Mac   a signed answer to one command (id = the command's id)
boxes/<box>/heartbeat.json       box -> Mac   rewritten every 60 s: version, disk, tickets, time
```

`<box>` is `[a-z0-9-]{1,32}`, chosen at pairing (default: the host name). Ids are `newId()` from
`src/sync/format.ts`.

## Keys (all made at pairing, stored in `/var/lib/salu/box/` on the box and `~/.salu/boxes/<box>.json` on the Mac, mode 0600)

| Key | Made by | Purpose |
| --- | --- | --- |
| `deploy` (ed25519 ssh) | box | write deploy key of the control repo; public half goes to the Mac |
| `seal` (X25519) | box | the Mac encrypts secrets to its public half; the private half never leaves the box |
| `mac` (HMAC-SHA256, 32 bytes) | Mac | signs commands; the box keeps a copy |
| `box` (HMAC-SHA256, 32 bytes) | box | signs replies and the heartbeat; the Mac keeps a copy |

The two HMAC secrets cross over the pairing ssh session, never through git.

## Messages

Every file is JSON with this envelope; `sig` is the HMAC-SHA256 hex of the canonical JSON of the object without `sig`
(keys sorted, no spaces).

```jsonc
{ "v": 1, "id": "<id>", "box": "<box>", "verb": "project.create", "at": 1759413000000,
  "args": { ... }, "sealed": { "<field>": "<base64 sealed box>" }, "sig": "<hex>" }
```

Replay: the box remembers handled ids (`/var/lib/salu/box/handled`) and ignores a repeat. Commands older than
24 h are ignored. Unknown verb, bad signature or bad args: a reply with `ok:false`, never a crash.

`sealed` holds fields encrypted with libsodium-style `crypto_box_seal` semantics (X25519 + XSalsa20-Poly1305, or the
node:crypto equivalent: ephemeral X25519 key + HKDF + AES-256-GCM, format `epk(32) | iv(12) | tag(16) | ct`). The
pieces use the one implementation in `src/control/seal.ts`.

### Verbs (a fixed allowlist; a verb never carries a shell string)

| verb | args | sealed | effect on the box |
| --- | --- | --- | --- |
| `ping` | none | none | reply `ok:true` with version |
| `status` | none | none | reply with `salu doctor --sandbox` summary lines, tickets, disk |
| `login.set` | `kind: "subscription"` | `token` | stores the one box login, used by every runner project and the kernel proxy |
| `project.create` | `name`, `repo` (ssh url), `concurrency?` | `deployKey` (private ssh key of the project repo), `signingKey` | clone, runner add with the box login, signing key set, host key of github.com trusted, service started |
| `project.remove` | `name`, `purge?` | none | runner remove |
| `update` | `version?` (default latest release) | none | install the release, rebuild the kernel image only if its version changed |

Reply: `{ "v":1, "id":"<command id>", "box":"<box>", "ok":true|false, "message":"<one line for a person>", "data":{...}, "at":..., "sig":"..." }`.
`message` on failure says what to do next, in plain words (no stack traces).

## Modules and functions (so pieces can code in parallel)

`src/control/` is owned by piece 1. Signatures are fixed here.

```ts
// seal.ts
export function sealTo(boxPublicKey: Buffer, plaintext: Buffer): string;       // base64
export function openSealed(boxPrivateKey: Buffer, sealed: string): Buffer;
// message.ts
export type Verb = 'ping'|'status'|'login.set'|'project.create'|'project.remove'|'update';
export function signMessage(m: Omit<Msg,'sig'>, key: Buffer): Msg;
export function verifyMessage(m: Msg, key: Buffer): boolean;
// transport.ts   (git, with a local-bare-repo implementation for tests)
export interface ControlTransport {
  put(path: string, body: string): Promise<void>;            // write-once, retries on push race
  list(dir: string): Promise<string[]>;
  get(path: string): Promise<string | undefined>;
}
export function gitTransport(opts: { url: string; sshKey?: string; dir: string }): ControlTransport;
// watcher.ts  (box side)
export function runWatcher(t: ControlTransport, h: Handlers, o: { box: string; macKey: Buffer; boxKey: Buffer; sealKey: Buffer; intervalMs?: number }): { stop(): void };
export type Handlers = Record<Verb, (a: { args: any; secret(field: string): Buffer }) => Promise<{ ok: boolean; message: string; data?: unknown }>>;
// client.ts   (Mac side)
export function sendCommand(t: ControlTransport, cfg: BoxConfig, verb: Verb, args: object, secrets?: Record<string, Buffer>): Promise<string>; // returns the id
export function waitReply(t: ControlTransport, cfg: BoxConfig, id: string, o?: { timeoutMs?: number }): Promise<Reply>;
```

Handlers for the verbs live in `src/box/handlers/*.ts` (piece 3). The Mac commands live in
`src/cli/commands/box.ts` and `new.ts` (piece 4).

## Pairing session (`salu box add <user@host> [--name box]`)

1. Mac: `ssh -t user@host`, runs the installer from the release (piece 2), which ends with `salu box init --json`.
2. `salu box init --json` (on the box) creates the keys above and prints `{ "box", "deployPub", "sealPub", "boxKey", "version" }` on one line.
3. Mac: `gh repo create <user>/salu-control --private` (if missing), adds `deployPub` as a write deploy key, generates `mac` key.
4. Mac sends over the same ssh session: `salu box connect --url <repo> --mac-key -` (key on stdin) and `salu box login --stdin` (the token from `claude setup-token`, on stdin). The box starts `salu-control.service`.
5. Mac: `ping`, then `status`; prints the result. Everything is idempotent: running `salu box add` again resumes.

## Rules

- Nothing the box executes comes from a string in a message. Only the verbs above, with validated args (names `[a-z0-9-]{1,40}`, repo urls `git@github.com:<owner>/<repo>.git`).
- Secrets only ever travel sealed, or over the pairing ssh session. Never in `args`, never in a log line.
- Every command a user types in a doc or message is at most 55 characters per line (their terminal splits longer ones).
