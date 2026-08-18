/** Default lease for an executor that stops talking to the board. */
export const DEFAULT_CLAIM_TIMEOUT_MINUTES = 60;

/** Settings guard: useful leases start at one minute and cap at one week. */
export const MIN_CLAIM_TIMEOUT_MINUTES = 1;
export const MAX_CLAIM_TIMEOUT_MINUTES = 7 * 24 * 60;

/** The first instant at which another executor may take the claim. */
export function claimExpiresAt(
  lastActivityAt: Date,
  timeoutMinutes = DEFAULT_CLAIM_TIMEOUT_MINUTES,
): Date {
  return new Date(lastActivityAt.getTime() + timeoutMinutes * 60_000);
}

/** Boundary is inclusive: at the deadline the lease no longer protects. */
export function isClaimStale(
  lastActivityAt: Date,
  timeoutMinutes = DEFAULT_CLAIM_TIMEOUT_MINUTES,
  now = new Date(),
): boolean {
  return now.getTime() >= claimExpiresAt(lastActivityAt, timeoutMinutes).getTime();
}

/** Whole minutes for the UI's "no activity for N min" indicator. */
export function claimInactiveMinutes(
  lastActivityAt: Date,
  now = new Date(),
): number {
  return Math.max(0, Math.floor((now.getTime() - lastActivityAt.getTime()) / 60_000));
}

export function validClaimTimeoutMinutes(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MIN_CLAIM_TIMEOUT_MINUTES &&
    value <= MAX_CLAIM_TIMEOUT_MINUTES
  );
}
