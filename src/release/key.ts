/**
 * The release signing public keys this salu trusts, base64 of the raw 32-byte ed25519 key. More than one allows a
 * key change: ship a release signed by the old key that also carries the new one, then drop the old one later.
 * Empty until the owner runs `salu release keygen` and the printed public key is committed here; until then every
 * `salu release verify` fails, so a box cannot update itself from an unsigned release by accident.
 */
export const RELEASE_PUBKEYS: string[] = [];
