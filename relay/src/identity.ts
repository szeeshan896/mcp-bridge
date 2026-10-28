export type UsernameType = 'email' | 'phone';

export interface Username {
  value: string;
  type: UsernameType;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * An account is identified by an email address or a phone number, whichever the person
 * typed. Both are normalised so "Zee@Example.com" and "zee@example.com", or "+91 98765
 * 43210" and "+919876543210", are one account rather than two.
 */
export function normalizeUsername(input: string): Username | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  if (trimmed.includes('@')) {
    const value = trimmed.toLowerCase();
    return EMAIL.test(value) && value.length <= 254 ? { value, type: 'email' } : null;
  }

  const digits = trimmed.replace(/[\s\-().]/g, '');
  if (!/^\+?\d{8,15}$/.test(digits)) return null;
  return { value: digits.startsWith('+') ? digits : `+${digits}`, type: 'phone' };
}
