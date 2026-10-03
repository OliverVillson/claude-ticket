# salu v1 setup guide: from an empty server to your first result

Goal: write an idea as a ticket on your Mac, have it run on a rented always-on Linux server while you do
something else, and read the result on your Mac (`salu notif`) or later on your iPhone.

```
Mac (you)                         private git repo                     Linux server (always on)
salu add "idea"  ── tickets ──▶   branch salu/inbox   ◀── messages ──  salu runner (one orchestrator per project)
salu notif       ◀─ messages ──   branches salu/<ticket> ◀─ results ──  + salu remote sync --watch
```

There is no server program and no open port: the only link is the project's own git remote, which **must be
private** (anyone who can push to it can send the server tickets).

**How much of this has run for real?** Nothing here has run on a real server yet. Every step is marked:
**[tested]** = covered by the repo's tests or used before, **[untested]** = written from the code of the v1 pull
requests, never run on a real box. Expect a small fix or two on the first go, and paste any error back to Claude.

**Before you start:** the v1 pull requests (#48 to #52, plus #53/#54 for the phone) are merged and you have
tagged a release that contains them. Until then the commands below do not exist in a release.

---

## 1. On your Mac: update salu and make the project's private repo

```sh
salu update                      # [tested] to the release with v1 in it; check: salu --version
```

The repo that holds the project's code is also the transport. Make it **private** on GitHub (for example
`you/web`). If the project only lives in a local folder, create the private repo on GitHub, then:

```sh
cd ~/code/web
git remote add origin git@github.com:you/web.git
git push -u origin main
```

## 2. Rent the server

Any always-on Linux VPS works. What the runner needs: a systemd distro (Ubuntu 24.04 LTS or Debian 12 are the
safe choices), root or sudo, outbound internet. Start with 2 vCPU and 4 GB RAM (a starting guess, not measured;
each running ticket is a Claude Code session, and concurrency defaults to 2). x86_64 and arm64 both work if the
release has a Linux binary for them (check the release page for `linux-x64` / `linux-arm64`).

Add your Mac's SSH public key when you create it (`cat ~/.ssh/id_ed25519.pub`), then:

```sh
ssh root@SERVER_IP               # or the admin user your provider gives you
```

## 3. On the server: install the runner **[untested]**

```sh
curl -fsSL https://raw.githubusercontent.com/OliverVillson/salu/main/scripts/install-runner.sh | sudo bash
```

This installs git, bubblewrap and socat (the sandbox), a Linux user `salu`, salu itself in `/usr/local/bin`,
Claude Code for that user, and the systemd template. Check it:

```sh
salu runner doctor               # every line should be a green ✓
```

If it says the sandbox cannot run, your VPS kernel may block user namespaces (some container-style VPSes do).
Pick a full VM plan, or add `--no-sandbox` in step 6 (runner projects are sandboxed by default; see "Safety").

## 4. On the server: log Claude in **[untested]**

The box needs one Claude login, shared by every project on it. Decision: **subscription is the default**, set up
with a one-year token made for scripts (`claude setup-token`, documented at
code.claude.com/docs/en/authentication), not a copied login. An API key is the alternative.

