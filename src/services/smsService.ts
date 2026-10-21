import { randomUUID } from 'crypto';
import { maskPolishPhone } from '../utils/phone';

/**
 * Abstrakcja nad polską bramką SMS. Kontrolery znają tylko `getSmsProvider().send(...)`,
 * więc podmiana placeholdera na produkcyjną bramkę to zmiana jednej zmiennej środowiskowej.
 */

export interface SmsMessage {
  /** E.164 po normalizacji, np. +48600700800 */
  to: string;
  text: string;
}

export interface SmsSendResult {
  ok: boolean;
  providerId?: string;
}

export interface SmsProvider {
  readonly name: string;
  send(message: SmsMessage): Promise<SmsSendResult>;
}

/**
 * Każda porażka bramki ma ten sam kod, żeby kontroler mógł go przełożyć na jeden
 * polski komunikat i cofnąć zapis kodu w bazie.
 */
export class SmsProviderError extends Error {
  readonly code = 'SMS_SEND_FAILED';

  constructor(message: string) {
    super(message);
    this.name = 'SmsProviderError';
  }
}

const SMS_REQUEST_TIMEOUT_MS = 8000;

function senderName(): string {
  return process.env.SMS_SENDER_NAME || 'belfro.pl';
}

/** Treść SMS-a w jednym miejscu — jeden komunikat, jedna długość, jedna interpretacja bramki. */
export function buildVerificationSmsText(code: string): string {
  return `Kod weryfikacyjny Belfro: ${code}. Wygasnie w 5 minut. Nie udostepniaj go nikomu.`;
}

async function postWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SMS_REQUEST_TIMEOUT_MS);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    throw new SmsProviderError(
      aborted ? 'Bramka SMS nie odpowiedziała w terminie' : 'Nie udało się połączyć z bramką SMS'
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * body bramki bywa JSON-em, ale przy błędzie proxy bywa HTML-em.
 * Nie wyciągamy z niego nic poza statusem — treść mogłaby zawierać numer telefonu.
 */
async function readJsonBody(response: Response): Promise<Record<string, unknown> | null> {
  const text = await response.text().catch(() => '');
  if (!text) return null;

  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function providerIdFrom(payload: Record<string, unknown> | null): string | undefined {
  if (!payload) return undefined;

  const direct = payload.id ?? payload.sms_id ?? payload.request_id;
  if (typeof direct === 'string' || typeof direct === 'number') return String(direct);

  const list = payload.list;
  if (Array.isArray(list)) {
    const first = list[0];
    if (first && typeof first === 'object' && 'id' in first) {
      const id = (first as { id?: string | number }).id;
      if (typeof id === 'string' || typeof id === 'number') return String(id);
    }
  }

  const data = payload.data;
  if (data && typeof data === 'object' && 'id' in data) {
    const id = (data as { id?: string | number }).id;
    if (typeof id === 'string' || typeof id === 'number') return String(id);
  }

  return undefined;
}

/**
 * Bramka bywa szczera i cytuje numer odbiorcy we własnym komunikacie błędu, a ten tekst
 * kontroler niesie do `console.error`. Każdą wielocyfrową sekwencję maskujemy; kody błędu
 * i liczby punktów są krótsze, więc zostają czytelne.
 */
function maskProviderDigits(message: string): string {
  return message.replace(/\+?\d[\d -]{6,}\d/g, '***');
}

/**
 * Placeholder deweloperski: kod trafia do konsoli serwera, numer zawsze w masce.
 * To domyślny provider, gdy SMS_PROVIDER nie jest ustawiony.
 */
class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'log';

  async send({ to, text }: SmsMessage): Promise<SmsSendResult> {
    console.log(`[SMS:log] do=${maskPolishPhone(to)}`);
    console.log(`[SMS:log] treść: ${text}`);
    return { ok: true, providerId: 'console' };
  }
}

/** SMSAPI v2 (api.smsapi.pl), autoryzacja tokenem panelowym w nagłówku Bearer. */
class SmsapiProvider implements SmsProvider {
  readonly name = 'smsapi';

  async send({ to, text }: SmsMessage): Promise<SmsSendResult> {
    const token = process.env.SMSAPI_TOKEN;
    if (!token) {
      throw new SmsProviderError('Bramka SMSAPI wymaga ustawienia SMSAPI_TOKEN');
    }

    const response = await postWithTimeout('https://api.smsapi.pl/sms.do', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ to, message: text, from: senderName() }),
    });

    const payload = await readJsonBody(response);

    if (!response.ok) {
      throw new SmsProviderError(`SMSAPI odrzuciło zapytanie (status ${response.status})`);
    }

    // SMSAPI potrafi zwrócić 200 z błędem w ciele — sam status HTTP to nie dowód wysyłki.
    if (payload && typeof payload.error === 'string') {
      throw new SmsProviderError(`SMSAPI odrzuciło wiadomość: ${payload.error}`);
    }

    return { ok: true, providerId: providerIdFrom(payload) };
  }
}

