/**
 * The release signing public keys this salu trusts, base64 of the raw 32-byte ed25519 key. More than one allows a
 * key change: ship a release signed by the old key that also carries the new one, then drop the old one later.
 * Made by the owner's `salu release keygen`; `salu release pubkey` on that Mac must print the same value. With an empty list
 * every `salu release verify` fails, so a box cannot update itself from an unsigned release by accident.
 */
export const RELEASE_PUBKEYS: string[] = ['BhA8EaZPmm1SQgvbktONHNrGndsHaQs+hp9K6D1J8uI='];
