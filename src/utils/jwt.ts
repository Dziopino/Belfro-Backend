import jwt from 'jsonwebtoken';

// Wartość z repozytorium. Jeśli trafi na produkcję, każdy z dostępem do kodu podpisze sobie
// token na dowolne `userId`, więc nie może ona nigdy podpisać ani zweryfikować żądania.
const PLACEHOLDER_SECRET = 'your-super-secret-jwt-key-change-in-production';

function resolveSecret(): string {
  const configured = process.env.JWT_SECRET?.trim();
  const isProduction = process.env.NODE_ENV === 'production';

  if (configured && configured !== PLACEHOLDER_SECRET) return configured;

  if (isProduction) {
    throw new Error(
      'JWT_SECRET musi być ustawiony na produkcji i nie może być wartością placeholderową z repozytorium.'
    );
  }

  console.warn(
    '[Auth] Brak JWT_SECRET w .env — lokalnie używamy zapasowego klucza. ' +
      'Na produkcji ten sam kod odruchowo nie startuje.'
  );
  return PLACEHOLDER_SECRET;
}

const JWT_SECRET = resolveSecret();
const JWT_EXPIRES_IN = '7d'; // Token ważny przez 7 dni

export interface JWTPayload {
  userId: string;
  email: string;
}

/**
 * Generuje JWT token dla użytkownika
 */
export function generateToken(payload: JWTPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

/**
 * Weryfikuje i dekoduje JWT token
 */
export function verifyToken(token: string): JWTPayload {
  return jwt.verify(token, JWT_SECRET) as JWTPayload;
}
