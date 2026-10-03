# Co-working: two people, one project (thin version)

A friend adds tickets to your box project and you both see them, with who added what.
Tickets run on the box's one login (the admin's). This is shared tickets, not shared seats.
For one seat per person, personal keys, roles and borrowing spare seat time (v2), see [teams.md](teams.md).

## Join (the friend, on their own computer)

The admin (box owner) does two things once:

1. Adds the friend as a collaborator on the project's private GitHub repo.
2. Sends them the signing key, from the box: `salu remote key`.

The friend then runs:

    U=https://github.com/OWNER/REPO.git   # the repo URL
    K=PASTE-THE-KEY-HERE
    salu add project web ~/web --clone $U
    salu remote add web $U --key $K
    export SALU_USER=Bob                  # name shown on tickets
    salu remote sync web --watch --interval 3

Both people then use `salu add "fix login"` as usual. Each ticket carries its author as a
`by-bob` label; the other side's list gets a copy as soon as the box acknowledges it, and
status, results and replies follow the same way they do for your own tickets.

## What it is and is not

- One shared signing key. Anyone who has it can send tickets as anyone. Fine for small groups
  of trusted friends. In v2 each person can have their own key (`salu team key`) and the admin can retire the
  shared one (see [teams.md](teams.md) and [migrating-to-v2.md](migrating-to-v2.md)).
- The name on a ticket is whatever `SALU_USER` says (default: login name). It is a label,
  not proof of identity.
- The box's login pays for every ticket. Whether a friend's ticket may use the owner's
  seat is the open terms question.
- A friend who joins late sees tickets from the box's history as the acknowledgements replay.

## Team roster and seats (v2)

    salu team add alice          # the first person added owns the project
    salu team add bob
    salu seat add bob-team --owner bob --plan team
    salu seat lend bob-team on --cap 25 --from 22 --to 7   # off until the owner turns it on

`salu team` and `salu seat` keep the roster and the list of Claude seats (a seat is a name, never a login).
Personal keys, roles, seat logins, per-seat usage and the seat-aware scheduler read them; all of that is in
[teams.md](teams.md). Whether a subscription seat may serve a teammate's ticket has not been checked at the
source: check the plan's terms before turning lending on.

## Borrowing spare seat time (v2, off by default)

> **Terms not checked.** Whether a Claude plan's terms allow your seat to serve a teammate's ticket was never
> checked at the source. Lending is the lender's choice and the lender's responsibility.

A teammate can lend a capped slice of their seat:

    SALU_USER=bob salu seat lend bob-team on --cap 25 --from 22 --to 7

- Only the seat's owner switches lending **on** (`SALU_USER` must match the seat's owner); anyone with box access
  can switch it off. A person who leaves the project stops lending.
- `--cap N` is the most percent of the 5-hour window borrowed tickets may use in total (counted over the last 5
  hours, by each ticket's expected use). `--from/--to` are hours of the day on the box (22 to 7 wraps midnight).
- A ticket first uses seats it is entitled to (the project's seats, its author's own, or an admin's for a ticket
  with no author). Only when none has room does it try a lender's seat. The author comes from the ticket's signed
  `by-` label. A ticket with none (made on the box, or sent with the shared key, which proves nobody) never
  borrows: a borrow must name a lender and a borrower, so it can be attributed and revoked per person.
- A ticket that started on a lender's seat stays there; if lending stops it waits.
- `salu seat lent` lists every borrowed ticket: lender, borrower, expected use and the cost so far.