/** SerwerSMS.pl (api2.serwersms.pl), autoryzacja tokenem API w nagłówku Bearer. */
class SerwerSmsProvider implements SmsProvider {
  readonly name = 'serwersms';

  async send({ to, text }: SmsMessage): Promise<SmsSendResult> {
    const apiKey = process.env.SERWERSMS_API_KEY;
    if (!apiKey) {
      throw new SmsProviderError('Bramka SerwerSMS wymaga ustawienia SERWERSMS_API_KEY');
    }

    const username = process.env.SERWERSMS_USERNAME;
    if (!username) {
      throw new SmsProviderError('Bramka SerwerSMS wymaga ustawienia SERWERSMS_USERNAME');
    }

    const response = await postWithTimeout('https://api2.serwersms.pl/messages/message', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      // `to` to w tym API nazwa nadawcy, a adresatem jest element tablicy `numbers`.
      body: JSON.stringify({ to: senderName(), numbers: [to], message: text }),
    });

    const payload = await readJsonBody(response);

    if (!response.ok) {
      throw new SmsProviderError(`SerwerSMS odrzuciło zapytanie (status ${response.status})`);
    }

    if (payload && typeof payload.error === 'string') {
      throw new SmsProviderError(`SerwerSMS odrzuciło wiadomość: ${payload.error}`);
    }

    return { ok: true, providerId: providerIdFrom(payload) };
  }
}

/**
 * HostedSMS.pl (DCS) — `SimpleApi`. Autoryzacja loginem i hasłem panelu w ciele zapytania,
 * bez tokenów ani nagłówków, więc nadaje się do podmiany przez same zmienne środowiskowe.
 */
class HostedSmsProvider implements SmsProvider {
  readonly name = 'hostedsms';

  async send({ to, text }: SmsMessage): Promise<SmsSendResult> {
    const email = process.env.SMS_HOSTEDSMS_EMAIL;
    if (!email) {
      throw new SmsProviderError('Bramka HostedSMS wymaga ustawienia SMS_HOSTEDSMS_EMAIL');
    }

    const password = process.env.SMS_HOSTEDSMS_PASSWORD;
    if (!password) {
      throw new SmsProviderError('Bramka HostedSMS wymaga ustawienia SMS_HOSTEDSMS_PASSWORD');
    }

    const response = await postWithTimeout('https://api.hostedsms.pl/SimpleApi', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        UserEmail: email,
        Password: password,
        Sender: senderName(),
        // Bramka chce samych cyfr z prefiksem państwowym: 48600700800, bez „+".
        Phone: to.replace(/^\+/, ''),
        Message: text,
        // Bez unikalnego „v" bramka trzyma przez dobę identyczną parę (numer, treść)
        // i przy powtórzeniu tylko zwraca stary identyfikator — drugi kod by nie doszedł,
        // a my uznalibyśmy wysyłkę za udaną.
        v: randomUUID(),
      }),
    });

    const payload = await readJsonBody(response);

    if (!response.ok) {
      throw new SmsProviderError(`HostedSMS odrzuciło zapytanie (status ${response.status})`);
    }

    const messageId = payload?.MessageId;
    if (typeof messageId === 'string' || typeof messageId === 'number') {
      return { ok: true, providerId: String(messageId) };
    }

    // SimpleApi zgłasza odrzucenie właśnie tak: HTTP 200 bez `MessageId`. Brak identyfikatora
    // jest więc porażką — pustego ciała nigdy nie traktujemy jak udanej wysyłki.
    const errorMessage = typeof payload?.ErrorMessage === 'string' ? maskProviderDigits(payload.ErrorMessage) : '';
    throw new SmsProviderError(
      errorMessage ? `HostedSMS odrzuciło wiadomość: ${errorMessage}` : 'HostedSMS nie zwróciło identyfikatora wiadomości'
    );
  }
}

let cachedProvider: SmsProvider | null = null;

/**
 * Leniwy singleton wzorcem getAnthropicClient(): instancja powstaje przy pierwszej wysyłce,
 * więc brak kluczy nie powala startu aplikacji — rzuca dopiero w momencie, gdy realnie wysyłamy.
 */
export function getSmsProvider(): SmsProvider {
  if (cachedProvider) return cachedProvider;

  const configured = (process.env.SMS_PROVIDER || 'log').trim().toLowerCase();

  switch (configured) {
    case 'log':
      cachedProvider = new ConsoleSmsProvider();
      break;
    case 'smsapi':
      cachedProvider = new SmsapiProvider();
      break;
    case 'serwersms':
      cachedProvider = new SerwerSmsProvider();
      break;
    case 'hostedsms':
      cachedProvider = new HostedSmsProvider();
      break;
    default:
      throw new SmsProviderError(
        `Nieznany provider SMS: ${configured}. Dozwolone: log, smsapi, serwersms, hostedsms`
      );
  }

  return cachedProvider;
}
