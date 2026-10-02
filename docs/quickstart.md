# Quickstart

You need a Mac and one Ubuntu 24.04 machine you can ssh into (an old laptop or a rented server).
No machine yet? Start with [ubuntu-prep.md](ubuntu-prep.md), about 30 minutes.

**1. On the Mac: install salu.**

```sh
U=https://olivervillson.github.io/salu
curl -fsSL $U/i | bash
```

It tells you if the GitHub CLI (`gh`) or Claude Code is missing, and the one line that fixes each.

**2. On the Mac: connect the box.** One ssh session, one browser approval for your Claude login.

```sh
salu box add you@salubox
```

It asks for the box's sudo password once, installs everything there, creates a private
`salu-control` repo on your GitHub, and checks that the box answers. Re-run it if your ssh drops:
it continues where it stopped.

**3. On the Mac: make a project.**

```sh
salu new web
```

This creates a private repo, hands the box a key to it and starts a runner. Then send a ticket:

```sh
salu add "say hello" "Create HELLO.md, commit it."
salu notif
```

## Later

```sh
salu box status
salu box update
salu doctor --sandbox
```

`salu box status` shows the last heartbeat, version, disk and running tickets. `salu box update`
installs the newest release on the box. Everything runs from the Mac; you never type on the box again.

## If something fails

- `salu doctor` checks the Mac side. Every line should be a green check.
- `salu box status` says if the box has gone quiet. Commands take up to 30 seconds to arrive.
- The install URL does not load: the one-time GitHub Pages switch is not on yet. Use the long form:
  `curl -fsSL https://raw.githubusercontent.com/OliverVillson/salu/main/scripts/install.sh | bash`
