import { Request, Response } from 'express';
import { randomInt, timingSafeEqual } from 'crypto';
import { Prisma } from '@prisma/client';
import type { User as UserRecord } from '@prisma/client';
import bcrypt from 'bcrypt';
import { Resend } from 'resend';
import prisma from '../config/database';
import { generateEncryptionSalt, generateResetToken, hashResetToken } from '../utils/crypto';
import { generateToken } from '../utils/jwt';
import { maskPolishPhone, normalizePolishPhone } from '../utils/phone';
import { SmsProviderError, buildVerificationSmsText, getSmsProvider } from '../services/smsService';
import { TurnstileError, getTurnstileConfig, verifyTurnstileToken } from '../services/turnstileService';
import { ACCOUNT_KINDS, isAccountKind } from '../utils/roster';

const resend = new Resend(process.env.RESEND_API_KEY);
const BCRYPT_ROUNDS = 12;
const RESET_TOKEN_EXPIRY_HOURS = 1;
const VERIFICATION_TOKEN_EXPIRY_HOURS = 24;
const VERIFICATION_RESEND_COOLDOWN_MS = 60 * 1000;

// Weryfikacja telefonu. Czasy trzymane w bazie, nie w pamięci procesu — restart dev serwera
// nie może dawać nowe okno cooldownu ani odejmować prób od kodu, który już wyszedł.
const SMS_CODE_TTL_MS = 5 * 60 * 1000;
const SMS_COOLDOWN_MS = 60 * 1000;
const SMS_MAX_ATTEMPTS = 5;

/**
 * Kolumny wolne do wysłania klientowi. Wspólny selekt dla GET /auth/me i dla odpowiedzi po
 * weryfikacji kodu — dzięki temu żaden endpoint nie dorzuca przez przypadek hasha hasła.
 * Eksportowany, bo PATCH/DELETE /api/account odpowiada tym samym kształtem.
 */
export const CLIENT_USER_SELECT = {
  id: true,
  email: true,
  encryption_salt: true,
  pages_current_limit: true,
  pages_total_processed: true,
  display_name: true,
  default_grade_threshold_id: true,
  low_balance_alert_threshold: true,
  group_assignment_mode: true,
  account_kind: true,
  subscription_tier: true,
  subscription_ends_at: true,
  email_verified_at: true,
  phone: true,
  is_phone_verified: true,
  created_at: true,
} satisfies Prisma.UserSelect;

/** Kształt użytkownika wolny do wysłania klientowi: kolumny z selekta, ale numer w masce. */
type ClientUser = Omit<Prisma.UserGetPayload<{ select: typeof CLIENT_USER_SELECT }>, 'phone'> & {
  phone: string | null;
};

/**
 * Wysyła maila z jednorazowym linkiem potwierdzający adres.
 * Token wraca w URL-u wprost, hash dopiero w bazie — wyciek bazy nie daje gotowych linków.
 */
