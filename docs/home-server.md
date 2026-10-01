# Home server: from a blank laptop to a salu box

Target: your old laptop (Intel 9th-gen i7, 16 GB RAM, 512 GB SSD) as an always-on Ubuntu Server 24.04 LTS box that
runs the tickets you send from your Mac and your phone. Wipes the laptop. Allow about 1 hour.

**Honest status:** the Ubuntu and BIOS parts are standard and I'm confident in them. The salu parts (Part F) have
never run on a real box, and the "safe kernel" redesign (containers/VMs, everything in the kernel by default) is
still being planned in its own thread, so Part E only gets the laptop *ready* for it. Paste any error back and
we fix it. Steps marked 🔸 are the ones where laptops differ most.

You need: a USB stick (8 GB+, gets erased), the laptop and its charger, a **network cable** to the router (use
wired, not wifi: simpler and more reliable), a monitor/keyboard for the install (the laptop's own screen and
keyboard are fine), and your Mac.

---

## Part A. On your Mac: make the installer stick

1. Download **Ubuntu Server 24.04.x LTS** (amd64) from https://ubuntu.com/download/server. It's a ~2 GB `.iso`.
2. Check it wasn't corrupted. Compare this with the checksum on the download page (SHA256SUMS):
   ```sh
   shasum -a 256 ~/Downloads/ubuntu-24.04*-live-server-amd64.iso
   ```
