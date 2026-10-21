import { Prisma } from '@prisma/client';

/**
 * Dwa rodzaje konta i dwa sposoby oznaczania ucznia.
 *
 * Konto `private` to nauczyciel bez umowy powierzenia danych ze szkołą — u niego imię i nazwisko
 * ucznia nie mogą trafić do bazy nawet zaszyfrowane, bo klucza i tak nie weryfikujemy po stronie
 * serwera. Jedynym oznaczeniem pracy zostaje numer z dziennika. Konto `school` działa dokładnie
 * tak, jak aplikacja działała od początku: trzy pola szyfrowane w przeglądarce nauczyciela.
 */
export const ACCOUNT_KINDS = ['school', 'private'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

/** `named` = imię, nazwisko i numer (jak dziś). `numbered` = tylko numer z dziennika. */
export const ROSTER_MODES = ['named', 'numbered'] as const;
export type RosterMode = (typeof ROSTER_MODES)[number];

/** Sufit klasy. Polska klasa liczy zwykle do trzydziestu kilku uczniów, więc setka to widełki z zapasem na klasy łączone. */
export const MAX_ROSTER_SIZE = 100;

export function isAccountKind(value: unknown): value is AccountKind {
  return typeof value === 'string' && (ACCOUNT_KINDS as readonly string[]).includes(value);
}

/**
 * Tryb listy zawsze wynika z typu konta, nigdy z pola w ciele requestu. Klient, który mógłby go
 * wybrać, mógłby też poprosić o klasę z nazwiskami na koncie prywatnym — a to jest dokładnie ta
 * rzecz, której ta zmiana ma pilnować.
 */
export function rosterModeFor(accountKind: string): RosterMode {
  return accountKind === 'private' ? 'numbered' : 'named';
}

/**
 * Każda liczba porządkowa w tej domenie: liczba uczniów przy zakładaniu klasy, liczba dokładana
 * później i pojedynczy numer ucznia. `null` znaczy „nie przeszło walidacji" — brak wartości,
 * nie liczba, ułamek, zero albo powyżej sufitu klasy.
 */
export function parseRosterNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_ROSTER_SIZE) {
    return null;
  }
  return value;
}

/** Gotowe wiersze `students` z numerami `from, from + 1, …` dla danej klasy. */
export function buildNumberedRoster(classId: string, from: number, count: number) {
  return Array.from({ length: count }, (_, index) => ({
    class_id: classId,
    journal_number: from + index,
  }));
}

/**
 * Wspólny porządek listy uczniów. W klasie numerowanej decyduje numer, w klasie z nazwiskami
 * wszystkie `journal_number` są NULL-ami, więc realnie sortujemy po `created_at` — tak jak przed
 * tą zmianą. Jeden `orderBy` obsługuje oba tryby, więc żaden endpoint nie musi wiedzieć, w którym
 * właśnie pracuje.
 */
export const STUDENT_ORDER: Prisma.StudentOrderByWithRelationInput[] = [
  { journal_number: 'asc' },
  { created_at: 'asc' },
];