- **Subscription token** (uses your plan's usage window): run `claude setup-token` on any machine with a browser
  (your Mac is fine; it opens a link, you approve, it prints a token). Save the token to a file only you can read
  and copy it to the server, e.g. `scp ~/salu.token you@SERVER_IP:`; then pass it in step 6 with `--token-file`.
  salu stores it only in `/etc/salu/<project>.env` (root-only) as `CLAUDE_CODE_OAUTH_TOKEN`. Keep it like a
  password and delete the file afterwards. **If `ANTHROPIC_API_KEY` is set anywhere on the box it wins over the
  token**, so do not set both. Without a token, `salu runner add` still proceeds but warns that a copied login
  stops working unattended once it expires. The token lasts a year; when it expires, make a new one and run
  `salu runner add` again (or edit the env file) and `sudo salu runner restart web`.
- **API key** (pay per use): create a key in the Anthropic Console, put it in a file only you can read, and pass it
  in step 6:
  ```sh
  install -m 600 /dev/null ~/anthropic.key && nano ~/anthropic.key     # paste the key, save
  ```
  salu stores it only in `/etc/salu/<project>.env` (root-readable), never on a command line.

The `--token-file` flag comes from the runner follow-up PR; check `salu runner add --help` on your build.

### What this means for safety (read once)

Agents on the box can still reach **any website**, and whatever login sits on the box can be read by an agent
that gets tricked (for example by a malicious web page or a file in the repo telling it to send secrets out).
The sandbox and locked-down services make that hard, not impossible. So treat the box's login as something you
may have to revoke:

- **Subscription token:** revoke it in your Claude account settings (authorised apps / sessions), then make a new one.
- **API key:** delete it in the Anthropic Console. Put a **spend limit** on that key's workspace first, so a leak
  can only cost so much.
- You can narrow where agents may connect by setting `SALU_SANDBOX_DOMAINS=github.com,*.npmjs.org` in
  `/etc/salu/web.env` (then restart).

## 5. On the server: let the `salu` user use git on the private repo **[untested]**

The box clones the repo, and pushes `salu/inbox` and `salu/<ticket>` back, as the `salu` user. Give it a
**deploy key with write access** to only this repo:

```sh
sudo -iu salu
ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519 -C "salu box"
cat ~/.ssh/id_ed25519.pub        # copy this
ssh -T git@github.com            # answer yes to the host key question (the "no shell access" reply is fine)
exit
```

On GitHub: repo `you/web` > Settings > Deploy keys > Add deploy key > paste it, tick **Allow write access**.
(Sandboxed agents cannot read this key: they never see the `salu` user's home folder.)

## 6. On the server: add the project **[untested]**

Use the same project name you will use on the Mac (lowercase letters, digits, `-`, `_`):

```sh
sudo salu runner add web --clone git@github.com:you/web.git \
     --token-file ~/salu.token                                                   # subscription token (default)
sudo salu runner add web --clone git@github.com:you/web.git \
     --auth api-key --api-key-file /home/salu/anthropic.key                      # or API key
salu runner list                 # web  active  0 queued · 0 running · 0 blocked · 0 done
salu runner logs web -f          # the orchestrator's log; Ctrl-C leaves it running
```

The project's data lives in `/var/lib/salu/web`, it is sandboxed, and it starts now and on every boot.

## 7. On the server: check the git sync **[untested]**

`salu runner add` (step 6) also registers the box side of the git link and starts a second service,
`salu-sync@web`, which runs `salu remote sync --watch` (restarts on failure, starts on boot). It takes the git
url from `--clone`, or from `--remote <url>` if you want a different one; `--no-sync` runs the orchestrator
only. If it printed "git sync is not in this salu build yet", your salu is older than the sync PR: update salu
and run `salu runner add` again. Check:

```sh
sudo systemctl status salu-sync@web         # active (running)
journalctl -u salu-sync@web -f              # a line every time something moves
sudo -u salu env SALU_HOME=/var/lib/salu/web salu remote list    # role box, "synced ... ago", no error
```

If the login is dead when a service starts, the orchestrator exits (code 78) and stays failed: `salu runner list`
shows it, and you also get an error notif on the Mac ("The box stopped: ..."). Repair the login (make a new
token with `claude setup-token`, or fix the API key), then `sudo salu runner restart web`.

If `remote list` shows an error, it is almost always git access: the deploy key from step 5 is missing or lacks
write access. `sudo salu runner start|stop|restart|logs <project>` cover both services.

### The signing key (required) **[untested]**

Anyone who can push to the repo can write tickets onto `salu/inbox`. A private repo is the first lock; a signing
key is the second: files without a valid signature are ignored. The box requires it, and without a key
`salu remote sync` and `--watch` refuse to start.

`salu runner add` (which runs `salu remote add --box` for you) makes the key on the box if none exists. Read it
there and give it to the Mac and the phone, out of band (password manager, never through git):

```sh
sudo -u salu env SALU_HOME=/var/lib/salu/web salu remote key      # box: prints the key (stored mode 0600 in the project's salu home)
```
```sh
cd ~/code/web
salu remote add web --key <the key>      # Mac: sets the key and connects (or: salu remote key --set <the key>, then remote add)
```

Without a key a client `salu remote add` stops and tells you where to get one. On the iPhone, paste the same key
in the app's Settings (kept in the Keychain on that phone only). The environment variable `SALU_REMOTE_KEY`
overrides the key file. `SALU_REMOTE_ALLOW_UNSIGNED=1` opts out of signing (a red warning stays); not
recommended.

**Rotating:** do it on the box only: `salu remote key --new` (or `--set <key>`). It first re-signs the existing
inbox history with the new key, so the Mac and the phone keep their full history once they switch; if the inbox
cannot be reached, the key is left unchanged. Then copy the new key to the Mac (`salu remote key --set <key>`)
and the phone. Anything a client sends before it switches is ignored. On a machine that is not the box, `--new`
and `--set` only save the key locally, so rotate on the box, then copy the key to the other devices.

### What tickets from the Mac may set

On the box, remote tickets lose the tags `permission`, `tools`, `project`, `max-turns`, `model` and `effort`: a
ticket sent through git cannot widen what the agent may do or burn quota, and runs with the project's defaults.
To let `model`, `effort` and `max-turns` through, add `SALU_REMOTE_ALLOW_TAGS=model,effort,max-turns` to
`/etc/salu/web.env` and restart (`permission`, `tools` and `project` can never be allowed).

### The services are locked down

The runner's systemd units confine the services: a read-only system, an empty home, and only the project's own
folder. The orchestrator sees the Claude login but no SSH keys; the sync service sees the SSH key and git config
but no Claude login. If the sandbox then fails to start on your VPS, `sudo salu runner setup --no-harden` drops
the confinement (the worker sandbox still applies).

On a box, always run projects through the runner (above), not a foreground `salu run` in a shell. The scrub that
hides your tokens from agents cleans salu's own process, but the shell a foreground run starts from still holds
whatever you exported there, and a same-user agent could read it. If you do run in the foreground, do not export
tokens or keys into that shell.

## 8. On your Mac: connect the project and send a ticket

```sh
cd ~/code/web
salu add project web .                    # [tested] register the folder (skip if it already exists)
salu remote add web --key <the key>       # [untested] client side; uses origin, checks it is reachable (key: step 7)
salu add "say hello" "Create HELLO.md containing one friendly line, and commit it."
```

With the box remote in place, `salu add` sends the ticket through git and queues it on the box (use `--backlog`
to save it there without running). You should see `sent to git@github.com:you/web.git, it runs on the box`.
If the network is down it says it will be sent on the next `salu remote sync`.

## 9. Read the result

```sh
salu notif                   # [untested] the window: "Got ...", then "done" (or "blocked" with its question)
```

Resting the mouse on a message (or pressing Enter) marks it read and it disappears. `salu notif --plain` prints
the unread ones without marking them, and `salu notif read --all` marks everything read from the shell.
Mouse hover needs a terminal that reports mouse motion (iTerm2 does; Terminal.app may not: use Enter, or
`SALU_NO_MOUSE=1`).

The work itself arrives as a branch. After a sync it is on your Mac as `salu-box/<ticket>`:

```sh
salu remote sync                              # fetch now instead of waiting
git -C ~/code/web branch -r | grep salu-box   # the result branches
git -C ~/code/web log salu-box/say-hello      # what the agent did
git -C ~/code/web merge salu-box/say-hello    # when you like it
salu show "say hello"                         # [untested on a client] status, branch and the worker's summary
```

If a ticket is **blocked** on a permission, the message shows the `salu allow "name"` command. Run it on the box:
`sudo -u salu env SALU_HOME=/var/lib/salu/web salu allow "name"`.

## 10. Get a ping on your phone (optional) **[untested]**

On the box, `salu remote ntfy` makes a private topic; install the free ntfy app on your iPhone and subscribe to
that topic. Notifications show the title only (no ticket content).

```sh
sudo -u salu env SALU_HOME=/var/lib/salu/web salu remote ntfy          # makes and prints the topic
sudo -u salu env SALU_HOME=/var/lib/salu/web salu remote ntfy --test   # sends a test ping
sudo -u salu env SALU_HOME=/var/lib/salu/web salu remote ntfy --off    # turn it off
```

The topic name is the secret: anyone who knows it can read the titles, so do not share it. Tapping a
notification opens the Salu iPhone app on that ticket. Apple push notifications from the app itself come later.

## 11. On your iPhone (optional)

The phone app reads and writes `salu/inbox` directly through the GitHub API. You need Xcode on the Mac.

1. `salu remote phone web` on the Mac lists what the app needs. `salu remote phone web --open` opens GitHub's
   fine-grained token page with the name, owner and *Contents: read and write* filled in; under Repository access
   pick **Only select repositories** and `web`'s repo, then Generate token.
2. `brew install xcodegen`, then in your clone of the salu repo: `cd ios && xcodegen generate && open SaluPhone.xcodeproj`
   and Run in a simulator. For your own iPhone run `bash ios/device.sh` first (it sets up signing with your Apple ID),
   then pick the iPhone in Xcode and Run.
3. Settings in the app: repo `you/web`, project `web`, the token, the signing key (`salu remote key | pbcopy` on the
   Mac, paste on the phone), then **Test connection**. It also says whether the token reaches any other private repo.

The inbox is checked every few seconds while something you sent waits on the box, else every 30 s and on pull-down.
For pings use ntfy (step 10): tapping one opens the app on that ticket.

## 12. Prove the sandbox on your Mac (once) **[untested]**

```sh
salu doctor --sandbox        # uses a few haiku requests; every line should be a green ✓ (refuses to run if SALU_SANDBOX=off)
```

It runs a small ticket that tries to read, write and hard-link canary files in your home folder and checks they
are untouched. Run the same on the box (`sudo -iu salu`, then `salu doctor --sandbox`) once the login is set up.

## Everyday use

| Want to | Command |
| --- | --- |
| see the box's projects | `salu runner list` (on the box) |
| watch the orchestrator | `salu runner logs web -f` |
| restart / stop | `sudo salu runner restart web` / `stop web` |
| update salu on the box | `sudo salu update`, then `sudo salu runner restart web` (restarts both services) |
| drop a project | `sudo salu runner remove web` (`--purge` also deletes its data) |
| add a second project | repeat steps 5 to 8 with a new name: it gets its own orchestrator and sync |

## Safety, in one paragraph

Runner projects are sandboxed by default: agents work in their own copy (`/var/lib/salu/web/kernel/...`), shell
commands are fenced in by bubblewrap, and agents cannot read the `salu` user's SSH key, your tokens or other
projects. They can reach any website unless you set `SALU_SANDBOX_DOMAINS` in `/etc/salu/web.env`. The deploy key
only reaches the one repo. Results come back as `salu/*` branches you merge yourself; nothing lands on `main`
on its own.

## If something does not work

- `salu runner doctor` (box) and `salu doctor` say what is missing.
- Tickets sent but never start: `journalctl -u salu-sync@web` (is sync running? can `salu` push to the repo?).
- `permission denied (publickey)` in the sync log: the deploy key is missing or lacks write access (step 5).
- Ticket `blocked: needs permission`: `salu allow "name"` on the box.
- `login expired` or "The box stopped": make a new token (`claude setup-token`) or fix the API key, then `sudo salu runner restart web`.
- Nothing on the Mac after a sync: `salu remote list` shows the last sync time and any error per project.
