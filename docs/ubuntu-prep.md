# Prepare an Ubuntu machine for salu

Goal: a machine running Ubuntu Server 24.04 that you can `ssh` into from your Mac. That is all. Sleep,
lid, firewall, updates, containers and logins are set up for you by `salu box add`
(see [quickstart.md](quickstart.md)). Allow about 30 minutes for a laptop, 5 for a rented server.

**Rented server (VPS):** pick Ubuntu 24.04, 60 GB of disk or more and 8 GB RAM or more. Add your ssh key
when the provider asks, then skip to "Check it from the Mac".

## Old laptop

You need: a USB stick of 8 GB or more (it is erased), the laptop with its charger, and a **network
cable** to the router. Wi-Fi works but can hang on some laptops; a cable is safer for an always-on box.

1. **Make the stick.** Download Ubuntu Server 24.04 (amd64) from https://ubuntu.com/download/server and
   flash it with https://etcher.balena.io.
2. **BIOS.** Tap F2, Del, F10 or F1 at power-on (HP: F10, boot menu F9). Set, where the option exists:
   virtualization **on**, SATA mode **AHCI**, "power on after AC loss" **on**, battery limit **60-80%**.
   Boot from the USB stick (often F12).
3. **Install.** Choose *Ubuntu Server*, wired network, *Use an entire disk* with the LVM group
   **unticked**, a server name like `salubox`, a user such as `oliver`. Tick *Install OpenSSH server*
   and *Import SSH key from GitHub* with your GitHub name. Select no snaps. Reboot and remove the stick.
4. **Fixed address.** On the laptop run `ip -4 addr show | grep inet`. In your router, reserve that
   address for the laptop so it never changes.

The laptop can now sit closed in a corner, with air around it. Do not install NVIDIA drivers or Docker.

## Check it from the Mac

```sh
ssh oliver@192.168.x.x
```

Answer `yes` to the fingerprint. If it lets you in with no password, you are done: log out and run
`salu box add oliver@192.168.x.x`. Use the host name instead of the address if your router knows it.

No key on the Mac yet? Make one and add it to GitHub, then repeat step 3 of the install:

```sh
ssh-keygen -t ed25519
```

## Outside your home (optional)

Tailscale lets you reach the box from anywhere, with no open router port. Tickets do not need it,
because they travel through GitHub.

```sh
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh
```

## If you get stuck

- The stick will not boot: use the one-time boot menu, or turn Secure Boot off.
- The installer sees no disk: set SATA mode to AHCI in the BIOS.
- Cannot ssh: wrong address, or the key was not imported. On the laptop, as your user, run
  `ssh-import-id-gh YourGitHubName`.
- Wi-Fi gone after a reboot (Intel AX210): unplug the charger and battery, hold the power button 40
  seconds, start again. Better, use the cable.
