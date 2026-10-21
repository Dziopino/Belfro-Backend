/**
 * Weryfikacja Cloudflare Turnstile po stronie serwera.
 *
 * Rejestracja jest jedynym publicznym endpointem, który tworzy konto z 350 darmowymi stronami,
 * więc to tu siedzi bramka na boty. Kontroler zna tylko `verifyTurnstileToken()` i
 * `getTurnstileSiteKey()` — klucze są w zmiennych środowiskowych, a widgetu nie da się
 * obejść podmianą JS, bo i tak sprawdzamy token u źródła.
 */

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_TIMEOUT_MS = 5000;

export type TurnstileErrorCode = 'CAPTCHA_REQUIRED' | 'CAPTCHA_FAILED' | 'CAPTCHA_UNAVAILABLE';

/**
 * Trzy kody, bo nauczyciel musi dostać inny tekst, gdy zapomniał zaznaczyć checkbox,
 * gdy Cloudflare odrzucił token, i gdy bramka jest niedostępna. Tylko ten pierwszy
 * jest jego winą i tylko on nie powinien sugerować ponownej próby „za chwilę".
 */
export class TurnstileError extends Error {
  readonly code: TurnstileErrorCode;

  constructor(code: TurnstileErrorCode, message: string) {
    super(message);
    this.name = 'TurnstileError';
    this.code = code;
  }
}

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function getTurnstileSiteKey(): string | null {
  const sitekey = process.env.TURNSTILE_SITE_KEY?.trim();
  return sitekey ? sitekey : null;
}

function getTurnstileSecretKey(): string | null {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  return secret ? secret : null;
}

/**
 * Konfiguracja dla klienta: bez sitekeya widget nie ma co renderować, bez sekretu nie ma
 * czego weryfikować. `required` jest prawdziwe także wtedy, gdy w produkcji kluczy brakuje —
 * wtedy serwer odrzuci rejestrację zamiast cicho przepuścić boty.
 */
export function getTurnstileConfig(): { sitekey: string | null; required: boolean } {
  const sitekey = getTurnstileSiteKey();
  const secret = getTurnstileSecretKey();

  return { sitekey, required: !!(sitekey && secret) || isProduction() };
}

/**
 * Single-use token z formularza. Rzuca `TurnstileError`, a zwraca nic — kontroler woła to
 * przed pierwszą operacją na bazie, więc odrzucony bot nie kosztuje ani bcrypta, ani maila.
 *
 * Świadomie nie wysyłamy `remoteip`: wymagałoby logowania adresu IP (dane osobowe), a za
 * reverse proxy i tak przekazalibyśmy adres load balancera zamiast adres klienta.
 */
export async function verifyTurnstileToken(token: unknown): Promise<void> {
  const sitekey = getTurnstileSiteKey();
  const secret = getTurnstileSecretKey();

  if (!sitekey || !secret) {
    if (isProduction()) {
      throw new TurnstileError(
        'CAPTCHA_UNAVAILABLE',
        'Turnstile is not configured; production must not register accounts without verification'
      );
    }

    console.warn('[Turnstile] Brak TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY — pomijam weryfikację');
    return;
  }

  if (typeof token !== 'string' || !token.trim()) {
    throw new TurnstileError('CAPTCHA_REQUIRED', 'Turnstile token is missing');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TURNSTILE_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ secret, response: token }),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new TurnstileError(
      'CAPTCHA_UNAVAILABLE',
      aborted ? 'Turnstile did not respond in time' : 'Could not reach the Turnstile service'
    );
  } finally {
    clearTimeout(timer);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new TurnstileError('CAPTCHA_UNAVAILABLE', 'Turnstile returned an unexpected response');
  }

  const result = (payload ?? {}) as { success?: unknown; 'error-codes'?: unknown };

  if (result.success !== true) {
    // `error-codes` to kody Cloudflare, nie treść od klienta — bezpieczne do loga,
    // ale i tak tylko w logu: nauczyciel dostaje jeden polski komunikat z frontu.
    console.error('[Turnstile] Odrzucony token:', describeErrorCodes(result['error-codes']));
    throw new TurnstileError('CAPTCHA_FAILED', 'Turnstile rejected the token');
  }
}

function describeErrorCodes(codes: unknown): string {
  if (!Array.isArray(codes) || codes.length === 0) return 'no error codes';

  return codes
    .filter((code): code is string => typeof code === 'string')
    .slice(0, 4)
    .join(', ');
}
