import { Request, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { verifyToken, JWTPayload } from '../utils/jwt';

// Rozszerzamy interface Request o pole user
declare global {
  namespace Express {
    interface Request {
      user?: JWTPayload;
    }
  }
}

/**
 * Trasy dozwolone mimo niezweryfikowanego kontaktu — bez nich nauczyciel nie miałby czym
 * domknąć weryfikacji. To biała lista: brak wpisu = 403, więc trasa dorzucona później
 * nie prześliźnie się pod bramką przez samo zapomnienie.
 */
const CONTACT_GATE_ALLOWLIST = new Set([
  'GET /auth/me',
  'POST /auth/send-sms-code',
  'POST /auth/verify-sms-code',
]);

/** Bramka liczy trasy względem korzenia /api, więc „POST /api/auth/login” to „POST /auth/login”. */
function routeKey(req: Request): string {
  const raw = (req.originalUrl || req.url).split('?')[0];
  const withoutApi = raw.startsWith('/api') ? raw.slice('/api'.length) : raw;
  const path = withoutApi.replace(/\/+$/, '') || '/';

  return `${req.method} ${path}`;
}

/**
 * Middleware weryfikujący JWT token w nagłówku Authorization, a potem bramkę kontaktu.
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  let decoded: JWTPayload;

  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'No token provided' });
      return;
    }

    const token = authHeader.substring(7); // Usuń "Bearer "
    decoded = verifyToken(token);
  } catch (error) {
    res.status(401).json({ error: 'Invalid or expired token' });
    return;
  }

  req.user = decoded;

  if (CONTACT_GATE_ALLOWLIST.has(routeKey(req))) {
    next();
    return;
  }

  // Status czytamy z bazy przy każdym żądaniu: token żyje 7 dni i nie może decydować o bramce,
  // a konto zweryfikowane po wystawieniu tokenu wciąż nim nie jest.
  try {
    const account = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { email_verified_at: true, is_phone_verified: true },
    });

    if (!account) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    if (!account.email_verified_at || !account.is_phone_verified) {
      res.status(403).json({
        error: 'Account requires email and phone verification',
        code: 'EMAIL_OR_PHONE_NOT_VERIFIED',
      });
      return;
    }

    next();
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
