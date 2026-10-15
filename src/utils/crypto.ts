import crypto from 'crypto';

/**
 * Generuje losowy salt do szyfrowania E2E (256-bit, hex)
 * Ten salt jest używany po stronie klienta do wyprowadzenia klucza szyfrującego z hasła użytkownika
 */
export function generateEncryptionSalt(): string {
  return crypto.randomBytes(32).toString('hex'); // 64 znaki hex (256 bitów)
}

/**
 * Generuje losowy token do resetowania hasła
 */
export function generateResetToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Tworzy hash z tokenu resetowania (do przechowania w bazie)
 */
export function hashResetToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
