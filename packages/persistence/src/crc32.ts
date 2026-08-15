/**
 * CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320) over snapshot bytes.
 *
 * Why a checksum at all, when IndexedDB is not a raw disk: a stored value can
 * still come back wrong — a truncated write during a browser kill, a value
 * hand-edited in devtools, a file imported from elsewhere later. Docs/06 §27
 * requires a load to validate magic, schema, engine compatibility and checksum
 * before trusting a payload, and this is the checksum half.
 *
 * CRC-32 rather than a cryptographic digest on purpose: this detects
 * corruption, it does not defend against a forger. A save is local data the
 * user already owns, and a hash strong against deliberate tampering would cost
 * time proportional to megabytes on every save for no security we could
 * actually claim. Deliberate edits are caught later anyway, by the canonical
 * state hash recorded in the header (see `durableSnapshot.ts`).
 */

const POLYNOMIAL = 0xedb88320;

/** Reflected CRC-32 table, built once on first use. */
const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? ((value >>> 1) ^ POLYNOMIAL) >>> 0 : value >>> 1;
    }
    table[i] = value;
  }
  return table;
})();

/** CRC-32 of `bytes`, as an unsigned 32-bit integer. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (crc >>> 8) ^ (TABLE[(crc ^ (bytes[i] as number)) & 0xff] as number);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
