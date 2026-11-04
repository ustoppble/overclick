const EMAIL = /^[^\s@]+@[^\s@]+$/;
/** The longest an email address can be (RFC 5321 path limit). */
export const MAX_EMAIL_LENGTH = 254;

/**
 * Key of the transaction-scoped advisory lock the first admin is created
 * under. "The instance has no account" and "make the admin" are two steps; the
 * lock makes them one, so two setups finishing together cannot both see an
 * empty instance. An arbitrary constant, only ever taken for this.
 */
export const FIRST_ADMIN_LOCK_KEY = 7_211_330_001;

export function canCreateFirstAdmin(userCount: number): boolean {
  return userCount === 0;
}

export function isValidEmail(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && EMAIL.test(email);
}
