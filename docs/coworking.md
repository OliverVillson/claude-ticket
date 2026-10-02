# Co-working: two people, one project (thin version)

A friend adds tickets to your box project and you both see them, with who added what.
Tickets run on the box's one login (the admin's). This is shared tickets, not shared seats.
Shared seats and borrowing a teammate's spare time are not built (see "Not built yet").

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
  of trusted friends; per-person keys come with the team version.
- The name on a ticket is whatever `SALU_USER` says (default: login name). It is a label,
  not proof of identity.
- The box's login pays for every ticket. Whether a friend's ticket may use the owner's
  seat is the open terms question.
- A friend who joins late sees tickets from the box's history as the acknowledgements replay.

## Not built yet

Per-person keys and roles (admin owns the project), one Team/Enterprise seat per person,
the scheduler spreading tickets across seats, borrowing a teammate's spare seat time.
