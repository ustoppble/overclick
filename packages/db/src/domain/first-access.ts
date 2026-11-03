const EMAIL = /^[^\s@]+@[^\s@]+$/;
/** The longest an email address can be (RFC 5321 path limit). */
export const MAX_EMAIL_LENGTH = 254;

export function canCreateFirstAdmin(userCount: number): boolean {
  return userCount === 0;
}

export function isValidEmail(email: string): boolean {
  return email.length <= MAX_EMAIL_LENGTH && EMAIL.test(email);
}

export function isValidPassword(password: string): boolean {
  return password.length >= 8;
}
