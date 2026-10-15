/**
 * Normalizacja i maskowanie polskich numerów komórkowych.
 * Jedno miejsce prawdy: rejestracja, wysyłka kodu i weryfikacja muszą widzieć ten sam ciąg,
 * bo na `users.phone` stoi @unique — dwa zapisy „48 600 700 800” i „+48600700800” to inaczej
 * dwa konta na ten sam telefon, czyli dokładnie obejście bramki anty-trialowej.
 */

/** Prefiks państwowy zapisywany w bazie. Poza Polską numerów nie przyjmujemy. */
const POLISH_PREFIX = '+48';

/**
 * Zamienia dowolny ludzki zapis numeru na E.164 `+48XXXXXXXXX`.
 * Zwraca null, gdy to nie polski numer komórkowy — bez wyjątku, żeby kontroler nie musiał
 * rozróżniać „pustego pola” od „numeru z innego kraju”.
 */
export function normalizePolishPhone(input: unknown): string | null {
  if (typeof input !== 'string') return null;

  // Zostawiamy same cyfry: spacje, myślniki, kropki i nawiasy są dowolne.
  const digits = input.replace(/\D/g, '');

  let body: string;

  if (digits.length === 12 && digits.startsWith('0048')) {
    body = digits.slice(4); // 0048 600 700 800
  } else if (digits.length === 11 && digits.startsWith('48')) {
    body = digits.slice(2); // 48 600 700 800 oraz +48... ('+' wypada przy wycinaniu znaków)
  } else if (digits.length === 9) {
    body = digits; // 600 700 800 bez prefiksu
  } else {
    return null;
  }

  // Polska komórka to 9 cyfr i nigdy nie zaczyna się od zera.
  if (!/^[1-9]\d{8}$/.test(body)) return null;

  return `${POLISH_PREFIX}${body}`;
}

export function isValidPolishPhone(input: unknown): boolean {
  return normalizePolishPhone(input) !== null;
}

/**
 * Postać do logów i odpowiedzi HTTP: prefiks i dwie ostatnie cyfry.
 * Numeru w clearze nie wolno wyprowadzić — to dane osobowe nauczyciela.
 */
export function maskPolishPhone(phone: string | null | undefined): string {
  if (!phone) return '';

  const body = phone.startsWith(POLISH_PREFIX) ? phone.slice(POLISH_PREFIX.length) : phone;
  if (!/^\d{9}$/.test(body)) return '+48*******';

  return `${POLISH_PREFIX}${'*'.repeat(7)}${body.slice(7)}`;
}

/** Czytelny dla formularza komunikat — ten sam tekst po obu stronach aplikacji. */
export const POLISH_PHONE_HINT = 'Podaj polski numer komórkowy w formacie +48 600 700 800';
