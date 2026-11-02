/** Output budget of one Mission consultation of Meta (part of the grant). */
export const MISSION_CONSULT_OUTPUT_TOKENS = 2048;

/** Lease tokens of Mission loops alive in this extension-host process. */
const liveLeaseTokens = new Set<string>();

export function registerLiveMissionLease(token: string): void {
  liveLeaseTokens.add(token);
}

export function unregisterLiveMissionLease(token: string): void {
  liveLeaseTokens.delete(token);
}

export function isLiveMissionLease(token: string): boolean {
  return liveLeaseTokens.has(token);
}
