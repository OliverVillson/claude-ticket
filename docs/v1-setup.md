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

The box needs one Claude login, shared by every project on it. Two options; **which one to use is still being
checked** (whether Anthropic's terms allow a subscription login for unattended use on a server). Until that is
settled, the API key is the safe choice.

- **API key** (pay per use): create a key in the Anthropic console, then on the server put it in a file only you
  can read and pass it in step 6:
  ```sh
  install -m 600 /dev/null ~/anthropic.key && nano ~/anthropic.key     # paste the key, save
  ```
  salu stores it only in `/etc/salu/<project>.env` (root-readable), never on a command line.
- **Subscription** (uses your plan's usage window): `sudo -iu salu`, run `claude`, type `/login`, follow the link
  in a browser on your Mac. Then `exit`. If it later says the login expired, repeat.

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
sudo salu runner add web --clone git@github.com:you/web.git                     # subscription login
sudo salu runner add web --clone git@github.com:you/web.git \
     --auth api-key --api-key-file /home/salu/anthropic.key                      # or API key
salu runner list                 # web  active  0 queued · 0 running · 0 blocked · 0 done
salu runner logs web -f          # the orchestrator's log; Ctrl-C leaves it running
```

The project's data lives in `/var/lib/salu/web`, it is sandboxed, and it starts now and on every boot.

## 7. On the server: connect it to the private repo **[untested]**

```sh
sudo -u salu env SALU_HOME=/var/lib/salu/web salu remote add web --box     # uses the clone's origin
sudo -u salu env SALU_HOME=/var/lib/salu/web salu remote sync              # once, by hand: expect "nothing new"
```

### The missing piece: keep syncing running

`salu runner add` starts the **orchestrator** only. Something must also keep running `salu remote sync --watch`
on the box, or tickets never arrive and results never leave. **The v1 runner does not do this yet** (a gap found
while writing this guide; it should become part of `salu runner add`). Until it does, add a second systemd
service by hand:

```sh
sudo tee /etc/systemd/system/salu-sync@.service >/dev/null <<'EOF'
[Unit]
Description=salu git sync for %i
After=network-online.target
Wants=network-online.target

[Service]
User=salu
Environment=SALU_HOME=/var/lib/salu/%i
Environment=HOME=/home/salu
Environment=PATH=/home/salu/.local/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=/var/lib/salu/%i
ExecStart=/usr/local/bin/salu remote sync --watch
Restart=always
RestartSec=15

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now salu-sync@web
journalctl -u salu-sync@web -f      # a line every time something moves
```

## 8. On your Mac: connect the project and send a ticket

```sh
cd ~/code/web
salu add project web .                    # [tested] register the folder (skip if it already exists)
salu remote add web                       # [untested] client side; uses origin, checks it is reachable
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

## 10. On your iPhone (optional, later) **[untested: never compiled]**

The phone app reads and writes `salu/inbox` directly through the GitHub API. You need Xcode on the Mac.

1. On GitHub: Settings > Developer settings > Fine-grained tokens > new token, **only the `you/web` repo**,
   permission *Contents: read and write*.
2. `brew install xcodegen`, then in your clone of the salu repo: `cd ios && xcodegen generate && open SaluPhone.xcodeproj`.
3. Run it in a simulator (or on your iPhone with your team under Signing).
4. Settings in the app: repo `you/web`, project `web`, the token (kept in the Keychain), then **Test connection**.

The inbox refreshes every 30 s while the app is open and on pull-down. There are no push notifications yet.

## 11. Prove the sandbox on your Mac (once) **[untested]**

```sh
salu doctor --sandbox        # uses a few haiku requests; every line should be a green ✓
```

It runs a small ticket that tries to read, write and hard-link canary files in your home folder and checks they
are untouched. Run the same on the box (`sudo -iu salu`, then `salu doctor --sandbox`) once the login is set up.

## Everyday use

| Want to | Command |
| --- | --- |
| see the box's projects | `salu runner list` (on the box) |
| watch the orchestrator | `salu runner logs web -f` |
| restart / stop | `sudo salu runner restart web` / `stop web` |
| update salu on the box | `sudo salu update`, then `sudo salu runner restart web` and `sudo systemctl restart salu-sync@web` |
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
- `login expired`: on the box, `sudo -iu salu`, run `claude`, `/login`.
- Nothing on the Mac after a sync: `salu remote list` shows the last sync time and any error per project.
