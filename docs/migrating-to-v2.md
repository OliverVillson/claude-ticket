# Moving from v1.2.0 to v2

Nothing breaks. A project with no roster runs exactly as it did in v1.2.0, and you can adopt v2 one step at
a time. Every step is optional and can be undone.

## Update

    salu update          # installs releases only; a signed v2.0.0 once it is published
    salu --version
    salu doctor

On a box: `salu box update <box>` from your Mac. Releases are signed, as in v1.2.0; a box built before the
signing key was pinned needed a one-time reinstall then, and that has not changed.

## What stays the same

- The install link and `scripts/install.sh`.
- Tickets, threads, memory, `salu sync`, the phone app, the control channel and the safe kernel.
- The **old shared signing key** (`salu remote key`) keeps working for every project until an admin
  retires it with `salu team key --retire-shared`. Friends already joined with it do not need to do anything.
- A project with no team and no seats: no new checks, no new columns, `salu sched` is off or `advise` as you left it.

## What the shared key becomes

Once a project has a roster, the shared key counts as an **unnamed member, never an admin**. It can still add
tickets and reply, but it proves nobody, so it can resolve or reopen only tickets that have no owner (tickets made
before the roster), and it cannot pin a seat. Anything that needs a name or admin rights needs a personal key.

## Step by step

Run these on the box (or on your Mac for a Mac-only project).

1. **Make a roster.** The first person added owns the project:

       salu team add you
       salu team add bob

2. **Register seats** (optional; skip if you only run on the box login):

       salu seat add you-team --owner you --plan team
       salu seat add bob-team --owner bob --plan team
       salu kernel login --seat you-team
       salu kernel login --seat bob-team

   One Team or Enterprise seat per person. Until a seat has a login it is never used.
3. **Give people their own keys:**

       salu team invite bob --with-key      # prints the block Bob pastes
       salu team key --list

   Bob pastes the block in his own checkout (it re-adds the remote with his key); his tickets then carry his name from the signature.
4. **Retire the shared key** once everyone who needs one has a personal key:

       salu team key --retire-shared        # refuses if nobody has a personal key yet
       salu team key --retire-shared --undo # lets it back in

5. **Turn the scheduler on** if you want tickets spread over seats: `salu sched on` (start with `salu sched`
   in advise mode to see what it would do).
6. **Lending stays off.** Do not switch it on until you have read the plan's terms for sharing seat time;
   salu never checked them. See [teams.md](teams.md#lending-spare-seat-time-off-by-default).

## The phone

The iPhone app works unchanged with the shared key. To use a personal key it must add `"kid": "<kid>"` to the
signed JSON before computing the HMAC (key = the 64-hex secret) and read box messages through `sigs[kid]`
instead of `sig`. That change to the phone's `Signing.swift` is not made yet, so keep the phone on the shared
key until it is, which means you cannot retire the shared key while the phone is in use on that project.

## Going back

- `salu team key --retire-shared --undo` re-accepts the shared key.
- `salu seat off <label>` stops a seat being used; `salu sched off` returns to running the queue in order.

## Changed behaviours to know about

- With a roster, `by-<name>` labels in a ticket file are stripped and replaced by the signer's own. Two members
  whose names collide as labels are refused.
- `salu team`/`salu seat` refuse on a computer that is only a client of the box.
- In enforce mode (`salu sched on`) a full or rejected 5-hour window now holds the queue even with no learned estimate.
- A ticket made on the box or sent with the shared key owns no seat; it uses unowned seats, and a member's seat only while they lend it.