3. Write it to the stick. Easiest: install **balenaEtcher** (https://etcher.balena.io), pick the iso, pick the
   stick, Flash. (Terminal way: `diskutil list` to find the stick, say `disk4`; then
   `diskutil unmountDisk /dev/disk4 && sudo dd if=~/Downloads/ubuntu-24.04*-live-server-amd64.iso of=/dev/rdisk4 bs=4m`.
   Double-check the disk number: dd on the wrong disk destroys it.)
4. Make sure you have an SSH key on the Mac and that it's on GitHub (the installer can fetch it from there):
   ```sh
   ls ~/.ssh/id_ed25519.pub || ssh-keygen -t ed25519      # make one if the first command says "No such file"
   ```
   Your GitHub account should list it at github.com > Settings > SSH and GPG keys.

## Part B. BIOS/UEFI settings 🔸

Plug the laptop in, power on, and tap the BIOS key repeatedly (usually **F2**, **Del**, **F10** or **F1**; the
boot logo often shows it). Names vary by brand, so look for the closest match:

| Setting | Value | Why |
| --- | --- | --- |
| Intel Virtualization Technology (VT-x) | **Enabled** | needed for VMs/containers with real isolation (KVM) |
| VT-d / Intel Virtualization for Directed I/O | Enabled (if present) | harmless, sometimes needed |
| SATA/storage mode | **AHCI** (not "RST"/"RAID"/"Intel Optane") | otherwise Ubuntu can't see the SSD |
| Power on after AC loss / "Restore on AC power loss" / "Wake on AC" | **Power on** (if present) | box comes back after a power cut |
| Battery charge limit (some Lenovo/Dell/ASUS) | 60-80% (if present) | a laptop that's always plugged in lasts longer |
| Secure Boot | leave as is; turn **off** only if the stick won't boot | Ubuntu works with it on |
| Boot order | USB first (or use the one-time boot menu, often **F12**) | to start the installer |

Save and exit (usually F10). Insert the stick first so it boots from it.

## Part C. Install Ubuntu Server

The installer is a text menu: arrow keys, Enter, Space to tick.

1. **Language/keyboard:** yours. **Type of install:** *Ubuntu Server* (not minimized).
2. **Network:** it should show the wired interface with an IP. If not, check the cable. No proxy. Default mirror.
3. **Storage:** *Use an entire disk*, pick the 512 GB SSD, and **untick "Set up this disk as an LVM group"**.
   (With LVM ticked Ubuntu only uses ~100 GB of the disk by default, which you'd later regret: container images are big.)
4. **Profile:** your name; server name `salubox`; username `oliver`; a long password (you'll need it for sudo).
5. **Ubuntu Pro:** skip.
6. **SSH:** tick *Install OpenSSH server*; tick *Import SSH key* > **from GitHub** > username `OliverVillson`.
   Tick *Allow password authentication over SSH* **off** (key only).
7. **Snaps:** select none. Continue. Wait for it to finish, then *Reboot Now*, and pull the USB stick when it asks.

## Part D. First login and the "always on" settings

Find the laptop's address: log in on its own screen (`oliver` + password) and run `ip -4 addr show | grep inet`.
It's the `192.168.x.x` / `10.x.x.x` one. In your router's settings, give it a **fixed address (DHCP reservation)** so it never changes.
From now on do everything from your Mac. The laptop can sit closed in a corner:

```sh
ssh oliver@192.168.x.x          # your Mac; answer "yes" to the fingerprint
```

On the box:

```sh
# 1. bring everything up to date, then reboot once
sudo apt update && sudo apt full-upgrade -y && sudo reboot
# (reconnect with ssh after about a minute)

# 2. never sleep, and keep running with the lid closed
sudo mkdir -p /etc/systemd/logind.conf.d
printf '[Login]\nHandleLidSwitch=ignore\nHandleLidSwitchExternalPower=ignore\nHandleLidSwitchDocked=ignore\n' | sudo tee /etc/systemd/logind.conf.d/lid.conf
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target
sudo systemctl restart systemd-logind     # this may drop your ssh; just reconnect

# 3. timezone (e.g. Europe/Stockholm; list: timedatectl list-timezones)
sudo timedatectl set-timezone Area/City

# 4. firewall: nothing may connect in except ssh (salu needs no open port at all)
sudo ufw default deny incoming && sudo ufw allow OpenSSH && sudo ufw --force enable

# 5. automatic security updates (usually already on; this confirms it)
sudo apt install -y unattended-upgrades && sudo dpkg-reconfigure -plow unattended-upgrades    # answer Yes

# 6. temperature check (install-box.sh also installs thermald, which keeps a laptop CPU out of throttling)
sudo apt install -y lm-sensors && sensors
```

Optional but recommended: **Tailscale**, so you can SSH to the box from outside your home too, with no router
port forwarding (it only makes outbound connections). Tickets and the phone app don't need it, because they go through GitHub.

```sh
curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up --ssh
# open the link it prints, log in; install Tailscale on the Mac too, then: ssh oliver@salubox
```

## Part D2. Get salu from the branches (until the pull requests are merged)

The container kernel (#74), the box test list (#75) and this installer (#73) are not in a release yet, so build salu from
the branches on the box. Once Oliver says "merge it" for all three and a release is tagged, this whole part is replaced by one line
(the `curl ... install-box.sh | sudo bash` in Part E). Public repo, so no login is needed.

```sh
sudo apt install -y git unzip curl
curl -fsSL https://bun.sh/install | bash && source ~/.bashrc      # bun, to build salu
git clone https://github.com/OliverVillson/salu.git ~/salu && cd ~/salu
git checkout -b box origin/claude/project-thread-w24er4           # #75, which already contains #74
git merge --no-edit origin/claude/project-thread-8y6opi           # #73: the installer and this guide
bun install && bun run build && ./dist/salu --version             # builds dist/salu (a minute or two)
```

## Part E. Prepare the box (one script)

One script does the OS side, on a home laptop and on a rented VPS alike. It is safe to re-run, and `--check`
only reports. It checks disk (60 GB free), RAM, virtualization (`/dev/kvm`), then lets bubblewrap use user namespaces on Ubuntu 24.04
(a scoped AppArmor profile; the system-wide restriction stays on), disables sleep and the lid switch on a laptop, turns on a firewall with
nothing inbound but ssh, turns on automatic security updates, adds compressed swap in RAM (zram, up to half of RAM, so a burst of tickets slows down instead of being killed, and the SSD sees no swap writes), installs the runner (Part F step 1), installs the
container runtime for the safe kernel (Podman, gVisor, a scoped AppArmor allowance: `scripts/install-kernel-runtime.sh`,
no KVM needed), and makes tickets on the box *require* the container (they fail with a message instead of running unprotected). If that script is not in your copy yet, the installer says so and skips it.

```sh
cd ~/salu
sudo bash scripts/install-box.sh --check                          # what is ready, what is not
sudo SALU_BINARY=$PWD/dist/salu bash scripts/install-box.sh       # fix it and install the runner (with the salu you just built)
# after the merge and a release, instead:  curl -fsSL https://raw.githubusercontent.com/OliverVillson/salu/main/scripts/install-box.sh | sudo bash
```

On a VPS the same script works (`--profile vps` is picked automatically); pick Ubuntu 24.04 and 60 GB of disk or more.
A VPS needs no VT-x or `/dev/kvm` (the BIOS steps in Part B are for the laptop only). 
## Part F. Put salu on the box

Long version with all the explanations: `docs/v1-setup.md` in the repo. The short run:

**1. On the box: the runner** (already installed by Part E; run alone with `install-runner.sh` if you used `--no-runner`):
```sh
curl -fsSL https://raw.githubusercontent.com/OliverVillson/salu/main/scripts/install-runner.sh | sudo bash
salu runner doctor                                     # every line a green ✓; paste it back if not
```

**2. On the Mac: make a login token for the box** (a year long; keep it secret) and copy it over:
```sh
claude setup-token                                     # opens a browser link; approve; it prints a token
install -m 600 /dev/null ~/salu.token && nano ~/salu.token    # paste the token, save
scp ~/salu.token oliver@192.168.x.x:                   # then delete it from the Mac: rm ~/salu.token
```

**3. On the box: let it use git on your project's private repo** (a deploy key for only that repo):
```sh
sudo -iu salu
ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519 -C "salu box"
cat ~/.ssh/id_ed25519.pub                              # copy the line
ssh -T git@github.com                                  # answer yes
exit
```
GitHub > your repo > Settings > Deploy keys > Add deploy key > paste > tick **Allow write access**.
The repo must be **private**. (Use your own repo name for `you/web`, and the same project name on both machines.)

**4. On the box: add the project:**
```sh
sudo mv ~/salu.token /root/ && sudo salu runner add web --clone git@github.com:you/web.git --token-file /root/salu.token
sudo rm /root/salu.token
salu runner list                                       # web  active
sudo -u salu env SALU_HOME=/var/lib/salu/web salu remote key     # prints the signing key
```

**5. On the Mac: connect and send the first ticket:**
```sh
salu update && cd ~/code/web
salu remote add web --key <the key from the box>
salu add "say hello" "Create HELLO.md containing one friendly line, and commit it."
salu notif                                             # shows "done" after a minute or two
```

**6. On the box: build the container kernel, then prove a ticket runs in it** (every ticket then runs in a per-project
rootless container; installs work there and nothing reaches your files or logins):
```sh
sudo -iu salu salu kernel setup      # builds the image, a few GB, once
sudo -iu salu salu kernel login      # a separate agent token: run claude setup-token on the Mac again, paste it; revocable
sudo -iu salu salu kernel status     # want: tickets run in a container
sudo -iu salu salu doctor --sandbox  # attacks a throwaway container from inside; every line should be green
```
Then settle the gVisor mode for this laptop (it has VT-x, so `kvm` may beat the default `systrap`). It times the same file-heavy job each way:
```sh
sudo -iu salu salu kernel bench                    # prints a time for systrap, kvm (if /dev/kvm works) and plain Podman
sudo -iu salu salu kernel platform kvm             # only if kvm was clearly faster; systrap|kvm|ptrace|default
```
Paste the bench output, `salu runner list` and `sensors` (after a ticket has been running a minute) back to Claude, and the box gets tuned from those numbers.

Then send a ticket from the Mac that shows it: `salu add "kernel check" "Run uname -a and whoami, install the npm package left-pad in a temp folder, and write what you saw to KERNEL.md; commit it."`
Its `KERNEL.md` should say you are root in a gVisor container, and the install should work.

**7. Run the box test list and paste the summary** (needs PR #75, which is stacked on #74; until it is merged, use its branch):
```sh
cd ~/salu && scripts/box-tests.sh --tickets --sudo       # runs the checks, then real tickets; saves ~/salu-box-tests-<time>.txt
cat ~/salu-box-tests-*.txt                               # paste this back to Claude
```

**8. Phone pings (optional):** `sudo -u salu env SALU_HOME=/var/lib/salu/web salu remote ntfy`, then subscribe to
the topic in the free ntfy app. The iPhone app itself still waits for your first Xcode build.

## If you get stuck

- Stick won't boot: try the one-time boot menu (F12), or turn Secure Boot off.
- Installer sees no disk: SATA mode is not AHCI (Part B).
- Can't ssh: wrong IP, or the key wasn't imported. On the laptop itself, run `ssh-import-id-gh OliverVillson` as `oliver`, then try again.
- Box stops after a while: Part D step 2 (sleep) wasn't applied. `systemctl status sleep.target` should say *masked*.
- Everything salu: `salu runner doctor`, `salu runner logs web -f`, `journalctl -u salu-sync@web`.

## Not tested yet

The container kernel (Part F step 6) is built in its own pull request and has not run on a real box. The first run
on your laptop is the real test: paste any error from `install-box.sh`, `salu kernel setup` or the kernel-check ticket
back and it gets fixed.

## Keeping it healthy (an old gaming laptop, always on)

- Put it somewhere with air: on a stand, lid open a crack or closed but not under anything, fan inlets free. Check `sensors` once under load (a running ticket); steady 85 °C or more means clean the fans.
- Cap the battery charge at 60-80% in the BIOS if it offers it, or unplug the battery if it's removable and the laptop runs fine without it.
- The dedicated graphics card is not used by salu. On Ubuntu Server it stays idle with the open driver; do not install NVIDIA drivers.
- Leave Docker off: salu uses rootless Podman with gVisor, which does not need it.