async function sendVerificationEmail(email: string, token: string): Promise<void> {
  const verifyUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/verify-email?token=${token}`;

  await resend.emails.send({
    from: 'Belfero <no-reply@belfro.pl>',
    to: email,
    subject: 'Potwierdź adres email - Belfero',
    html: `
      <h2>Witaj w Belfero!</h2>
      <p>Kliknij poniższy przycisk, aby potwierdzić swój adres email:</p>
      <p>
        <a href="${verifyUrl}" style="display:inline-block;padding:12px 20px;background:#2563eb;color:#ffffff;border-radius:8px;text-decoration:none;">
          Potwierdź adres email
        </a>
      </p>
      <p>Link wygasa po ${VERIFICATION_TOKEN_EXPIRY_HOURS} godzinach.</p>
      <p>Jeśli nie zakładałeś konta w Belfero, po prostu zignoruj tę wiadomość.</p>
    `,
  });
}

/**
 * Generuje świeży link potwierdzający i zapisuje jego hash.
 * Zwraca false, gdy trwa cooldown — bez tego /resend-verification jest maszynką do spamu.
 */
async function issueVerificationLink(user: {
  id: string;
  email: string;
  verification_sent_at: Date | null;
}): Promise<boolean> {
  if (
    user.verification_sent_at &&
    Date.now() - user.verification_sent_at.getTime() < VERIFICATION_RESEND_COOLDOWN_MS
  ) {
    return false;
  }

  const token = generateResetToken();

  await prisma.user.update({
    where: { id: user.id },
    data: {
      verification_token: hashResetToken(token),
      verification_token_expires: new Date(
        Date.now() + VERIFICATION_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000
      ),
      verification_sent_at: new Date(),
    },
  });

  await sendVerificationEmail(user.email, token);
  return true;
}

/**
 * Numery w odpowiedziach i logach tylko w masce (+48*******80). Postać w clearze żyje wyłącznie
 * w bazie, bo na niej pracuje @unique; nauczyciel i tak widzi numer, który sam wpisał.
 */
export function withMaskedPhone<T extends { phone: string | null }>(
  user: T
): Omit<T, 'phone'> & { phone: string | null } {
  return { ...user, phone: maskPolishPhone(user.phone) };
}

/**
 * Kolumny, na których padło ograniczenie unikalności (P2002), albo pusta lista dla innych błędów.
 * Eksportowane, bo `studentController` rozpoznaje na tym samym duplikat numeru w klasie — drugi
 * kopiowany `instanceof Prisma.PrismaClientKnownRequestError` to proszenie się o rozjazd.
 */
export function uniqueViolationFields(error: unknown): string[] {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return [];
  }

  const target = error.meta?.target;
  if (Array.isArray(target)) return target.map(String);
  return target ? [String(target)] : [];
}

/** Pełna przestrzeń 000000-999999, równomiernie. Math.random nie ma tu prawa się pojawić. */
function generateSmsCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

function codeMatches(input: string, stored: string): boolean {
  const provided = Buffer.from(input, 'utf8');
  const expected = Buffer.from(stored, 'utf8');

  // timingSafeEqual rzuca przy różnych długościach, więc najpierw straż, potem porównanie.
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/**
 * GET /api/auth/captcha-config
 * Publiczny, bez JWT. Frontend nie buduje widgetu bez sitekeya, a klucze nie mają prawa
 * mieszkać w bundlu klienta — stąd jeden mały endpoint zami zmiennej VITE_*.
 */
export async function captchaConfig(_req: Request, res: Response): Promise<void> {
  res.json({ provider: 'turnstile', ...getTurnstileConfig() });
}

/**
 * POST /api/auth/register
 * Tworzy konto i wysyła link potwierdzający. Bez potwierdzonego adresu nie ma sesji,
 * więc response celowo nie zawiera JWT ani encryption_salt.
 * Telefon zapisujemy od razu, ale kod SMS idzie dopiero po pierwszym logowaniu — patrz sendSmsCode.
 */
export async function register(req: Request, res: Response): Promise<void> {
  try {
    const { email, password, phone, phoneConsent, turnstileToken, accountKind } = req.body;

    // Bramka na boty jako pierwsza czynność: zanim zapytamy bazę, policzymy bcrypt i wyślemy
    // maila. Niedostępny Cloudflare to 503, nie ciche przepuszczenie — bez weryfikacji konto
    // z 350 darmowymi stronami nie powstaje.
    try {
      await verifyTurnstileToken(turnstileToken);
    } catch (captchaError) {
      if (!(captchaError instanceof TurnstileError)) throw captchaError;

      res.status(captchaError.code === 'CAPTCHA_UNAVAILABLE' ? 503 : 400).json({
        error: captchaError.message,
        code: captchaError.code,
      });
      return;
    }

    // Typ konta jest deklaracją prawną, nie ozdobą formularza: rozstrzyga, czy w ogóle wolno nam
    // przechowywać imiona i nazwiska uczniów. Wartość domyślna byłaby tu zgadywaniem, więc brak
    // tego pola to błąd, a nie fallback.
    if (!isAccountKind(accountKind)) {
      res.status(400).json({
        error: `Account kind must be one of: ${ACCOUNT_KINDS.join(', ')}`,
        code: 'ACCOUNT_KIND_INVALID',
      });
      return;
    }

    // Walidacja
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required', code: 'CREDENTIALS_REQUIRED' });
      return;
    }

    if (!/^\S+@\S+\.\S+$/.test(String(email))) {
      res.status(400).json({ error: 'Invalid email address', code: 'EMAIL_INVALID' });
      return;
    }

    if (password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters long', code: 'PASSWORD_TOO_SHORT' });
      return;
    }

    // Telefon jest jedynym hamulcem dla mnożenia kont trialowych, więc bez niego konta nie tworzymy.
    if (!phone || !String(phone).trim()) {
      res.status(400).json({ error: 'Phone number is required', code: 'PHONE_REQUIRED' });
      return;
    }

    const normalizedPhone = normalizePolishPhone(phone);
    if (!normalizedPhone) {
      res.status(400).json({ error: 'Invalid phone number format', code: 'PHONE_INVALID' });
      return;
    }

    // Zgoda RODO walidowana po stronie serwera: checkbox w formularzu jest dekoracją, nie kontrolą.
    if (phoneConsent !== true) {
      res.status(400).json({
        error: 'Phone number processing consent is required',
        code: 'CONSENT_REQUIRED',
      });
      return;
    }

    // Sprawdź czy użytkownik już istnieje
    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      if (!existingUser.email_verified_at) {
        try {
          await issueVerificationLink(existingUser);
        } catch (sendError) {
          console.error('Błąd wysyłki emaila potwierdzającego:', sendError);
        }
        res.status(409).json({
          error: 'Email not verified. A new confirmation link has been sent.',
          code: 'VERIFICATION_LINK_RESENT',
        });
        return;
      }

      res.status(409).json({ error: 'User with this email already exists', code: 'EMAIL_TAKEN' });
      return;
    }

    // Świadomie rezygnujemy z ochrony przed enumeracją numerów: dzisiejszy register już ujawnia
    // istnienie adresu (VERIFICATION_LINK_RESENT), a konkretny komunikat jest wart więcej niż
    // teoretyczne ryzyko. Alternatywa to generyczne „nie udało się utworzyć konta”.
    const existingPhone = await prisma.user.findUnique({ where: { phone: normalizedPhone } });
    if (existingPhone) {
      res.status(400).json({
        error: 'This phone number is already linked to another account',
        code: 'PHONE_TAKEN',
      });
      return;
    }

    // Hash hasła
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Generuj encryption_salt (używany po stronie klienta do E2E encryption)
    const encryptionSalt = generateEncryptionSalt();

    // Utwórz użytkownika
    let user: UserRecord;
    try {
      user = await prisma.user.create({
        data: {
          email,
          password: passwordHash,
          encryption_salt: encryptionSalt,
          account_kind: accountKind,
          pages_current_limit: 350, // Domyślny limit free tier
          pages_total_processed: 0,
          subscription_tier: 'free',
          phone: normalizedPhone,
          is_phone_verified: false,
        },
      });
    } catch (createError) {
      // Dwa requesty na ten sam numer w tym samym ułamku sekundy: findUnique wyżej mógł nie
      // zdążyć, ale baza duplikatu nie puści. Bez tego gałęzi klient dostaje 500.
      const fields = uniqueViolationFields(createError);
      if (fields.includes('phone')) {
        res.status(400).json({
          error: 'This phone number is already linked to another account',
          code: 'PHONE_TAKEN',
        });
        return;
      }
      if (fields.includes('email')) {
        res.status(409).json({ error: 'User with this email already exists', code: 'EMAIL_TAKEN' });
        return;
      }
      throw createError;
    }

    try {
      await issueVerificationLink(user);
    } catch (sendError) {
      console.error('Błąd wysyłki emaila potwierdzającego:', sendError);
      res.status(502).json({
        error: 'Account created but the verification email could not be sent',
        code: 'VERIFICATION_EMAIL_FAILED',
      });
      return;
    }

    res.status(201).json({
      message: 'Verification email sent',
      email: user.email,
      phone: maskPolishPhone(user.phone),
      requires_phone_verification: true,
    });
  } catch (error) {
    console.error('Błąd rejestracji:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * POST /api/auth/login
 * Logowanie użytkownika
 */
export async function login(req: Request, res: Response): Promise<void> {
  try {
    const { email, password, turnstileToken } = req.body;

    // Logowanie jest jedyną bramką prowadzącą do gotowych kont, więc bez captcha jest zwykłym
    // credential stuffingiem. Weryfikacja przed bcryptem i bazą: odrzucony bot nic nie kosztuje.
    try {
      await verifyTurnstileToken(turnstileToken);
    } catch (captchaError) {
      if (!(captchaError instanceof TurnstileError)) throw captchaError;

      res.status(captchaError.code === 'CAPTCHA_UNAVAILABLE' ? 503 : 400).json({
        error: captchaError.message,
        code: captchaError.code,
      });
      return;
    }

    // Walidacja
    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required', code: 'CREDENTIALS_REQUIRED' });
      return;
    }

    // Znajdź użytkownika. Te same kolumny co GET /auth/me plus hash potrzebny bcryptowi — dwa
    // odrębne kształty tej samej karty były przyczyną, że ustawienia konta znikały po przelogowaniu.
    const user = await prisma.user.findUnique({
      where: { email },
      select: { ...CLIENT_USER_SELECT, password: true },
    });
    if (!user) {
      res.status(401).json({ error: 'Invalid email or password', code: 'INVALID_CREDENTIALS' });
      return;
    }

    // Response składamy wyłącznie z `account`: `password` zostaje w tej funkcji, bo `withMaskedPhone`
    // przepuszcza dalej wszystko, co w niego trafi.
    const { password: passwordHash, ...account } = user;

    // Sprawdź hasło
    if (!(await bcrypt.compare(password, passwordHash))) {
      res.status(401).json({ error: 'Invalid email or password', code: 'INVALID_CREDENTIALS' });
      return;
    }

    // Dopiero po hasle, żeby nie oddawać listy kont oczekujących na potwierdzenie
    if (!account.email_verified_at) {
      res.status(403).json({ error: 'Email address not verified', code: 'EMAIL_NOT_VERIFIED' });
      return;
    }

    // Wygeneruj JWT token
    const token = generateToken({ userId: account.id, email: account.email });

    // Niezweryfikowany telefon NIE blokuje logowania: bez tego tokenu i bez encryption_salt
    // klient nie ma czym poprosić o kod SMS, a klucz E2E i tak powstaje tylko z wpisanego hasła.
    res.json({
      message: 'Login successful',
      token,
      requires_phone_verification: !account.is_phone_verified,
      user: withMaskedPhone(account),
    });
  } catch (error) {
    console.error('Błąd logowania:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * POST /api/auth/forgot-password
 * Wysyła email z linkiem do resetowania hasła
 */
export async function forgotPassword(req: Request, res: Response): Promise<void> {
  try {
    const { email, turnstileToken } = req.body;

    // Ten endpoint wysyła płatnego maila na adres wskazany przez wołającego i nie ma żadnego
    // limitu, więc bez bramki jest gotową maszynką do spamu. Kolejność jak w register:
    // weryfikacja zanim zapytamy bazę i Resend.
    try {
      await verifyTurnstileToken(turnstileToken);
    } catch (captchaError) {
      if (!(captchaError instanceof TurnstileError)) throw captchaError;

      res.status(captchaError.code === 'CAPTCHA_UNAVAILABLE' ? 503 : 400).json({
        error: captchaError.message,
        code: captchaError.code,
      });
      return;
    }

    if (!email) {
      res.status(400).json({ error: 'Email is required', code: 'EMAIL_REQUIRED' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email } });

    // Z bezpieczeństwa zawsze zwracamy ten sam komunikat (nie ujawniamy czy email istnieje)
    if (!user) {
      res.json({ message: 'If an account with that email exists, a password reset link has been sent' });
      return;
    }

    // Wygeneruj reset token
    const resetToken = generateResetToken();
    const resetTokenHash = hashResetToken(resetToken);
    const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_HOURS * 60 * 60 * 1000);

    // Zapisz hash tokenu w bazie
    await prisma.user.update({
      where: { id: user.id },
      data: {
        reset_token: resetTokenHash,
        reset_token_expires: expiresAt,
      },
    });

    // Wyślij email przez Resend
    const resetUrl = `${process.env.FRONTEND_URL || 'http://localhost:5173'}/reset-password?token=${resetToken}`;

    await resend.emails.send({
      from: 'Belfero <no-reply@belfro.pl>',
      to: email,
      subject: 'Reset hasła - Belfero',
      html: `
        <h2>Reset hasła</h2>
        <p>Kliknij poniższy link, aby zresetować swoje hasło:</p>
        <a href="${resetUrl}">${resetUrl}</a>
        <p>Link wygasa za ${RESET_TOKEN_EXPIRY_HOURS} godzinę.</p>
        <p>Jeśli nie prosiłeś o reset hasła, zignoruj tę wiadomość.</p>
      `,
    });

    res.json({ message: 'If an account with that email exists, a password reset link has been sent' });
  } catch (error) {
    console.error('Błąd prośby o reset hasła:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * POST /api/auth/reset-password
 * Resetuje hasło używając tokenu z emaila
 * UWAGA: Resetowanie hasła generuje NOWY encryption_salt, więc stare zaszyfrowane dane uczniów
 * staną się nieodszyfrowane (co jest zgodne z architekturą zero-knowledge)
 */
export async function resetPassword(req: Request, res: Response): Promise<void> {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      res.status(400).json({ error: 'Token and new password are required', code: 'RESET_FIELDS_REQUIRED' });
      return;
    }

    if (newPassword.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters long', code: 'PASSWORD_TOO_SHORT' });
      return;
    }

    // Hash tokenu i znajdź użytkownika
    const tokenHash = hashResetToken(token);
    const user = await prisma.user.findFirst({
      where: {
        reset_token: tokenHash,
        reset_token_expires: { gt: new Date() }, // Token nie wygasł
      },
    });

    if (!user) {
      res.status(400).json({ error: 'Invalid or expired reset token', code: 'RESET_TOKEN_INVALID' });
      return;
    }

    // Wygeneruj NOWY encryption_salt (stare dane uczniów będą nieodszyfrowane)
    const newEncryptionSalt = generateEncryptionSalt();
    const newPasswordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // Zaktualizuj użytkownika
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: newPasswordHash,
        encryption_salt: newEncryptionSalt,
        reset_token: null,
        reset_token_expires: null,
      },
    });

    res.json({
      message: 'Password reset successful. Please note: encrypted student data will need to be re-entered.',
      encryption_salt: newEncryptionSalt,
    });
  } catch (error) {
    console.error('Błąd ustawiania nowego hasła:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * POST /api/auth/verify-email
 * Potwierdza adres email na podstawie tokenu z linku.
 * Token idzie w ciele requestu, nie w URL-u — link nie ma prawa trafić do logów serwera.
 */
export async function verifyEmail(req: Request, res: Response): Promise<void> {
  try {
    const { token } = req.body;

    if (!token) {
      res.status(400).json({ error: 'Token is required', code: 'TOKEN_REQUIRED' });
      return;
    }

    const user = await prisma.user.findFirst({
      where: {
        verification_token: hashResetToken(token),
        verification_token_expires: { gt: new Date() },
      },
    });

    if (!user) {
      res.status(400).json({ error: 'Invalid or expired verification token', code: 'VERIFICATION_TOKEN_INVALID' });
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        email_verified_at: new Date(),
        verification_token: null,
        verification_token_expires: null,
        verification_sent_at: null,
      },
    });

    res.json({ message: 'Email verified' });
  } catch (error) {
    console.error('Błąd potwierdzania emaila:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * POST /api/auth/resend-verification
 * Wysyła link potwierdzający ponownie. Odpowiada tak samo dla znanego i nieznanego adresu.
 */
export async function resendVerification(req: Request, res: Response): Promise<void> {
  const genericMessage = { message: 'If the account is waiting for confirmation, a link has been sent' };

  try {
    const { email } = req.body;

    if (!email) {
      res.status(400).json({ error: 'Email is required', code: 'EMAIL_REQUIRED' });
      return;
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (user && !user.email_verified_at) {
      try {
        await issueVerificationLink(user);
      } catch (sendError) {
        console.error('Błąd wysyłki emaila potwierdzającego:', sendError);
      }
    }

    res.json(genericMessage);
  } catch (error) {
    console.error('Błąd ponawiania linku potwierdzającego:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * GET /api/auth/me
 * Zwraca dane zalogowanego użytkownika (wymaga JWT)
 */
export async function getCurrentUser(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: CLIENT_USER_SELECT,
    });

    if (!user) {
      res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
      return;
    }

    res.json({ user: withMaskedPhone(user) });
  } catch (error) {
    console.error('Błąd pobierania bieżącego konta:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/** Kod wygasły albo przestrzelony limit prób kasujemy — nie może czekać na zgadywacza. */
async function clearSmsCode(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { sms_code: null, sms_code_expires: null, sms_code_attempts: 0 },
  });
}

/**
 * POST /api/auth/send-sms-code
 * Chroniony JWT-em, a numer bieremy wyłącznie z rekordu: request nie niesie numeru, więc
 * zalogowany atakujący nie ma czym wysłać kodu na cudzy telefon.
 * Kod przysyłamy na prośbę właściciela konta po zalogowaniu, nigdy przy rejestracji —
 * automatyczna wysyłka pozwoliłaby zapisać numer ofiary, zablokować jej rejestrację i obciążyć
 * nasze konto za SMS-y, których nikt nie zamówił.
 */
export async function sendSmsCode(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;

  try {
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        phone: true,
        email_verified_at: true,
        sms_code_sent_at: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
      return;
    }

    if (!user.email_verified_at) {
      res.status(403).json({ error: 'Email address not verified', code: 'EMAIL_NOT_VERIFIED' });
      return;
    }

    // Konta założone przed bramką nie mają numeru — nie wysyłamy kodu w próżnię.
    if (!user.phone) {
      res.status(400).json({ error: 'No phone number on this account', code: 'PHONE_MISSING' });
      return;
    }

    if (user.sms_code_sent_at) {
      const elapsed = Date.now() - user.sms_code_sent_at.getTime();
      if (elapsed < SMS_COOLDOWN_MS) {
        res.status(429).json({
          error: 'Code was sent recently, please wait',
          code: 'SMS_COOLDOWN_ACTIVE',
          retry_after_seconds: Math.ceil((SMS_COOLDOWN_MS - elapsed) / 1000),
        });
        return;
      }
    }

    const code = generateSmsCode();

    await prisma.user.update({
      where: { id: user.id },
      data: {
        sms_code: code,
        sms_code_expires: new Date(Date.now() + SMS_CODE_TTL_MS),
        sms_code_sent_at: new Date(),
        sms_code_attempts: 0,
      },
    });

    try {
      const result = await getSmsProvider().send({
        to: user.phone,
        text: buildVerificationSmsText(code),
      });

      if (!result.ok) {
        throw new SmsProviderError('Bramka SMS nie potwierdziła wysyłki');
      }
    } catch (sendError) {
      console.error(
        'Błąd wysyłki kodu SMS:',
        sendError instanceof SmsProviderError ? sendError.message : sendError
      );

      // Skoro SMS nie poszedł, cooldown za niego nie może trzymać nauczyciela pod zamkiem.
      await prisma.user.update({
        where: { id: user.id },
        data: { sms_code: null, sms_code_expires: null, sms_code_sent_at: null },
      });

      res.status(502).json({
        error: 'Verification code could not be sent',
        code: 'SMS_SEND_FAILED',
      });
      return;
    }

    res.json({
      message: 'Kod weryfikacyjny został wysłany.',
      expires_in_seconds: Math.floor(SMS_CODE_TTL_MS / 1000),
      retry_after_seconds: Math.floor(SMS_COOLDOWN_MS / 1000),
      phone: maskPolishPhone(user.phone),
    });
  } catch (error) {
    console.error('Błąd wysyłki kodu SMS:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * POST /api/auth/verify-sms-code
 * Domyka bramkę kontaktu: po właściwym kodzie konto dostaje is_phone_verified = true, a kod
 * znika z bazy razem z licznikiem prób.
 */
export async function verifySmsCode(req: Request, res: Response): Promise<void> {
  const userId = req.user?.userId;

  try {
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const { code } = req.body;
    const submitted = typeof code === 'string' ? code.trim() : '';

    if (!/^\d{6}$/.test(submitted)) {
      res.status(400).json({ error: 'Verification code must be 6 digits', code: 'SMS_CODE_INVALID' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email_verified_at: true,
        is_phone_verified: true,
        sms_code: true,
        sms_code_expires: true,
        sms_code_attempts: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
      return;
    }

    if (!user.email_verified_at) {
      res.status(403).json({ error: 'Email address not verified', code: 'EMAIL_NOT_VERIFIED' });
      return;
    }

    const clientUser = async (): Promise<ClientUser | null> => {
      const fresh = await prisma.user.findUnique({ where: { id: userId }, select: CLIENT_USER_SELECT });
      return fresh ? withMaskedPhone(fresh) : null;
    };

    // Idempotentność: odświeżona karta albo drugi klik nie mogą zgłaszać błędu.
    if (user.is_phone_verified) {
      res.json({ message: 'Konto jest już zweryfikowane.', user: await clientUser() });
      return;
    }

    if (!user.sms_code) {
      res.status(400).json({ error: 'No active verification code', code: 'SMS_CODE_MISSING' });
      return;
    }

    if (user.sms_code_attempts >= SMS_MAX_ATTEMPTS) {
      await clearSmsCode(user.id);
      res.status(403).json({ error: 'Too many attempts', code: 'SMS_ATTEMPTS_EXCEEDED' });
      return;
    }

    if (!user.sms_code_expires || user.sms_code_expires.getTime() < Date.now()) {
      await clearSmsCode(user.id);
      res.status(400).json({ error: 'Verification code expired', code: 'SMS_CODE_EXPIRED' });
      return;
    }

    if (!codeMatches(submitted, user.sms_code)) {
      await prisma.user.update({
        where: { id: user.id },
        data: { sms_code_attempts: { increment: 1 } },
      });

      // Ostatnia źle trafiona próba unieważnia kod od razu, bez czekania na kolejne zgadywanie.
      if (user.sms_code_attempts + 1 >= SMS_MAX_ATTEMPTS) {
        await clearSmsCode(user.id);
        res.status(403).json({ error: 'Too many attempts', code: 'SMS_ATTEMPTS_EXCEEDED' });
        return;
      }

      res.status(400).json({ error: 'Incorrect verification code', code: 'SMS_CODE_INVALID' });
      return;
    }

    // Transakcja: flip flagi i kasacja kodu albo nic. Odpowiedź czytamy po zapisie, żeby
    // klient nie dostał stanu sprzed weryfikacji i nie pokazał bramki raz jeszcze.
    const updated = await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          is_phone_verified: true,
          sms_code: null,
          sms_code_expires: null,
          sms_code_attempts: 0,
        },
      });

      const fresh = await tx.user.findUnique({ where: { id: user.id }, select: CLIENT_USER_SELECT });
      return fresh ? withMaskedPhone(fresh) : null;
    });

    res.json({ message: 'Numer telefonu zweryfikowany.', user: updated });
  } catch (error) {
    console.error('Błąd weryfikacji kodu SMS:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}
