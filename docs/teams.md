# Teams, seats and the scheduler (v2)

v2 is co-working on one Claude Team or Enterprise seat per person. A project keeps a roster of people,
a list of Claude seats, a signing key per person, and a scheduler that starts each ticket on a seat that
has room. A project with no roster behaves exactly as in v1.2.0.

Short version of the model:

- **Person**: a name on the roster, with a role (`admin` or `member`) and optionally their own signing key.
- **Seat**: a name for one Claude login (a Team or Enterprise seat, ideally one per person). The name holds
  no secret; the login token lives on the box and only that seat's proxy reads it.
- **Ticket**: runs on a seat. By default it uses its author's seat, then seats nobody owns. Someone else's
  seat is used only if that person lends it (see [Lending](#lending-spare-seat-time-off-by-default)).

Everything here is run on the machine that owns the project: the box for a box project, your Mac for a
Mac-only project. A computer that is only a client of the box cannot change the roster, seats or keys;
`salu team` and `salu seat` say so and ask you to run the command on the box.

> **Not verified yet.** Per-seat usage has not been checked against a live Team login. The seat-aware
> scheduler has not run on a real two-seat box (it was tested with fake meters). See [What is verified](#what-is-verified).

## The roster and roles

    salu team add alice            # the first person added owns the project (admin)
    salu team add bob
    salu team add carol --admin    # a second admin
    salu team role bob admin|member
    salu team rm bob               # their seats are switched off and their key stops working
    salu team                      # the roster; with seats it also shows each person's seat, window and tickets

A project always keeps one admin.

| | admin (own key) | member (own key) | old shared key |
|---|---|---|---|
| add a ticket | yes | yes | yes |
| reply to any ticket | yes | yes | yes |
| resolve or reopen a ticket | any | only their own | only tickets nobody owns |
| pin a ticket to a seat | any seat | only their own seat | none |
| roster, keys, seats, allow list, kernel settings | yes, from the box or the paired Mac | no | no |

- A ticket's owner comes from the signature, not from the file: the box strips every `by-<name>` label a sender
  writes and adds one only from the personal key that signed the ticket. A forged label does nothing.
- Roster, keys, seats, the allow list and kernel settings have no verb on the sync channel. The control channel
  answers only to the Mac key the admin paired, so those are admin-only by construction.
- The old shared key is an unnamed member, never an admin. It proves nobody, so it cannot resolve or reopen
  someone's ticket (a refusal comes back as a warning note on the client).
- Without a roster nothing is checked, as in v1.

## Seats

    salu seat add alice-team --owner alice --plan team
    salu seat add bob-team   --owner bob   --plan team
    salu seat add shared-api --plan api       # no owner: a project seat anyone's ticket may use
    salu seat off|on alice-team
    salu seat rm alice-team
    salu seat                                  # the list, with lending state

`--plan` is one of `team`, `enterprise`, `pro`, `max`, `api`, `other`. Removing a person switches their
seats off.

### Giving a seat its login (the box)

    salu kernel login --seat alice-team        # then paste the token (from `claude setup-token`)

The token is saved in the box's kernel-token folder as `seats/<seat>.token` (mode 0600). A ticket on that seat
runs in a container of its own for that project and seat, and reaches the model only through that seat's
proxy, which adds that seat's token. The container only ever holds `ssh-placeholder`. Deleting the token file
revokes the seat at once. A seat with no login refuses the ticket; it never falls back to the box login or
another seat. A seat ticket that cannot run in the container kernel is refused too.

### Per-seat usage

On a project with seats, `salu usage` prints one meter per seat (5-hour and weekly use, with the reset time),
each read with that seat's own login. A seat whose login is refused is named `DEAD`, a used-up seat is
flagged, a switched-off seat is skipped, and one bad seat never hides the others. `--json` lists seats too.

## Per-person keys

Before v2 everyone signed with one shared key (`salu remote key`). Now each person can have their own.

    salu team key bob              # make Bob's key; shown once, replaces any older one
    salu team key bob --revoke
    salu team key --list           # who has a key (never the secrets)
    salu team key --retire-shared  # stop accepting the old shared key for this project
    salu team key --retire-shared --undo

A personal key is a token of the form `<kid>.<secret>`. Give it to its owner out of band. The box looks the
secret up per project and sets the ticket's author to that person's name; a file cannot claim to be someone
else. A file naming a key that is unknown, revoked or wrongly signed is refused, and is never retried with
the shared key. Files without a key id use the shared key as before, until you retire it
(`--retire-shared` refuses if nobody has a personal key yet, so you cannot lock everyone out).
Box messages carry one signature per key, so a client holding only its own key can read them.

The secrets are stored in the box's database as they are (the box must recompute the signatures).

## Adding someone

On the box, as admin:

    salu team add bob
    salu seat add bob-team --owner bob --plan team
    salu team invite bob --with-key

`salu team invite <name>` prints one block for Bob to paste. It installs salu, sets `SALU_USER`, adds the
project and starts syncing. With `--with-key` it also makes Bob's personal key and puts it in the block;
without it, the block has a placeholder and you run `salu team key bob` yourself. Then give Bob his seat's
login on the box: `salu kernel login --seat bob-team`.

The block looks like this:

    curl -fsSL https://olivervillson.github.io/salu/i | bash
    export SALU_USER="bob"
    salu add project "web" .      # run inside Bob's checkout of the repo
    salu remote add "web" <git url> --key <kid.secret>
    salu remote sync --watch

Bob also needs to be a collaborator on the project's private GitHub repo (see [coworking.md](coworking.md)).

## Who sees what

- `salu list` has `by` and `seat` columns; the seat shows its 5-hour window left.
- `salu team` shows each person with their seat, window and tickets; `salu seat` shows the meters.
- The TUI list has a `by` column (`Bob @Alice` when Bob's ticket runs on Alice's seat); the tickets pane
  title carries each seat's meter; the ticket detail says `by Alice   seat alice-team ▰▰▰▱▱ 62% left`.
- The phone's ticket rows show the same line. The box's `ticket.started` message carries an optional `seat`
  field the phone reads. A project with no members or seats looks as in v1.

Meters come from the cached per-seat snapshot, never a network call while drawing.

## The scheduler

    salu sched              # mode, what finished runs taught it, the queue forecast, the last decision
    salu sched advise       # default: show what it would do; dispatch is unchanged
    salu sched on           # enforce
    salu sched off

In `on` mode a ticket starts only if it fits the 5-hour window (with a 5% margin; 15% of the week is kept for
`--now` tickets). When nothing fits, the queue is held until the reset. In v2 a full or rejected window holds
the queue even before it has learned a percent-per-ticket. `SALU_SCHED_MARGIN` and `SALU_SCHED_RESERVE`
override the 5% and 15%. Light tickets (labels docs, chore, typo, lint, format, rename) run on Sonnet; tickets
that name a model or effort high or more are never re-routed.

With seats, each ticket is placed on the usable seat with the most room, judged with that seat's own windows
and its own learned percent-per-dollar. Dead, no-login, switched-off and used-up seats are skipped, and a
ticket started a minute ago counts against its seat before the meter shows it, so two tickets do not pile
onto one seat. A ticket stays on the seat it started on. `salu sched` shows each seat's meter, the seat each
queued ticket would take, and why the others did not, for example
`not on alice-team: needs about 30% of the 5-hour window, 80% is used`. If no seat has room, the queue is
held until the earliest reset and every seat is named.

Whose seat a ticket may use: a seat nobody owns, its author's own seat (the member named by its signed `by-`
label), or, for a ticket with no author, a seat nobody owns or an admin's seat (as in v1). A `by-` label naming
nobody on the team gets project seats only. A seat already pinned on a ticket is checked the same way. The scheduler never reads a seat
from a ticket file or tag.

With an API key there is no plan meter; set `SALU_BUDGET_USD_PER_DAY` and the same rules count dollars.

## Lending spare seat time (off by default)

> **Terms not checked.** Whether a Claude plan's terms allow one person's seat to serve a teammate's ticket
> was never checked at the source. Lending is the lender's choice and the lender's responsibility. Read your
> plan's terms before turning it on. salu prints this warning whenever lending is switched on.

    SALU_USER=bob salu seat lend bob-team on --cap 25 --from 22 --to 7
    salu seat lend bob-team off
    salu seat lent                  # every borrowed ticket: lender, borrower, expected use, cost so far

Only the seat's owner can switch lending on (`SALU_USER` must match the owner); anyone with box access can
switch it off. `--cap N` is the most percent of the 5-hour window borrowed tickets may use in total, counted
over the last 5 hours by each ticket's expected use. `--from/--to` are hours of the day on the box (22 to 7 wraps
midnight). A ticket tries its own seat and unowned seats first; a lender's seat only when none has room.
A ticket that started on a lender's seat stays there, and waits if lending stops. Only named members borrow.
A ticket with no named requester never borrows, whether it was sent with the shared key, made on the box, or
its `by-` label names nobody on the team; it runs on the project's ownerless seats or the admin's seat, the same
as v1. Retiring the shared key ends that path (the phone still signs with the shared key).
A person who leaves the project stops lending.

## Security notes

- Personal keys are HMAC secrets, so the box stores every member's secret (it has to recompute the
  signatures). That gives you revocation and attribution: a revoked key stops working at once, and a ticket's
  author comes from the verified signer. It does not protect against someone who can read the box's database;
  treat box access as admin access.
- A ticket's `by-<name>` label is set from the verified signer only. Tickets sent with the shared key prove
  nobody, so they carry no author label and show as unnamed (in v1.2.0 they carried the sender's `SALU_USER`).
- Once any member has a personal key, a file with no key id is refused unless a shared key is really set;
  an unsigned file is never accepted.

## What is verified

- Roster, seats, keys, roles, scheduler placement and lending are covered by unit tests with fake meters
  and fake logins.
- **Not checked** against a live Team or Enterprise login: per-seat usage reads. The seat scheduler has not
  run on a real two-seat box.
- Not compiled: the small Swift change that shows the seat on the phone's ticket rows needs an Xcode build.
- Lending: the subscription terms were not checked (see Lending).
