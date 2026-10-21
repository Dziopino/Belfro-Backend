import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';
import prisma from '../config/database';
import { ANONYMIZED_DIR, absoluteUploadPath } from '../config/paths';
import { enhanceAnonymizedScan } from '../utils/scanEnhancement';
import {
  detectVariantFromImage,
  gradeWithHybridAI,
  MIN_VARIANT_CONFIDENCE,
  variantResolver,
  type VariantInput,
} from '../services/aiGradingService';
import { normalizeTasks, toTaskArray } from './answerKeyController';

// Po tym czasie sesja w statusie "processing" jest uznawana za porzuconą i może zostać przejęta
const STALE_PROCESSING_CLAIM_MS = 15 * 60 * 1000;

// Pasek węższy niż tyle pikseli niczego nie zasłania; interfejs i tak nie pozwala narysować mniejszego
const MIN_REDACTION_PX = 10;

// Maksymalna długość nazwy sesji — tyle samo ile limit nazwy klucza w biblioteki (answerKeyController)
const SESSION_NAME_MAX_LENGTH = 100;

/**
 * Granica `grades.variant_note`. To zdanie dla nauczyciela, a nie pole do przeszukiwania, więc nie
 * ma powodu trzymać w bazie całości odpowiedzi modelu albo długiego komunikatu providera.
 */
const VARIANT_NOTE_MAX_LENGTH = 300;

/**
 * Nazwa sesji dla historii: kopiowana z nazwy klucza odpowiedzi w chwili tworzenia sesji.
 * Kopia, nie referencja — późniejsza zmiana nazwy klucza w bibliotece nie może przepisać
 * wierszy w `grading_sessions`, bo historia pokazuje nazwę z chwili sprawdzania.
 *
 * Unikalność nazwy w obrębie nauczyciela zapewnia ten kod (przyrostki `_2`, `_3`), nie baza.
 * Bez constraintu UNIQUE: kolizja w jednym ułamku sekundy da tylko dwie sesje z tą samą
 * etykietą, a z UNIQUE dostałbyśmy 500 po tym, jak skany już zostały fizycznie zapisane.
 */
async function resolveUniqueSessionName(
  userId: string,
  baseName: string | null | undefined
): Promise<string | null> {
  const trimmed = typeof baseName === 'string' ? baseName.trim() : '';
  if (!trimmed) return null;

  const base = trimmed.slice(0, SESSION_NAME_MAX_LENGTH);

  const existing = await prisma.gradingSession.findMany({
    where: {
      user_id: userId,
      OR: [{ name: base }, { name: { startsWith: `${base}_` } }],
    },
    select: { name: true },
  });

  // 0 = nazwa bazowa wolna. Same nazwy bazowe podnoszą licznik na 1, więc dalej wyjdzie `_2`.
  let max = 0;

  for (const { name } of existing) {
    if (typeof name !== 'string') continue;

    if (name === base) {
      max = Math.max(max, 1);
      continue;
    }

    const suffix = name.slice(base.length + 1);
    // Stały wzorzec na wyłącznie cyfry — tekst użytkownika nigdy nie trafia do RegExp.
    if (/^\d+$/.test(suffix)) {
      max = Math.max(max, Number(suffix));
    }
  }

  return max === 0 ? base : `${base}_${max + 1}`;
}

// Tyle nieobecności przyjmiemy w jednym żądaniu; klasa liceum liczy najwyżej trzydzieści parę osób
const ABSENT_STUDENTS_MAX_COUNT = 200;

type AbsentIdsResult = { ok: true; ids: string[] } | { ok: false; code: string; error: string };

/**
 * Lista nieobecnych to input z przeglądarki. Oczekujemy tablicy identyfikatorów uczniów;
 * powtórki są bez znaczenia, więc zwracamy listę zdedupowaną.
 */
function parseAbsentIdsPayload(value: unknown): AbsentIdsResult {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      code: 'ABSENT_STUDENTS_INVALID',
      error: 'absent_student_ids must be an array of student IDs',
    };
  }

  if (value.length > ABSENT_STUDENTS_MAX_COUNT) {
    return {
      ok: false,
      code: 'ABSENT_STUDENTS_TOO_MANY',
      error: `absent_student_ids must contain at most ${ABSENT_STUDENTS_MAX_COUNT} entries`,
    };
  }

  if (value.some((id) => typeof id !== 'string' || id.trim() === '')) {
    return { ok: false, code: 'ABSENT_STUDENTS_INVALID', error: 'absent_student_ids must contain student IDs' };
  }

  return { ok: true, ids: Array.from(new Set(value as string[])) };
}

/**
 * Każdy nieobecny musi być uczniem tej klasy. Bez tego sprawdzania dałoby się zapisać w sesji
 * cudzy identyfikator, a historia pokazałaby liczbę nieobecnych z sufitu.
 */
async function absentIdsBelongToClass(ids: string[], classId: string): Promise<boolean> {
  if (ids.length === 0) return true;

  const found = await prisma.student.count({
    where: { id: { in: ids }, class_id: classId },
  });

  return found === ids.length;
}

// ============================================
// GRUPY WEWNĄTRZ SESJI (warianty A, B, C)
// ============================================

// Osiem wariantów to i tak więcej, niż da się sprawdzić na jednej lekcji. Limit działa zanim
// zaczniemy odpytywać bazę per grupa, więc żądanie nie zamieni się w osiem zapytań z sufitu.
const SESSION_GROUPS_MAX_COUNT = 8;
const GROUP_NAME_MAX_LENGTH = 30;
const GROUP_STUDENTS_MAX_COUNT = 200;

type SessionGroupWrite = {
  name: string;
  position: number;
  answer_key: Prisma.InputJsonValue;
  answer_key_id: string | null;
  keyName: string | null;
  student_ids: string[];
};

type SessionGroupsResult =
  | { ok: true; groups: SessionGroupWrite[] }
  | { ok: false; code: string; error: string };

/** Tablica UUID w JSON-ie zwraca tylko to, co naprawdę da się użyć: stringy bez duplikatów. */
function idsFromJsonArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return Array.from(
    new Set(value.filter((id): id is string => typeof id === 'string' && id.trim() !== ''))
  );
}

type AnswerKeySnapshot = { key: Prisma.InputJsonValue; keyName: string | null };

type AnswerKeySnapshotResult = { ok: true; snapshot: AnswerKeySnapshot } | { ok: false; code: string; error: string };

/** Wariant z biblioteki: kolumny answer_key_groups w kształcie potrzebnym do zamrożenia snapshotu. */
type KeyVariant = {
  id: string;
  position: number;
  name: string;
  tasks: unknown;
  total_points: number;
};

type LibraryKey = { id: string; name: string; tasks: unknown; total_points: number; variants: KeyVariant[] };

type LibraryKeyResult = { ok: true; key: LibraryKey | null } | { ok: false; code: string; error: string };

/**
 * Klucz z biblioteki wraz ze swoimi wariantami, jednym zapytaniem. Zwraca null, gdy żądanie w ogóle
 * nie podało answer_key_id (klucz wpisany ręcznie). Cudzy id to ten sam ANSWER_KEY_NOT_OWNED co
 * dotąd — nie sprawdzamy, czy klucz należy do kogoś innego, tylko odrzcamy takie żądanie.
 */
async function loadLibraryKey(answerKeyId: unknown, userId: string): Promise<LibraryKeyResult> {
  const id = typeof answerKeyId === 'string' && answerKeyId.length > 0 ? answerKeyId : null;
  if (!id) return { ok: true, key: null };

  const found = await prisma.answerKey.findFirst({
    where: { id, user_id: userId },
    select: {
      id: true,
      name: true,
      tasks: true,
      total_points: true,
      answer_key_groups: { orderBy: { position: 'asc' }, select: { id: true, position: true, name: true, tasks: true, total_points: true } },
    },
  });

  if (!found) {
    return { ok: false, code: 'ANSWER_KEY_NOT_OWNED', error: 'Answer key does not belong to this user' };
  }

  return { ok: true, key: { ...found, variants: found.answer_key_groups } };
}

/**
 * Snapshot klucza odpowiedzi z biblioteki albo prosto z żądania. Biblioteka wygrywa treścią, nie
 * referencją — edycja klucza później nie może przerabiać już sprawdzonych prac.
 */
function snapshotFromLibraryKey(key: LibraryKey): AnswerKeySnapshot {
  return {
    key: {
      tasks: toTaskArray(key.tasks),
      total_points: key.total_points,
    } as Prisma.InputJsonValue,
    keyName: key.name,
  };
}

/**
 * Snapshot klucza wpisanego przez nauczyciela, czyli prosto z żądania. Przechodzi przez
 * `normalizeTasks` dokładnie tak samo jak ścieżka biblioteki: bez tego podpunkty mogłyby trafić
 * do sesji w kształcie, którego `/process` i tak nie rozumie — suma inna niż suma wierszy,
 * powtórzone identyfikatory, brak stawki. Snapshot jest potem jedynym źródłem skali tej pracy,
 * więc nie ma drugiej okazji, żeby to naprawić.
 */
function snapshotFromRequest(source: { answer_key?: unknown }): AnswerKeySnapshotResult {
  const raw = source.answer_key as { tasks?: unknown } | null;
  const normalized = normalizeTasks(raw?.tasks);
  if ('error' in normalized) return { ok: false, code: normalized.code, error: normalized.error };

  return {
    ok: true,
    snapshot: {
      key: {
        tasks: normalized.tasks,
        total_points: normalized.total_points,
      } as Prisma.InputJsonValue,
      keyName: null,
    },
  };
}

/**
 * Warianty do zamrożenia na sesji, w której wariant pracy rozpoznaje AI. Kształt jest celowo taki sam
 * jak snapshotu klucza (`{tasks, total_points}`), bo z niego buduje się prompt rozpoznania: `toTaskArray`
 * normalizuje i sortuje zadania identycznie jak `snapshotFromLibraryKey`, więc prefiks cache'a między
 * kartkami jednej sesji jest naprawdę ten sam.
 *
 * Id wariantu z biblioteki celowo nie wchodzi do listy — po zamrożeniu nie wolno już niczego z niej
 * czytać, a numer pozycji zostałby z tego, co klucz miał w chwili tworzenia sesji.
 */
function freezeVariants(variants: KeyVariant[]) {
  return variants.map((variant, index) => ({
    name: variant.name,
    position: index,
    answer_key: {
      tasks: toTaskArray(variant.tasks),
      total_points: variant.total_points,
    },
  }));
}

/**
 * Grupa = wariant arkusza dla części klasy: własny klucz odpowiedzi i własna lista uczniów.
 * Warianty definiuje się w kluczu odpowiedzi, więc żądanie niesie TYLKO przydział uczniów
 * {name, student_ids}; klucz grupy składa serwer z wariantu biblioteki. Dzięki temu klient
 * nie może podsunąć pod nazwę grupy cudzego klucza ani innego mianownika punktów.
 * Zasady, bez których sesji grupowej nie da się później odratować:
 * - listy uczniów nie mogą się przenikać — ten sam uczeń z dwoma wersjami pracy to dwa wyniki;
 * - każdy identyfikator musi być uczniem tej klasy — cudzy UUID zawyżyłby mianownik „brak pracy";
 * - każda nazwa z żądania musi odpowiadać wariantowi z klucza.
 * Wiersz powstaje dla KAŻDEGO wariantu klucza, także dla tego, do którego nie przydzielono nikogo.
 * Grupa pusta nie jest dekoracją: gdy w innym terminie napisze ją uczeń zdjęty z nieobecności,
 * przydział szuka jej w wierszach sesji — bez wiersza nie ma czym sprawdzić tego arkusza. `position`
 * bierze kolejność wariantów z klucza, więc nauczyciel widzi grupy tak samo w kreatorze, w kolejce,
 * w historii i w PDF, niezależnie od tego, kogo i w jakiej kolejności przypiął.
 */
async function parseSessionGroups(
  value: unknown,
  classId: string,
  key: LibraryKey | null
): Promise<SessionGroupsResult> {
  if (value === undefined || value === null) return { ok: true, groups: [] };

  if (!Array.isArray(value)) {
    return { ok: false, code: 'GROUPS_INVALID', error: 'groups must be an array' };
  }

  if (value.length === 0) {
    return { ok: false, code: 'GROUPS_INVALID', error: 'groups must contain at least one group' };
  }

  if (value.length > SESSION_GROUPS_MAX_COUNT) {
    return {
      ok: false,
      code: 'GROUPS_LIMIT_EXCEEDED',
      error: `groups must contain at most ${SESSION_GROUPS_MAX_COUNT} entries`,
    };
  }

  if (!key) {
    return {
      ok: false,
      code: 'GROUPS_REQUIRE_LIBRARY_KEY',
      error: 'Groups are defined in the answer key; select a key from the library',
    };
  }

  if (key.variants.length === 0) {
    return {
      ok: false,
      code: 'ANSWER_KEY_HAS_NO_GROUPS',
      error: 'The selected answer key has no groups',
    };
  }

  const variantsByName = new Map(key.variants.map((variant) => [variant.name.toLocaleLowerCase(), variant]));
  const assignedTo = new Map<string, string>();
  const studentIdsByVariant = new Map<string, string[]>();

  for (let index = 0; index < value.length; index++) {
    const raw = value[index] as Record<string, unknown> | null;

    if (!raw || typeof raw !== 'object') {
      return { ok: false, code: 'GROUPS_INVALID', error: `groups[${index}] must be an object` };
    }

    const name = typeof raw.name === 'string' ? raw.name.trim() : '';

    if (!name || name.length > GROUP_NAME_MAX_LENGTH) {
      return {
        ok: false,
        code: 'GROUP_NAME_INVALID',
        error: `group name must be a non-empty string of at most ${GROUP_NAME_MAX_LENGTH} characters`,
      };
    }

    const variant = variantsByName.get(name.toLocaleLowerCase());

    if (!variant) {
      return {
        ok: false,
        code: 'GROUP_VARIANT_NOT_FOUND',
        error: `group ${name} does not match any variant of the selected answer key`,
      };
    }

    const variantKey = variant.name.toLocaleLowerCase();

    if (studentIdsByVariant.has(variantKey)) {
      return { ok: false, code: 'GROUP_NAME_DUPLICATED', error: `group ${name} is listed twice` };
    }

    if (Array.isArray(raw.student_ids) && raw.student_ids.length > GROUP_STUDENTS_MAX_COUNT) {
      return {
        ok: false,
        code: 'GROUP_STUDENTS_TOO_MANY',
        error: `groups[${index}].student_ids must contain at most ${GROUP_STUDENTS_MAX_COUNT} entries`,
      };
    }

    const studentIds = idsFromJsonArray(raw.student_ids);

    for (const id of studentIds) {
      if (assignedTo.has(id)) {
        return {
          ok: false,
          code: 'GROUP_STUDENT_DUPLICATED',
          error: 'A student can be assigned to only one group',
        };
      }

      assignedTo.set(id, name);
    }

    studentIdsByVariant.set(variantKey, studentIds);
  }

  // Jedno zapytanie na sumę uczniów wszystkich grup: listy są rozłączne, więc liczba z bazy
  // musi się zgadzać co do identyfikatora.
  const allIds = Array.from(assignedTo.keys());
  const found = await prisma.student.count({ where: { id: { in: allIds }, class_id: classId } });

  if (found !== allIds.length) {
    return {
      ok: false,
      code: 'GROUP_STUDENT_NOT_IN_CLASS',
      error: 'Group student does not belong to this class',
    };
  }

  // Wiersz powstaje dla każdego wariantu klucza, także dla tego, do którego nikt nie trafił. Pusta
  // lista nie jest tu błędem do wycięcia: bez wiersza wariant znika z sesji na zawsze, a ekran
  // przydziału szuka grup wyłącznie wśród jej wierszy — ucznia piszącego ten arkusz w innym terminie
  // nie byłoby czym sprawdzić.
  const groups: SessionGroupWrite[] = key.variants.map((variant, index) => ({
    name: variant.name,
    position: index,
    answer_key: {
      tasks: toTaskArray(variant.tasks),
      total_points: variant.total_points,
    } as Prisma.InputJsonValue,
    answer_key_id: key.id,
    keyName: key.name,
    student_ids: studentIdsByVariant.get(variant.name.toLocaleLowerCase()) ?? [],
  }));

  return { ok: true, groups };
}

/** Wiersz grupy wczytany z sesji: nazwa, identyfikator i dotychczasowy przydział. */
type SessionGroupRow = { id: string; name: string; student_ids: unknown };

type SessionGroupsPatchResult =
  | { ok: true; updates: { id: string; student_ids: string[] }[] }
  | { ok: false; code: string; error: string };

/**
 * Przydział uczniów w sesji, która już leży w bazie. Warianty definiują tu wiersze
 * `grading_session_groups`, więc nie zaglądamy do biblioteki: klucz odpowiedzi mógł się zmienić po
 * utworzeniu sesji, a przy każdej nazwie wisi zamrożony snapshot punktów.
 * Żądanie zmienia wyłącznie `student_ids` istniejących wierszy. Zasady:
 * - zbiór nazw w żądaniu to dokładnie zbiór nazw sesji — nowa nazwa nie ma własnego klucza, z
 *   którego można by sprawdzać, a pominięta grupa zostaje w bazie bez przydziału;
 * - listy uczniów pozostają rozłączne, a każdy identyfikator musi być uczniem tej klasy;
 * - pracy z policzonymi punktami (`final_points`) nie przenosimy: jej wynik liczono z klucza dawnej
 *   grupy, a w sesji z przydziałem nie ma ścieżki przeliczenia, która nie kosztowałaby nauczyciela
 *   strony po cichu;
 * - ucznia z dodaną pracą nie wolno wyrzucić ze wszystkich grup — bez przydziału jego praca i tak
 *   idzie do sprawdzenia z kluczem pierwszej grupy.
 * Grupa bez uczniów jest dozwolona w obu trybach: wiersza i tak nie kasujemy, a pusta lista znaczy
 * tyle, że nikt nie pisze tego wariantu w tym terminie.
 */
async function parseSessionGroupsPatch(
  value: unknown,
  rows: readonly SessionGroupRow[],
  classId: string,
  gradedIds: ReadonlySet<string>,
  workedIds: ReadonlySet<string>
): Promise<SessionGroupsPatchResult> {
  if (!Array.isArray(value)) {
    return { ok: false, code: 'GROUPS_INVALID', error: 'groups must be an array' };
  }

  if (value.length === 0) {
    return { ok: false, code: 'GROUPS_INVALID', error: 'groups must contain at least one group' };
  }

  if (value.length > SESSION_GROUPS_MAX_COUNT) {
    return {
      ok: false,
      code: 'GROUPS_LIMIT_EXCEEDED',
      error: `groups must contain at most ${SESSION_GROUPS_MAX_COUNT} entries`,
    };
  }

  const rowByLowerName = new Map(rows.map((row) => [row.name.toLocaleLowerCase(), row]));
  const currentRowOf = new Map<string, string>();

  for (const row of rows) {
    for (const id of idsFromJsonArray(row.student_ids)) currentRowOf.set(id, row.id);
  }

  const assignedTo = new Map<string, string>();
  const updates: { id: string; student_ids: string[] }[] = [];

  for (let index = 0; index < value.length; index++) {
    const raw = value[index] as Record<string, unknown> | null;

    if (!raw || typeof raw !== 'object') {
      return { ok: false, code: 'GROUPS_INVALID', error: `groups[${index}] must be an object` };
    }

    const name = typeof raw.name === 'string' ? raw.name.trim() : '';

    if (!name || name.length > GROUP_NAME_MAX_LENGTH) {
      return {
        ok: false,
        code: 'GROUP_NAME_INVALID',
        error: `group name must be a non-empty string of at most ${GROUP_NAME_MAX_LENGTH} characters`,
      };
    }

    const row = rowByLowerName.get(name.toLocaleLowerCase());

    if (!row) {
      return {
        ok: false,
        code: 'SESSION_GROUPS_MISMATCH',
        error: `group ${name} is not a group of this session`,
      };
    }

    if (updates.some((update) => update.id === row.id)) {
      return { ok: false, code: 'GROUP_NAME_DUPLICATED', error: `group ${name} is listed twice` };
    }

    if (Array.isArray(raw.student_ids) && raw.student_ids.length > GROUP_STUDENTS_MAX_COUNT) {
      return {
        ok: false,
        code: 'GROUP_STUDENTS_TOO_MANY',
        error: `groups[${index}].student_ids must contain at most ${GROUP_STUDENTS_MAX_COUNT} entries`,
      };
    }

    const studentIds = idsFromJsonArray(raw.student_ids);

    for (const id of studentIds) {
      if (assignedTo.has(id)) {
        return {
          ok: false,
          code: 'GROUP_STUDENT_DUPLICATED',
          error: 'A student can be assigned to only one group',
        };
      }

      assignedTo.set(id, row.id);
    }

    updates.push({ id: row.id, student_ids: studentIds });
  }

  const missingNames = rows
    .filter((row) => !updates.some((update) => update.id === row.id))
    .map((row) => row.name);

  if (missingNames.length > 0) {
    return {
      ok: false,
      code: 'SESSION_GROUPS_MISMATCH',
      error: `groups must list every group of this session: ${missingNames.join(', ')}`,
    };
  }

  // Jedno zapytanie o sumę uczniów wszystkich grup: listy są rozłączne, więc liczba z bazy musi
  // się zgadzać co do identyfikatora.
  const allIds = Array.from(assignedTo.keys());
  const found = await prisma.student.count({ where: { id: { in: allIds }, class_id: classId } });

  if (found !== allIds.length) {
    return {
      ok: false,
      code: 'GROUP_STUDENT_NOT_IN_CLASS',
      error: 'Group student does not belong to this class',
    };
  }

  const nameOf = new Map(rows.map((row) => [row.id, row.name]));

  for (const [id, rowId] of currentRowOf) {
    const after = assignedTo.get(id) ?? null;

    if (after === rowId) continue;

    if (gradedIds.has(id)) {
      return {
        ok: false,
        code: 'GROUP_STUDENT_HAS_WORK',
        error: `group ${nameOf.get(rowId)}: a student whose points were already computed cannot change group`,
      };
    }

    if (after === null && workedIds.has(id)) {
      return {
        ok: false,
        code: 'GROUP_STUDENT_HAS_SCAN',
        error: `group ${nameOf.get(rowId)}: a student with an uploaded work has to stay in a group`,
      };
    }
  }

  for (const [id, rowId] of assignedTo) {
    // Uczeń dotąd poza przydziałem, czyli sprawdzany z kluczem sesji — przeniesienie go do grupy
    // przepisałoby, z jakiego klucza liczony jest jego wynik, więc zostaje zablokowane.
    if (gradedIds.has(id) && !currentRowOf.has(id)) {
      return {
        ok: false,
        code: 'GROUP_STUDENT_HAS_WORK',
        error: `group ${nameOf.get(rowId)}: a student whose points were already computed cannot change group`,
      };
    }
  }

  return { ok: true, updates };
}

/**
 * Klucz właściwy dla pracy ucznia: sesja grupowa ma tyle kluczy, ile grup, zwykła jeden — na sobie.
 * Fallback na klucz sesji zostaje dla pracy ucznia spoza przydziału (np. dosłanej po zmianie list),
 * żeby /process nigdy nie został bez klucza do porównania.
 */
function buildAnswerKeyResolver(session: {
  answer_key: unknown;
  session_groups?: readonly { answer_key: unknown; student_ids: unknown }[] | null;
}): (studentId: string) => any {
  const byStudent = new Map<string, any>();

  for (const group of session.session_groups ?? []) {
    for (const studentId of idsFromJsonArray(group.student_ids)) {
      byStudent.set(studentId, group.answer_key);
    }
  }

  return (studentId: string) => byStudent.get(studentId) ?? session.answer_key;
}

/** Wariant zamrożony na sesji: nazwa zapisywana w `grades.variant_name` i klucz, z którego liczymy punkty. */
type FrozenVariant = { name: string; answerKey: any };

/**
 * Warianty do rozpoznawania — wyłącznie dla sesji w trybie 'ai'. Dla każdej innej sesji zwracam null,
 * więc /process idzie swoją starą ścieżką i nauczyciel z przydziałem ręcznym nie płaci za klasyfikację
 * pracy, której wariant zna ze swojej listy grup.
 */
function frozenVariantsFor(session: {
  group_assignment_mode?: string | null;
  answer_key_variants?: unknown;
}): FrozenVariant[] | null {
  if (session.group_assignment_mode !== 'ai' || !Array.isArray(session.answer_key_variants)) {
    return null;
  }

  const variants = session.answer_key_variants.flatMap((raw): FrozenVariant[] => {
    if (!raw || typeof raw !== 'object') return [];
    const { name, answer_key } = raw as { name?: unknown; answer_key?: unknown };
    if (typeof name !== 'string' || name.trim() === '' || !answer_key || typeof answer_key !== 'object') {
      return [];
    }
    return [{ name, answerKey: answer_key }];
  });

  return variants.length > 0 ? variants : null;
}

/**
 * Klucz wariantu przypisanego tej pracy. Null, gdy sesja w ogóle nie rozpoznaje wariantów albo gdy
 * wiersz oceny nie ma jeszcze rozstrzygnięcia — wtedy czytelnik wraca na klucz grupy lub klucz sesji.
 * Bez tego sprawdzenia sufit ręcznej poprawki liczony byłby z wariantu 0, a praca sprawdzona z wariantu B
 * ma dla każdego zadania inne maksimum.
 */
function variantKeyForGrade(
  session: { group_assignment_mode?: string | null; answer_key_variants?: unknown },
  variantName: unknown
): any | null {
  const variants = frozenVariantsFor(session);
  if (!variants) return null;
  return variantResolver(variants)(variantName)?.answerKey ?? null;
}

/** Unia uczniów wszystkich grup — mianownik „kto powinien mieć pracę" w sesji grupowej. */
function groupPopulationIds(groups: readonly { student_ids: unknown }[]): string[] {
  const ids = new Set<string>();

  for (const group of groups) {
    for (const id of idsFromJsonArray(group.student_ids)) ids.add(id);
  }

  return Array.from(ids);
}

/**
 * Ilu uczniów z danego zbioru nie ma pracy ani oznaczonej nieobecności. Jedna funkcja, bo
 * /process i historia liczyły to osobno i każda zmiana musiałaby przejść przez oba miejsca.
 */
function countMissingStudents(
  populationIds: string[],
  absentIds: ReadonlySet<string>,
  workedIds: ReadonlySet<string>
): number {
  return populationIds.filter((id) => !absentIds.has(id) && !workedIds.has(id)).length;
}

/**
 * POST /api/grading/sessions
 * Tworzy nową sesję sprawdzania
 */
export async function createGradingSession(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const { class_id, answer_key, answer_key_id, grade_threshold_id, absent_student_ids, groups } = req.body;

    // Walidacja
    if (!class_id) {
      res.status(400).json({ error: 'Class ID is required', code: 'CLASS_ID_REQUIRED' });
      return;
    }

    // Sprawdź czy klasa należy do użytkownika
    const classData = await prisma.class.findFirst({
      where: {
        id: class_id,
        user_id: req.user.userId,
      },
    });

    if (!classData) {
      res.status(404).json({ error: 'Class not found', code: 'CLASS_NOT_FOUND' });
      return;
    }

    // Klucz z biblioteki czytamy raz, przed grupami: to jego warianty są definicją podziału,
    // a on sam jest snapshotem sesji, gdy nauczyciel nie robi grup wcale.
    const keyResult = await loadLibraryKey(answer_key_id, req.user.userId);

    if (!keyResult.ok) {
      res.status(400).json({ error: keyResult.error, code: keyResult.code });
      return;
    }

    const libraryKey = keyResult.key;

    // Tryb przydziału czytamy z konta, nie z żądania. Nauczyciel decyduje raz w ustawieniach, a
    // przeładowany albo starszy klient nie może mu przywrócić ekranu przydziału, który ten wyłączył.
    const accountSettings = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { group_assignment_mode: true },
    });

    // Rozpoznawanie istnieje tylko po to, by rozróżnić warianty: przy jednym byłoby płaceniem za
    // odpowiedź znaną z góry. Dlatego 'ai' na koncie z jedno-wariantowym kluczem daje sesję dokładnie
    // taką, jak przed tą zmianą — preferencja konta nie może zablokować zwykłego sprawdzania.
    const keyVariants = libraryKey && libraryKey.variants.length >= 2 ? freezeVariants(libraryKey.variants) : null;
    const variantsToFreeze = accountSettings?.group_assignment_mode === 'ai' ? keyVariants : null;

    if (variantsToFreeze && groups !== undefined && groups !== null) {
      // Nie ignorujemy przydziału po cichu: nauczyciel, który zobaczył ekran przypinania, musi dostać
      // odmowę, zamiast liczyć na grupy, których nigdy nie zapisaliśmy.
      res.status(400).json({
        error: 'This account lets the AI recognise the variant; the session has no group assignment',
        code: 'GROUPS_NOT_ALLOWED_WITH_VARIANT_DETECTION',
      });
      return;
    }

    const groupsResult: SessionGroupsResult = variantsToFreeze
      ? { ok: true, groups: [] }
      : await parseSessionGroups(groups, class_id, libraryKey);

    if (!groupsResult.ok) {
      res.status(400).json({ error: groupsResult.error, code: groupsResult.code });
      return;
    }

    const sessionGroups = groupsResult.groups;

    // Bez grup klucz musi przyjść w żądaniu — dokładnie tak samo jak przed grupami.
    // Z grupami klucz ma każda grupa, a sesja dziedziczy klucz pierwszej z nich.
    if (sessionGroups.length === 0 && !answer_key && !answer_key_id) {
      res.status(400).json({ error: 'Answer key is required', code: 'ANSWER_KEY_REQUIRED' });
      return;
    }

    // Nieobecności zapisujemy razem z sesją — jedno create zamiast create + PATCH, więc nauczyciel
    // nie może zostać z połową listy, gdy zamknie mu się przeglądarka.
    const absentResult = parseAbsentIdsPayload(absent_student_ids ?? []);

    if (!absentResult.ok) {
      res.status(400).json({ error: absentResult.error, code: absentResult.code });
      return;
    }

    if (!(await absentIdsBelongToClass(absentResult.ids, class_id))) {
      res.status(400).json({
        error: 'Absent student does not belong to this class',
        code: 'ABSENT_STUDENT_NOT_IN_CLASS',
      });
      return;
    }

    // Jeśli podano grade_threshold_id, sprawdź czy należy do użytkownika
    if (grade_threshold_id) {
      const thresholdData = await prisma.gradeThreshold.findFirst({
        where: {
          id: grade_threshold_id,
          user_id: req.user.userId,
        },
      });

      if (!thresholdData) {
        res.status(400).json({
          error: 'Grade threshold does not belong to this user',
          code: 'THRESHOLD_NOT_OWNED',
        });
        return;
      }
    }

    // Klucz z biblioteki: zapisujemy JEGO TREŚĆ jako snapshot sesji, a nie tylko referencję.
    // Dzięki temu edycja klucza później nie przerabia już sprawdzonych prac, a `/process`
    // czyta klucz dokładnie tak samo jak przy ręcznie wpisanym.
    //
    // Sesja grupowa ma tyle kluczy, ile grup. Kolumna `answer_key` sesji nie może być nullowa
    // (czytają ją m.in. mianownik procentów i nazwa w historii), więc mieści klucz pierwszej
    // grupy. Każda praca i tak jest sprawdzana po kluczu własnej grupy (`session_groups`).
    let resolvedAnswerKey: unknown;
    let keyName: string | null;
    let sessionAnswerKeyId: string | null;

    if (sessionGroups.length > 0) {
      resolvedAnswerKey = sessionGroups[0].answer_key;
      keyName = sessionGroups[0].keyName;
      sessionAnswerKeyId = sessionGroups[0].answer_key_id;
    } else {
      if (!libraryKey) {
        const result = snapshotFromRequest({ answer_key });
        if (!result.ok) {
          res.status(400).json({ error: result.error, code: result.code });
          return;
        }
        resolvedAnswerKey = result.snapshot.key;
        keyName = result.snapshot.keyName;
        sessionAnswerKeyId = null;
      } else {
        const snapshot = snapshotFromLibraryKey(libraryKey);
        resolvedAnswerKey = snapshot.key;
        keyName = snapshot.keyName;
        sessionAnswerKeyId = libraryKey.id;
      }
    }

    const sessionName = await resolveUniqueSessionName(
      req.user.userId,
      keyName ?? (typeof answer_key?.name === 'string' ? answer_key.name : null)
    );

    // Utwórz sesję
    const session = await prisma.gradingSession.create({
      data: {
        user_id: req.user.userId,
        class_id,
        name: sessionName,
        answer_key: resolvedAnswerKey as Prisma.InputJsonValue,
        answer_key_id: sessionAnswerKeyId,
        grade_threshold_id: grade_threshold_id || null,
        absent_student_ids: absentResult.ids,
        // Snapshot ustawienia konta z chwili tworzenia: później nauczyciel może przełączyć tryb
        // dowolnie, a ta sesja musi na zawsze zostać taka, jaka była.
        group_assignment_mode: variantsToFreeze ? 'ai' : 'manual',
        ...(variantsToFreeze && { answer_key_variants: variantsToFreeze as Prisma.InputJsonValue }),
        status: 'in_progress',
        // Zagnieżdżone `create` to jedna transakcja Prisma: sesja nigdy nie zostanie zapisana
        // bez swoich grup, a grupy nie trafią do bazy bez sesji.
        ...(sessionGroups.length > 0 && {
          session_groups: {
            create: sessionGroups.map((group) => ({
              position: group.position,
              name: group.name,
              answer_key: group.answer_key,
              answer_key_id: group.answer_key_id,
              student_ids: group.student_ids,
            })),
          },
        }),
      },
      include: {
        session_groups: { orderBy: { position: 'asc' } },
      },
    });

    res.status(201).json({ session });
  } catch (error) {
    console.error('Błąd tworzenia sesji sprawdzania:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * PATCH /api/grading/sessions/:sessionId
 * Dwa pola, które nauczyciel może zmienić po utworzeniu sesji: lista nieobecnych i przydział
 * uczniów do grup. Klucz odpowiedzi i próg ocen zostają zamrożonym snapshotem — ich edycja
 * przepisałaby już sprawdzone prace, a tego historia sesji nie może robić.
 * Przydział grup jest możliwy dopóki praca nie ma policzonych punktów; przeniesienie ocenionego
 * ucznia zmieniłoby klucz, z którego liczono jego wynik (parseSessionGroupsPatch).
 */
export async function updateGradingSession(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const { sessionId } = req.params;

    const session = await prisma.gradingSession.findFirst({
      where: {
        id: sessionId,
        user_id: req.user.userId,
      },
      include: {
        session_groups: { orderBy: { position: 'asc' } },
      },
    });

    if (!session) {
      res.status(404).json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }

    if (session.status === 'processing') {
      res.status(409).json({ error: 'Session is being processed', code: 'SESSION_PROCESSING' });
      return;
    }

    const wantsAbsent = req.body?.absent_student_ids !== undefined;
    const wantsGroups = req.body?.groups !== undefined && req.body?.groups !== null;

    if (!wantsAbsent && !wantsGroups) {
      res.status(400).json({
        error: 'absent_student_ids or groups is required',
        code: 'SESSION_PATCH_EMPTY',
      });
      return;
    }

    const absentResult = wantsAbsent ? parseAbsentIdsPayload(req.body.absent_student_ids) : null;

    if (absentResult && !absentResult.ok) {
      res.status(400).json({ error: absentResult.error, code: absentResult.code });
      return;
    }

    if (absentResult && !(await absentIdsBelongToClass(absentResult.ids, session.class_id))) {
      res.status(400).json({
        error: 'Absent student does not belong to this class',
        code: 'ABSENT_STUDENT_NOT_IN_CLASS',
      });
      return;
    }

    let groupUpdates: { id: string; student_ids: string[] }[] = [];
    let workedIds = new Set<string>();

    if (wantsGroups) {
      if (session.group_assignment_mode === 'ai') {
        res.status(400).json({
          error: 'This session recognizes variants from the scan; group assignment is not used',
          code: 'GROUPS_NOT_ALLOWED_WITH_VARIANT_DETECTION',
        });
        return;
      }

      if (session.session_groups.length === 0) {
        res.status(400).json({ error: 'This session has no groups', code: 'SESSION_HAS_NO_GROUPS' });
        return;
      }

      // Jeden odczyt prac: `final_points` mówi, których wyników już nie ruszamy, a sama obecność
      // wiersza — kogo nie wolno wyrzucić poza wszystkie grupy.
      const works = await prisma.grade.findMany({
        where: { grading_session_id: session.id },
        select: { student_id: true, final_points: true },
      });

      workedIds = new Set(works.map((work) => work.student_id));

      const patch = await parseSessionGroupsPatch(
        req.body.groups,
        session.session_groups,
        session.class_id,
        new Set(works.filter((work) => work.final_points !== null).map((work) => work.student_id)),
        workedIds
      );

      if (!patch.ok) {
        res.status(400).json({ error: patch.error, code: patch.code });
        return;
      }

      groupUpdates = patch.updates;
    }

    // Sesja „zakończona" przestaje być zakończona, gdy przydział urośnie o kogoś bez pracy —
    // inaczej historia dalej obiecywałaby komplet wyników. Liczymy to samo co `/process`.
    let nextStatus: string | null = null;

    if (wantsGroups && session.status === 'completed') {
      const rows = session.session_groups.map((row) => ({
        student_ids: groupUpdates.find((group) => group.id === row.id)?.student_ids ?? row.student_ids,
      }));

      const missing = countMissingStudents(
        groupPopulationIds(rows),
        new Set<string>(absentResult ? absentResult.ids : idsFromJsonArray(session.absent_student_ids)),
        workedIds
      );

      if (missing > 0) nextStatus = 'awaiting_works';
    }

    const updated = await prisma.gradingSession.update({
      where: { id: session.id },
      data: {
        ...(absentResult && { absent_student_ids: absentResult.ids }),
        ...(groupUpdates.length > 0 && {
          // Zagnieżdżone `update` to jedna transakcja: przydział nigdy nie zostaje w połowie
          // przeniesiony, co byłoby dwiema grupami z tym samym uczniem.
          session_groups: {
            update: groupUpdates.map((group) => ({
              where: { id: group.id },
              data: { student_ids: group.student_ids },
            })),
          },
        }),
        ...(nextStatus && { status: nextStatus }),
      },
      include: {
        session_groups: { orderBy: { position: 'asc' } },
      },
    });

    res.json({ session: updated });
  } catch (error) {
    console.error('Błąd aktualizacji sesji sprawdzania:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * Skany znikają razem z wierszami ocen. `absoluteUploadPath` odrzuca każdą ścieżkę poza
 * katalogiem uploads, więc nadany `image_path` nie potrafi wskazać pliku spoza niego.
 * ENOENT jest tu sukcesem — plik mógł już nie istnieć po nadpisaniu pracy.
 */
async function deleteSessionScans(imagePaths: string[]): Promise<void> {
  for (const stored of imagePaths) {
    try {
      await fs.promises.unlink(absoluteUploadPath(stored));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        // Bez ścieżki w logu: nazwa pliku niesie uuid ucznia
        console.warn('Skan został na dysku po usunięciu sesji:', code ?? 'nieznany błąd');
      }
    }
  }
}

/**
 * Nadpisana praca zostawiała poprzedni skan na dysku na zawsze: każde ponowne wgranie tworzy plik
 * z nowym `Date.now()`, a gałąź aktualizacji `Grade` przepisywała `image_path` bez kasacji
 * poprzednika, więc `deleteSessionScans` (patrz wyżej) nigdy o nim nie słyszał.
 *
 * Kasujemy wyłącznie plik, co do którego mamy trzy dowody, i dlatego są to trzy osobne warunki:
 *  1. ścieżka przyszła z tego właśnie wiersza `Grade`, który aktualizujemy — nie z żądania,
 *  2. `absoluteUploadPath` ją przyjmie, a jej katalogiem jest dokładnie `ANONYMIZED_DIR`,
 *     więc nie ma mowy o `..` ani o pliku pozaanonimizowanym,
 *  3. żaden inny wiersz `Grade` już jej nie wskazuje — sprawdzane PO aktualizacji, bo wtedy
 *     nadpisany wiersz ma w bazie nowy path i ewentualne trafienie to realna druga praca.
 *
 * Każdy wątek niepewności zostawia plik. W drzewie bez kontroli wersji nie ma sposobu odkręcić
 * skasowanego materiału ucznia, a nadmiarowy plik jest tylko droższy o kilka kilobajtów.
 */
async function deleteReplacedScan(storedPath: string): Promise<void> {
  let absolute: string;

  try {
    absolute = path.resolve(absoluteUploadPath(storedPath));
  } catch {
    console.warn('Zastąpiony skan został na dysku: ścieżka poza katalogiem uploads');
    return;
  }

  if (path.dirname(absolute) !== path.resolve(ANONYMIZED_DIR)) {
    console.warn('Zastąpiony skan został na dysku: ścieżka poza katalogiem anonimizacji');
    return;
  }

  try {
    const stillReferenced = await prisma.grade.findFirst({
      where: { image_path: storedPath },
      select: { id: true },
    });

    if (stillReferenced) return;

    await fs.promises.unlink(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.warn('Zastąpiony skan został na dysku:', code ?? 'nieznany błąd');
    }
  }
}

/**
 * DELETE /api/grading/sessions/:sessionId
 * Bezpowrotne usunięcie sesji: oceny idą w cascade, skany z dysku razem z nimi.
 */
export async function deleteGradingSession(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const { sessionId } = req.params;

    const session = await prisma.gradingSession.findFirst({
      where: {
        id: sessionId,
        user_id: req.user.userId,
      },
      select: { id: true, status: true },
    });

    if (!session) {
      res.status(404).json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }

    // Kolejka AI pisze wiersze tej sesji — skasowanie jej w trakcie zostawiłoby zapisy
    // bez rodzica i spalone strony w limicie nauczyciela.
    if (session.status === 'processing') {
      res.status(409).json({ error: 'Session is being processed', code: 'SESSION_PROCESSING' });
      return;
    }

    // Po cascade nie będzie skąd wziąć ścieżek, więc czytamy je przed kasacją
    const works = await prisma.grade.findMany({
      where: { grading_session_id: session.id },
      select: { image_path: true },
    });

    await prisma.gradingSession.delete({ where: { id: session.id } });

    await deleteSessionScans(works.map((work) => work.image_path));

    res.json({ message: 'Session deleted successfully' });
  } catch (error) {
    console.error('Błąd usuwania sesji sprawdzania:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * POST /api/grading/upload
 * KLUCZOWY ENDPOINT: Upload i anonimizacja obrazu pracy ucznia
 *
 * Flow:
 * 1. Odbiera plik w pamięci RAM (multer memoryStorage)
 * 2. Odbiera współrzędne prostokąta anonimizującego
 * 3. Używa Sharp do trwałego zamalowania obszaru z danymi osobowymi
 * 4. Zapisuje zanonimizowany plik na dysku
 * 5. Oryginalny buffer jest natychmiast czyszczony z pamięci
 */
export async function uploadAndAnonymizeImage(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    // Sprawdź czy plik został przesłany
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded', code: 'FILE_MISSING' });
      return;
    }

    const { student_id, session_id, x, y, width, height } = req.body;

    // Walidacja
    if (!student_id || !session_id || x === undefined || y === undefined || !width || !height) {
      res.status(400).json({ error: 'Missing required fields: student_id, session_id, x, y, width, height', code: 'RECT_FIELDS_MISSING' });
      return;
    }

    // Parsuj współrzędne na liczby
    const rectX = parseInt(x, 10);
    const rectY = parseInt(y, 10);
    const rectWidth = parseInt(width, 10);
    const rectHeight = parseInt(height, 10);

    if (isNaN(rectX) || isNaN(rectY) || isNaN(rectWidth) || isNaN(rectHeight)) {
      res.status(400).json({ error: 'Invalid coordinates', code: 'RECT_INVALID' });
      return;
    }

    // Sprawdź czy sesja należy do użytkownika
    const session = await prisma.gradingSession.findFirst({
      where: {
        id: session_id,
        user_id: req.user.userId,
      },
    });

    if (!session) {
      res.status(404).json({ error: 'Grading session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }

    // Sprawdź czy uczeń należy do klasy z sesji
    const student = await prisma.student.findFirst({
      where: {
        id: student_id,
        class: {
          id: session.class_id,
          user_id: req.user.userId,
        },
      },
    });

    if (!student) {
      res.status(404).json({ error: 'Student not found', code: 'STUDENT_NOT_FOUND' });
      return;
    }

    console.log('🔍 Anonimizuję zdjęcie...');
    console.log(`📐 Prostokąt: x=${rectX}, y=${rectY}, width=${rectWidth}, height=${rectHeight}`);

    // Współrzędne z przeglądarki opisują kadr PO obrocie z EXIF, więc ramkę liczymy tak samo
    const source = await sharp(req.file.buffer).metadata().catch(() => null);
    if (!source?.width || !source?.height) {
      res.status(400).json({ error: 'Image could not be decoded', code: 'UNREADABLE_IMAGE' });
      return;
    }

    const rotated = (source.orientation ?? 1) >= 5;
    const frameWidth = rotated ? source.height : source.width;
    const frameHeight = rotated ? source.width : source.height;

    // Przycinamy tylko nadmiar za prawą/dolną krawędzią — początek zostaje tam, gdzie go narysowano,
    // inaczej prostokąt leżący cały poza kadrem zamieniałby się w pasek na krawędzi.
    const redactionX = Math.max(0, rectX);
    const redactionY = Math.max(0, rectY);
    const redactionWidth = Math.min(rectX + rectWidth, frameWidth) - redactionX;
    const redactionHeight = Math.min(rectY + rectHeight, frameHeight) - redactionY;

    if (redactionWidth < MIN_REDACTION_PX || redactionHeight < MIN_REDACTION_PX) {
      res.status(400).json({ error: 'Anonymization rectangle does not cover the image', code: 'RECT_OUTSIDE_IMAGE' });
      return;
    }

    if (redactionWidth * redactionHeight >= frameWidth * frameHeight * 0.9) {
      res.status(400).json({ error: 'Anonymization rectangle covers almost the entire page', code: 'RECT_COVERS_PAGE' });
      return;
    }

    console.log(`🖼 Ramka po rotacji EXIF: ${frameWidth}x${frameHeight}, zamalowane: x=${redactionX}, y=${redactionY}, ${redactionWidth}x${redactionHeight}`);

    // KLUCZOWY MOMENT: Anonimizacja obrazu przez Sharp
    // 1. Stwórz białą nakładkę (prostokąt zamazujący dane osobowe)
    const overlay = await sharp({
      create: {
        width: redactionWidth,
        height: redactionHeight,
        channels: 3,
        background: { r: 255, g: 255, b: 255 }, // Biały prostokąt
      },
    })
      .png()
      .toBuffer();

    // 2. Nałóż białą nakładkę na oryginalny buffer (TRWAŁE ZAMALOWANIE)
    // .rotate() normalizuje orientację z EXIF — bez niej piksele zostają w orientacji czujnika,
    // a współrzędne z podglądu (przeglądarka obraca) trafiają w inne miejsce albo poza kadr.
    // Schodzimy do PNG, nie do JPEG: wzmocnienie ma widzieć piksele PO masce, a bezstratny
    // pośrednik oznacza, że stratna kompresja nadal dzieje dokładnie jeden raz (poniżej, q90).
    const maskedBuffer = await sharp(req.file.buffer)
      .rotate()
      .composite([
        {
          input: overlay,
          left: redactionX,
          top: redactionY,
        },
      ])
      .png()
      .toBuffer();

    // 2b. Wzmocnienie widoczności pisma — wyłącznie na buforze po zamazaniu. Funkcja nie zmienia
    // wymiarów, a najgorszy jej wynik to dzisiejszy zapis bez filtra. Prostopadł maski jedziemy
    // dalej po to, żeby wzmocnienie domalowało go czystą bielą PO `sharpen`: inaczej pierścień
    // wyostrzenia nadtłuży brzeg prostokąta i ślad po zamazaniu będzie widoczny.
    const anonymizedBuffer = await enhanceAnonymizedScan(
      maskedBuffer,
      { width: frameWidth, height: frameHeight },
      undefined,
      { x: redactionX, y: redactionY, width: redactionWidth, height: redactionHeight }
    );

    // 3. Zapisz zanonimizowany plik na dysku — zapis i `express.static` muszą używać tego samego korzenia
    const uploadsDir = ANONYMIZED_DIR;
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const filename = `anonymized_${session_id}_${student_id}_${Date.now()}.jpg`;
    const filepath = path.join(uploadsDir, filename);

    // Zapis surowych bajtów, bez drugiego obiegu `sharp(...).toFile()`: tamten przepisywał JPEG
    // już zakodowany powyżej i dokładał drugą stratną kompresję na domyślnej jakości.
    await fs.promises.writeFile(filepath, anonymizedBuffer);

    // 4. WYCZYŚĆ ORYGINALNY BUFFER Z PAMIĘCI (bezpieczeństwo)
    // TypeScript/Node.js automatycznie zwolni pamięć, ale możemy wymusić
    req.file.buffer = Buffer.alloc(0);

    // 5. Zapisz informację o pliku w bazie (bez przetwarzania przez AI na razie)
    // Grade zostanie utworzony dopiero po przetworzeniu przez AI
    const relativePath = `uploads/anonymized/${filename}`;

    // Sprawdź czy grade już istnieje dla tego ucznia w tej sesji
    let grade = await prisma.grade.findFirst({
      where: {
        grading_session_id: session_id,
        student_id: student_id,
      },
    });

    if (grade) {
      // Aktualizuj istniejący grade (użytkownik przesłał nowe zdjęcie)
      // Ścieżkę czytamy PRZED zapisem: po `update` wiersz niesie już nowy plik i nie mielibyśmy
      // czym sprawdzić, czy poprzednik nadal do czegoś wskazuje.
      const replacedPath = grade.image_path;

      grade = await prisma.grade.update({
        where: { id: grade.id },
        data: {
          image_path: relativePath,
          // Resetuj AI response bo nowy obraz
          ai_response: {},
          confidence_score: 0,
        },
      });

      await deleteReplacedScan(replacedPath);
    } else {
      // Utwórz nowy grade
      grade = await prisma.grade.create({
        data: {
          grading_session_id: session_id,
          student_id: student_id,
          image_path: relativePath,
          ai_response: {}, // Puste na razie, zostanie wypełnione przez AI
          confidence_score: 0,
        },
      });
    }

    res.json({
      message: 'Image uploaded and anonymized successfully',
      grade_id: grade.id,
      image_path: relativePath,
    });
  } catch (error) {
    console.error('Błąd przyjęcia i anonimizacji skanu:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * POST /api/grading/sessions/:sessionId/process
 * Przetwarza wszystkie prace w sesji przez AI (Structured Outputs)
 *
 * UWAGA: Ten endpoint może trwać długo (kilka minut dla 30 uczniów)
 * W produkcji powinien być wykonywany jako background job (np. Bull Queue)
 */
export async function processSessionWithAI(req: Request, res: Response): Promise<void> {
  const sessionId = req.params.sessionId as string;
  let claimHeld = false;

  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    // Pobierz sesję z kluczem odpowiedzi
    const session = await prisma.gradingSession.findFirst({
      where: {
        id: sessionId,
        user_id: req.user.userId,
      },
      include: {
        grades: {
          include: {
            student: true,
          },
        },
        // Sesja grupowa ma klucz na każdą grupę; bez tej listy /process sprawdziłby wszystkie
        // prace wariantem pierwszej grupy.
        session_groups: {
          orderBy: { position: 'asc' },
        },
      },
    });

    if (!session) {
      res.status(404).json({ error: 'Grading session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }

    // Rozpoznawanie wariantu dotyczy wyłącznie sesji 'ai'; null = stara ścieżka: jeden klucz na sesję
    // albo klucz na grupę z przydziału nauczyciela.
    const variants = frozenVariantsFor(session);

    // Tryb 'ai' bez zamrożonych wariantów to dane uszkodzone — create zapisuje jedno i drugie razem.
    // Odmawiamy, zanim ześlemy choćby jedną kartkę: bez listy porównawczej każde sprawdzenie liczona
    // byłaby z wariantu 0, czyli z arkusza, którego uczeń mógł nie pisać.
    if (session.group_assignment_mode === 'ai' && !variants) {
      res.status(409).json({
        error: 'Session is set to variant detection but has no frozen variants',
        code: 'VARIANTS_NOT_FROZEN',
      });
      return;
    }

    // Pobierz dane użytkownika (limity stron)
    const user = await prisma.user.findUnique({
      where: { id: req.user.userId },
    });

    if (!user) {
      res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
      return;
    }

    const grades = session.grades;
    const gradesCount = grades.length;

    // Pomijamy prace, które już mają wynik — powtórne żądanie nie przepisuje ocen i nie nalicza stron
    const pendingGrades = grades.filter((grade: any) => grade.final_points === null);
    const pendingCount = pendingGrades.length;

    // Sprawdź limit stron PRZED rozpoczęciem przetwarzania
    if (user.pages_current_limit < pendingCount) {
      res.status(403).json({
        error: 'Page limit exceeded',
        code: 'PAGE_LIMIT_EXCEEDED',
        current_limit: user.pages_current_limit,
        required_pages: pendingCount,
        message: `You need ${pendingCount} pages but only have ${user.pages_current_limit} remaining.`,
      });
      return;
    }

    // Atomowe przejęcie sesji — blokada działa tylko gdy przetwarzanie trwa naprawdę (świeży claim)
    const claim = await prisma.gradingSession.updateMany({
      where: {
        id: sessionId,
        OR: [
          { status: { not: 'processing' } },
          {
            status: 'processing',
            updated_at: { lt: new Date(Date.now() - STALE_PROCESSING_CLAIM_MS) },
          },
        ],
      },
      data: { status: 'processing' },
    });

    if (claim.count === 0) {
      res.status(409).json({
        error: 'Sesja jest już przetwarzana',
        code: 'SESSION_ALREADY_PROCESSING',
      });
      return;
    }

    claimHeld = true;

    console.log(`🤖 Startuję sprawdzanie AI dla ${pendingCount} uczniów...`);

    // Klucz pracy = klucz grupy, do której należy jej uczeń; sesja bez grup ma jeden wspólny klucz.
    const keyForStudent = buildAnswerKeyResolver(session);
    const findVariant = variants ? variantResolver(variants) : null;
    const variantInputs: VariantInput[] | null = variants?.map(({ name, answerKey }) => ({ name, answerKey })) ?? null;

    const results = [];
    let processedCount = 0;
    let awaitingVariantCount = 0;

    /**
     * Wiersz o pracy, której wariantu nie rozstrzygnęliśmy, więc nie została sprawdzona i nie zeszła
     * jej ani jedna strona z salda (`final_points` dalej null). Bariera pewności stoi w serwisie AI
     * celowo wyżej niż próg eskalacji oceny — tam alternatywą jest droższy model, tu jedno kliknięcie.
     *
     * Dwa stany, bo dwa różne obowiązki następnego przebiegu:
     * - `unresolved` = klasyfikacja odbyła się i model nie rozstrzygnął. Zapisujemy znacznik, bo on
     *   jest jedyną oznaką, że za tę kartkę już zapłaciliśmy; bez niego ekran wyników odpalałby
     *   sprawdzanie przy każdym wejściu i pytał modelu raz za razem. Praca czeka na kliknięcie nauczyciela.
     * - `api_error` = samo wywołanie padło, czyli klasyfikacja NIE odbyła się. Znacznika nie stawiamy,
     *   żeby praca nie udawała odrzuconej; następny /process rozpozna ją od nowa, a nauczyciel zobaczy
     *   ją jako zwykłą pracę oczekującą na sprawdzenie.
     */
    const recordVariantSkipped = async (
      grade: { id: string; student_id: string },
      reason: string,
      detail: string
    ) => {
      const needsTeacher = reason !== 'api_error';
      if (needsTeacher) awaitingVariantCount++;

      await prisma.grade.update({
        where: { id: grade.id },
        data: {
          ...(needsTeacher ? { variant_source: 'unresolved' } : null),
          variant_note: detail.slice(0, VARIANT_NOTE_MAX_LENGTH),
        },
      });

      results.push({
        grade_id: grade.id,
        student_id: grade.student_id,
        ...(needsTeacher ? { variant_unresolved: true } : { variant_retry: true }),
        reason,
        detail,
        min_confidence: MIN_VARIANT_CONFIDENCE,
      });
      console.warn(
        needsTeacher
          ? `⏸️ Wariant pracy ${grade.id} nierozstrzygnięty, sprawdzanie pominięte`
          : `🔁 Klasyfikacja wariantu pracy ${grade.id} nieudana, wznowię przy następnym sprawdzaniu`
      );
    };

    // Przetwórz każdą pracę przez AI z hybrydowym routerem
    for (const grade of pendingGrades) {
      try {
        // Sprawdź limit przed każdym zapytaniem (dla pewności)
        const currentUser = await prisma.user.findUnique({
          where: { id: req.user.userId },
        });

        if (!currentUser || currentUser.pages_current_limit <= 0) {
          console.error('⚠️ Brak stron na koncie w trakcie sprawdzania');
          break;
        }

        const imagePath = absoluteUploadPath(grade.image_path);
        let answerKey = keyForStudent(grade.student_id);

        // Który wariant trafił do tej pracy i skąd to wiemy. Null = sesja z przydziałem (albo bez
        // wariantów) i pola variant_* zostają puste — nie zapisujemy czegoś, czego nikt nie użyje.
        let variant: { name: string; confidence: number | null; source: 'ai' | 'teacher' } | null = null;

        if (variants && findVariant && variantInputs) {
          const known = findVariant(grade.variant_name);

          if (known) {
            // Rozstrzygnięte wcześniej = nie pytamy modelu ponownie. Dotyczy też pracy, której ocena
            // padła na wywołaniu API: przy ponownym /process wariant jest już znany, więc za
            // klasyfikację płacimy raz, a nie raz przy każdej ponowionej próbie sprawdzenia.
            variant = {
              name: known.name,
              confidence: typeof grade.variant_confidence === 'number' ? grade.variant_confidence : null,
              source: grade.variant_source === 'teacher' ? 'teacher' : 'ai',
            };
            answerKey = known.answerKey;
          } else {
            const detected = await detectVariantFromImage(imagePath, variantInputs);

            if (!detected.ok) {
              await recordVariantSkipped(grade, detected.reason, detected.message);
              continue;
            }

            // Nazwę od modelu i tak przeganiamy przez listę zamrożoną na sesji: model potrafi podać
            // wariant, którego w tej sesji nie ma, a wtedy punkty liczono by z cudzego klucza.
            const match = findVariant(detected.variant);

            if (!match) {
              await recordVariantSkipped(
                grade,
                'unknown_variant',
                `Model wskazał nazwę spoza listy wariantów: ${detected.variant}`
              );
              continue;
            }

            const fresh = { name: match.name, confidence: detected.confidence, source: 'ai' as const };
            variant = fresh;
            answerKey = match.answerKey;

            // Zapis natychmiast, przed samym sprawdzaniem: gdyby padło wywołanie oceniające, a
            // rozpoznanie czekało na wspólny zapis z wynikami, następny /process zapłaciłby za tę
            // samą klasyfikację drugi raz. Wyjaśnienie z poprzedniej nieudanej próby kasujemy razem
            // z rozstrzygnięciem — praca już odpowiedziana nie może się o nie dopominać.
            await prisma.grade.update({
              where: { id: grade.id },
              data: {
                variant_name: fresh.name,
                variant_confidence: fresh.confidence,
                variant_source: fresh.source,
                variant_note: null,
              },
            });
          }
        }

        console.log(`📄 Sprawdzam pracę ${processedCount + 1}/${gradesCount}...`);

        // HYBRYDOWE WYWOŁANIE AI z automatyczną eskalacją
        const { result: aiResponse, model_used, escalated } = await gradeWithHybridAI(
          imagePath,
          answerKey
        );

        console.log(`🤖 Użyty model: ${model_used} ${escalated ? '(eskalowany)' : ''}`);
        console.log(`📊 Pewność: ${aiResponse.confidence_score}%, Punkty: ${aiResponse.total_score}`);

        // Zapis wyniku: `total_score` nie jest już arytmetyczną deklaracją modelu — serwis policzył go
        // z wierszy, które model sam wystawił, więc final_points nie może rozmijać się z tabelą punktów.
        await prisma.grade.update({
          where: { id: grade.id },
          data: {
            ai_response: aiResponse as any,
            confidence_score: aiResponse.confidence_score,
            final_points: aiResponse.total_score,
            model_used,
            escalated,
          },
        });

        // Zmniejsz limit użytkownika i zwiększ licznik
        await prisma.user.update({
          where: { id: req.user.userId },
          data: {
            pages_current_limit: { decrement: 1 },
            pages_total_processed: { increment: 1 },
          },
        });

        processedCount++;
        results.push({
          grade_id: grade.id,
          student_id: grade.student_id,
          confidence_score: aiResponse.confidence_score,
          total_score: aiResponse.total_score,
          model_used,
          escalated,
          ...(variant && { variant_name: variant.name }),
        });

        console.log(`✅ Sprawdzonych ${processedCount}/${gradesCount}`);
      } catch (error) {
        console.error(`❌ Nie udało się sprawdzić pracy ${grade.id}:`, error);
        results.push({
          grade_id: grade.id,
          student_id: grade.student_id,
          error: 'Failed to process',
        });
      }
    }

    // Sesja jest zakończona dopiero, gdy każdy uczeń, który miał pisać, ma pracę albo oznaczoną
    // nieobecność. Zostały osoby bez jednego i bez drugiego -> awaiting_works: nauczyciel wróci tu,
    // gdy uczeń odda pracę w innym terminie, a /process ponownie ruszy tylko prace bez wyników.
    //
    // Mianownikiem sesji grupowej jest unia uczniów przydzielonych do grup, nie cała klasa:
    // grupa to świadomy wybór nauczyciela, a osoba dopisana do klasy po utworzeniu sesji nigdy
    // nie miała pisać tego sprawdzianu. Bez grup zostaje lista klasy, tak jak dotąd.
    const populationIds =
      session.session_groups.length > 0
        ? groupPopulationIds(session.session_groups)
        : (
            await prisma.student.findMany({
              where: { class_id: session.class_id },
              select: { id: true },
            })
          ).map((student) => student.id);

    const absentIds = new Set<string>(idsFromJsonArray(session.absent_student_ids));
    const studentsWithWork = new Set<string>(grades.map((grade: any) => grade.student_id as string));
    const missing_count = countMissingStudents(populationIds, absentIds, studentsWithWork);
    const nextStatus = missing_count > 0 ? 'awaiting_works' : 'completed';

    await prisma.gradingSession.update({
      where: { id: sessionId },
      data: { status: nextStatus },
    });
    claimHeld = false;

    res.json({
      message: 'Session processed successfully',
      processed_count: processedCount,
      total_count: gradesCount,
      skipped_count: gradesCount - pendingCount,
      missing_count,
      // Tylko tryb 'ai' może tu cokolwiek dodać: praca bez rozstrzygniętego wariantu nie jest
      // oceniana i nie kosztuje strony, więc czeka na kliknięcie nauczyciela.
      awaiting_variant_count: awaitingVariantCount,
      status: nextStatus,
      results,
    });
  } catch (error) {
    console.error('Błąd sprawdzania sesji:', error);

    // Zwolnij przejęcie, żeby sesja nie czekała na wygaśnięcie porzuconego claimu
    if (claimHeld) {
      await prisma.gradingSession
        .update({ where: { id: sessionId }, data: { status: 'in_progress' } })
        .catch((releaseError: unknown) => {
          console.error('Nie udało się zwolnić blokady sesji:', releaseError);
        });
    }

    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * GET /api/grading/sessions/:sessionId
 * Pobiera szczegóły sesji wraz z wynikami
 */
export async function getGradingSession(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const { sessionId } = req.params;

    const session = await prisma.gradingSession.findFirst({
      where: {
        id: sessionId,
        user_id: req.user.userId,
      },
      include: {
        grades: {
          include: {
            student: true,
          },
          orderBy: {
            created_at: 'asc',
          },
        },
        class: {
          include: {
            _count: { select: { students: true } },
          },
        },
        grade_threshold: true,
        answer_key_ref: {
          select: {
            id: true,
            name: true,
          },
        },
        // Pełne grupy: wynik pracy jest pokazywany na tle klucza jej grupy, a nie klucza sesji.
        session_groups: {
          orderBy: { position: 'asc' },
        },
      },
    });

    if (!session) {
      res.status(404).json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }

    res.json({ session });
  } catch (error) {
    console.error('Błąd pobierania sesji sprawdzania:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * Licznik postępu dla paska sprawdzania. Z danych, nie z pamięci procesu: wiersz oceny dostaje
 * `final_points` dopiero po odpowiedzi AI, więc null nadal znaczy „czeka". Dzięki temu pasek
 * pokazuje stan prawdziwy także po odświeżeniu strony lub wznowieniu porzuconego przetwarzania.
 * Celowo nie jest to `getGradingSession` — ten zwraca `ai_response` każdej pracy (kB-y na pracę),
 * a frontend pyta o postęp co kilka sekund.
 */
export async function getGradingSessionProgress(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const { sessionId } = req.params;

    const session = await prisma.gradingSession.findFirst({
      where: { id: sessionId, user_id: req.user.userId },
      select: { status: true },
    });

    if (!session) {
      res.status(404).json({ error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }

    const [total_count, processed_count] = await Promise.all([
      prisma.grade.count({ where: { grading_session_id: sessionId } }),
      prisma.grade.count({ where: { grading_session_id: sessionId, final_points: { not: null } } }),
    ]);

    res.json({ status: session.status, total_count, processed_count });
  } catch (error) {
    console.error('Błąd pobierania postępu sesji:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

// Historia pokazuje maksymalnie tyle sesji na żądanie
const MAX_HISTORY_PAGE_SIZE = 200;

// Poniżej tej pewności AI praca wymaga oka nauczyciela. To próg UI (ten sam co w
// GradingResults), NIE mylić z progiem eskalacji modelu w aiGradingService (75).
const UI_LOW_CONFIDENCE_THRESHOLD = 70;

// Zapas bezpieczeństwa dla PATCH oceny: kształt klucza i tak ogranicza liczbę wierszy
const GRADE_TASKS_MAX_COUNT = 200;
const GRADE_COMMENT_MAX_LENGTH = 2000;

/**
 * Klucz odpowiedzi trzyma `id` jako string, a AI zwraca `task_number` jako liczbę.
 * Numeryczne identyfikatory pasują po obu postaciach ("3" oraz 3), więc jedna lista domyka obie strony.
 */
function taskIdentifiers(taskId: string): string[] {
  const identifiers = [taskId];
  const asNumber = Number(taskId);
  if (taskId !== '' && Number.isInteger(asNumber) && String(asNumber) !== taskId) {
    identifiers.push(String(asNumber));
  }
  return identifiers;
}

/**
 * Identyfikator podpunktu do porównania: przycięty i bez rozróżniania wielkości liter, czyli tak
 * samo jak w serwisie AI (`subKey`). Klucz dopuszcza „A" i „a" w różnych zadaniach, a nauczyciel
 * wpisze to, co widzi na kartce.
 */
function subIdentifier(id: unknown): string {
  const text = typeof id === 'string' ? id : typeof id === 'number' && Number.isFinite(id) ? String(id) : '';
  return text.trim().toLocaleLowerCase();
}

/**
 * `task_number` w `teacher_response` zostaje liczbą — ten sam kształt co w odpowiedzi AI.
 * Identyfikator klucza, którego nie da się przeczytać jako liczby, schodzi do pozycji na liście.
 */
function taskNumberForDisplay(taskId: string, index: number): number {
  const asNumber = Number(taskId);
  return Number.isInteger(asNumber) ? asNumber : index + 1;
}

/**
 * Parametry z query są inputem użytkownika: NaN, ujemne i przekręcone wartości
 * muszą wrócić do sensownego zakresu, zanim trafią do SQL.
 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

// Alias typu, nie interface: tylko pierwszy dostaje implicytną sygnaturę indeksową,
// więc Prisma przyjmuje go w kolumnie Json bez rzutu.
type TeacherSubItemRow = {
  id: string;
  points: number;
  max_points: number;
};

/**
 * Wiersz poprawki nauczyciela. `sub_items` zapisujemy wyłącznie dla zadań poprawianych per podpunkt,
 * więc ich suma zawsze zgadza się z `points` tego wiersza. Poprawka zbiorcza (sama suma, bez
 * podziału) świadomie nie dostaje podziału i czytający ma pokazać wtedy tylko łączną liczbę punktów:
 * wiersze AI pod tym zadaniem już do niej nie pasują, a udawanie, że pasują, to gotowe kłamstwo
 * w kartotece ucznia.
 */
type TeacherTaskRow = {
  task_number: number;
  points: number;
  comment: string;
  edited: boolean;
  sub_items?: TeacherSubItemRow[];
};

type TeacherResponsePayload = {
  total_score: number;
  tasks: TeacherTaskRow[];
};

type GradeUpdateData = {
  teacher_notes?: string | null;
  manually_verified?: boolean;
  final_points?: number;
  teacher_response?: TeacherResponsePayload;
};

/**
 * GET /api/grading/sessions
 * Historia sprawdzania prac: lista sesji nauczyciela z liczbami do tabeli.
 * Nie zwraca `answer_key` — to treść klucza i pełne poprawne odpowiedzi, lista ich nie potrzebuje.
 */
export async function getGradingSessions(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const limit = clampInt(req.query.limit, 50, 1, MAX_HISTORY_PAGE_SIZE);
    const offset = clampInt(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

    const sessions = await prisma.gradingSession.findMany({
      where: { user_id: req.user.userId },
      orderBy: { created_at: 'desc' },
      take: limit,
      skip: offset,
      select: {
        id: true,
        name: true,
        class_id: true,
        status: true,
        created_at: true,
        updated_at: true,
        class: { select: { id: true, encrypted_name: true, _count: { select: { students: true } } } },
        answer_key_ref: { select: { id: true, name: true, subject: true } },
        grade_threshold: { select: { id: true, name: true } },
        absent_student_ids: true,
        // `student_ids` służy wyłącznie mianownikowi brakujących prac; do klienta idą nazwy i liczby.
        session_groups: {
          select: { id: true, name: true, position: true, student_ids: true },
          orderBy: { position: 'asc' },
        },
        grades: {
          select: {
            id: true,
            student_id: true,
            confidence_score: true,
            final_points: true,
            manually_verified: true,
          },
        },
      },
    });

    const total_count = await prisma.gradingSession.count({
      where: { user_id: req.user.userId },
    });

    // Skala: historia to na razie setki sesji na nauczyciela, więc agregaty liczymy w JS po
    // pobraniu (Prisma nie zrobi avg po relacji). Przy tysiącach wierszy złożyć to w jedno GROUP BY.
    const summaries = sessions.map((session) => {
      const works = session.grades;
      const works_count = works.length;
      const graded = works.filter((grade) => grade.final_points !== null);
      const manually_verified_count = works.filter((grade) => grade.manually_verified).length;

      // Średnia tylko po pracach sprawdzonych przez AI: wiersz po ponownym przesłaniu pracy
      // ma confidence_score = 0 i inaczej ciągnąłby wynik sesji w dół.
      const avg_confidence =
        graded.length === 0
          ? 0
          : Math.round(graded.reduce((sum, grade) => sum + grade.confidence_score, 0) / graded.length);

      const absentIds = new Set<string>(idsFromJsonArray(session.absent_student_ids));
      const groups = session.session_groups;

      // Unia, nie suma: uczeń może mieć przesłaną pracę z wcześniejszej próby i jednocześnie
      // wpis na liście nieobecnych. Suma podwójnie policzyłby taką osobę.
      const workedIds = new Set<string>(works.map((grade) => grade.student_id));
      const missing_count =
        groups.length > 0
          ? countMissingStudents(groupPopulationIds(groups), absentIds, workedIds)
          : Math.max((session.class?._count.students ?? 0) - new Set([...absentIds, ...workedIds]).size, 0);

      return {
        id: session.id,
        name: session.name,
        created_at: session.created_at,
        updated_at: session.updated_at,
        status: session.status,
        class_id: session.class_id,
        encrypted_class_name: session.class?.encrypted_name ?? null,
        answer_key_name: session.answer_key_ref?.name ?? null,
        answer_key_subject: session.answer_key_ref?.subject ?? null,
        threshold_name: session.grade_threshold?.name ?? null,
        // null dla sesji bez grup — frontend nie musi odróżniać pustej tablicy od braku grupowania.
        session_groups:
          groups.length > 0
            ? groups.map((group) => ({
                id: group.id,
                name: group.name,
                position: group.position,
                students_count: idsFromJsonArray(group.student_ids).length,
              }))
            : null,
        works_count,
        absent_count: absentIds.size,
        missing_count,
        graded_count: graded.length,
        avg_confidence,
        low_confidence_count: graded.filter(
          (grade) => grade.confidence_score < UI_LOW_CONFIDENCE_THRESHOLD
        ).length,
        needs_verification: graded.length > 0 && avg_confidence < UI_LOW_CONFIDENCE_THRESHOLD,
        manually_verified_count,
        has_manual_edits: manually_verified_count > 0,
      };
    });

    res.json({ sessions: summaries, total_count });
  } catch (error) {
    console.error('Błąd pobierania listy sesji sprawdzania:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * PATCH /api/grading/sessions/:sessionId/grades/:gradeId
 * Zapisuje poprawki nauczyciela do `grades.teacher_response`.
 * `ai_response` zostaje nietknięte — oryginalna odpowiedź AI musi pozostać śladem do audytu.
 */
export async function updateGrade(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const { sessionId, gradeId } = req.params;

    const grade = await prisma.grade.findFirst({
      where: {
        id: gradeId,
        grading_session: { id: sessionId, user_id: req.user.userId },
      },
      include: { grading_session: { include: { session_groups: true } } },
    });

    if (!grade) {
      res.status(404).json({ error: 'Grade not found', code: 'GRADE_NOT_FOUND' });
      return;
    }

    if (grade.grading_session.status === 'processing') {
      res.status(409).json({ error: 'Session is being processed', code: 'SESSION_PROCESSING' });
      return;
    }

    const { tasks, teacher_notes, mark_verified, variant_name } = req.body ?? {};

    // Wskaźnik wariantu to kasownik dotychczasowego wyniku i osobna rozmowa z modelem — nie łączymy
    // go z poprawkami punktów w jednym żądaniu, więc obsługę kończymy tutaj.
    if (variant_name !== undefined) {
      await applyVariantChoice(res, grade, variant_name, tasks, req.user.userId);
      return;
    }

    const data: GradeUpdateData = {};

    if (teacher_notes !== undefined) {
      if (teacher_notes !== null && typeof teacher_notes !== 'string') {
        res.status(400).json({ error: 'teacher_notes must be a string or null', code: 'GRADE_NOTES_INVALID' });
        return;
      }
      data.teacher_notes = teacher_notes;
    }

    // `manually_verified` tylko zapala, nigdy nie gasi wbrew bazie
    if (mark_verified === true) {
      data.manually_verified = true;
    }

    if (Array.isArray(tasks)) {
      if (tasks.length > GRADE_TASKS_MAX_COUNT) {
        res.status(400).json({
          error: `tasks must contain at most ${GRADE_TASKS_MAX_COUNT} entries`,
          code: 'GRADE_TASKS_TOO_MANY',
        });
        return;
      }

      // Bez rozstrzygniętego wariantu nie ma też własnej skali tej pracy: zostałby wyłącznie klucz
      // wariantu 0, a poprawki punktów liczone przeciw obcemu maksimum to gotowa pomyłka w dzienniku.
      if (grade.grading_session.group_assignment_mode === 'ai' && !grade.variant_name) {
        res.status(400).json({
          error: 'Wskaż wariant arkusza tej pracy przed poprawieniem punktów',
          code: 'GRADE_VARIANT_UNRESOLVED',
        });
        return;
      }

      // Skala punktów = snapshot klucza z tej sesji, nie aktualna wersja z biblioteki.
      // W sesji grupowej to klucz grupy ucznia; w sesji z rozpoznawaniem — klucz wariantu trafionego
      // przez tę pracę. Wariant B ma inne max_points niż wariant A, a `answer_key` sesji to zawsze wariant 0.
      const snapshot =
        variantKeyForGrade(grade.grading_session, grade.variant_name) ??
        (buildAnswerKeyResolver(grade.grading_session)(grade.student_id) as any);
      const keyTasks = toTaskArray(snapshot?.tasks ?? []);

      const keyTaskByIdentifier = new Map<string, (typeof keyTasks)[number]>();
      for (const task of keyTasks) {
        for (const identifier of taskIdentifiers(task.id)) {
          if (!keyTaskByIdentifier.has(identifier)) keyTaskByIdentifier.set(identifier, task);
        }
      }

      const edits = new Map<string, { points: number; comment: string | null; subItems?: TeacherSubItemRow[] }>();

      for (const entry of tasks) {
        if (!entry || typeof entry !== 'object') {
          res.status(400).json({ error: 'Each task must be an object', code: 'GRADE_TASK_INVALID' });
          return;
        }

        const raw = entry as Record<string, unknown>;
        const identifier = String(raw.task_number);
        const keyTask = keyTaskByIdentifier.get(identifier);

        if (!keyTask || !Number.isInteger(raw.task_number)) {
          res.status(400).json({
            error: `Task ${identifier} does not exist in this session answer key`,
            code: 'GRADE_TASK_UNKNOWN',
          });
          return;
        }

        const comment = raw.comment;
        if (comment !== undefined && (typeof comment !== 'string' || comment.length > GRADE_COMMENT_MAX_LENGTH)) {
          res.status(400).json({
            error: `Comment for task ${identifier} must be a string of at most ${GRADE_COMMENT_MAX_LENGTH} characters`,
            code: 'GRADE_COMMENT_INVALID',
          });
          return;
        }
        const commentText = typeof comment === 'string' ? comment : null;

        // Bez wierszy podpunktów zostaje stara ścieżka: nauczyciel wpisuje punkty zadania, sufit to
        // maksimum z klucza tej sesji.
        if (raw.sub_items === undefined || raw.sub_items === null) {
          const points = raw.points;
          if (typeof points !== 'number' || !Number.isFinite(points) || points < 0 || points > keyTask.max_points) {
            res.status(400).json({
              error: `Points for task ${identifier} must be between 0 and ${keyTask.max_points}`,
              code: 'GRADE_POINTS_INVALID',
            });
            return;
          }

          edits.set(identifier, { points, comment: commentText });
          continue;
        }

        const keySubs = keyTask.sub_items ?? [];
        if (!Array.isArray(raw.sub_items)) {
          res.status(400).json({ error: 'sub_items must be an array', code: 'GRADE_SUB_ITEMS_INVALID' });
          return;
        }
        if (keySubs.length === 0) {
          res.status(400).json({
            error: `Task ${identifier} has no sub-items in this session answer key`,
            code: 'GRADE_SUB_ITEMS_NOT_ALLOWED',
          });
          return;
        }

        const subById = new Map<string, (typeof keySubs)[number]>();
        for (const sub of keySubs) {
          const key = subIdentifier(sub.id);
          if (!subById.has(key)) subById.set(key, sub);
        }

        const subItems: TeacherSubItemRow[] = [];
        const seenSubs = new Set<string>();

        for (const subEntry of raw.sub_items) {
          if (!subEntry || typeof subEntry !== 'object') {
            res.status(400).json({ error: 'Each sub-item must be an object', code: 'GRADE_SUB_ITEMS_INVALID' });
            return;
          }

          const subRaw = subEntry as Record<string, unknown>;
          const subKey = subIdentifier(subRaw.id);
          const keySub = subById.get(subKey);

          if (!keySub) {
            res.status(400).json({
              error: `Sub-item ${String(subRaw.id)} does not exist in task ${identifier} of this session answer key`,
              code: 'GRADE_SUB_ITEM_UNKNOWN',
            });
            return;
          }
          if (seenSubs.has(subKey)) {
            res.status(400).json({
              error: `Sub-item ${keySub.id} is listed twice for task ${identifier}`,
              code: 'GRADE_SUB_ITEM_DUPLICATED',
            });
            return;
          }
          seenSubs.add(subKey);

          const subPoints = subRaw.points;
          if (
            typeof subPoints !== 'number' ||
            !Number.isFinite(subPoints) ||
            subPoints < 0 ||
            subPoints > keySub.max_points
          ) {
            res.status(400).json({
              error: `Points for sub-item ${keySub.id} of task ${identifier} must be between 0 and ${keySub.max_points}`,
              code: 'GRADE_SUB_ITEM_POINTS_INVALID',
            });
            return;
          }

          subItems.push({ id: keySub.id, points: subPoints, max_points: keySub.max_points });
        }

        // Suma należy do serwera: identycznie jak przy ocenie AI to liczba wierszy razy ich stawka,
        // a nie liczba poprawnych podpunktów. `points` z żądania jest tu świadomie pomijane.
        // Podpunkt, którego klient nie wysłał, znaczy zero — niewpisany wiersz to brak punktów.
        const points = Number(subItems.reduce((sum, sub) => sum + sub.points, 0).toFixed(2));

        edits.set(identifier, {
          points: Math.min(points, keyTask.max_points),
          comment: commentText,
          subItems,
        });
      }

      // Bazowy dorobek AI: wiersze, których AI nie zwróciło, schodzą do zera bez flagi edycji
      const aiTasksRaw = (grade.ai_response as any)?.tasks;
      const aiRows = new Map<string, { points: number; comment: string }>();
      if (Array.isArray(aiTasksRaw)) {
        for (const row of aiTasksRaw) {
          if (!row || typeof row !== 'object') continue;
          const raw = row as Record<string, unknown>;
          const identifier = String(raw.task_number);
          if (aiRows.has(identifier)) continue;
          aiRows.set(identifier, {
            points: typeof raw.points === 'number' && Number.isFinite(raw.points) ? raw.points : 0,
            comment: typeof raw.comment === 'string' ? raw.comment : '',
          });
        }
      }

      const resolvedTasks: TeacherTaskRow[] = keyTasks.map((task, index) => {
        const editIdentifier = taskIdentifiers(task.id).find((identifier) => edits.has(identifier));
        const aiIdentifier = taskIdentifiers(task.id).find((identifier) => aiRows.has(identifier));
        const edit = editIdentifier ? edits.get(editIdentifier) : undefined;
        const aiRow = aiIdentifier ? aiRows.get(aiIdentifier) : undefined;

        return {
          task_number: taskNumberForDisplay(task.id, index),
          points: edit ? edit.points : aiRow?.points ?? 0,
          comment: edit?.comment ?? aiRow?.comment ?? '',
          edited: edit !== undefined,
          ...(edit?.subItems ? { sub_items: edit.subItems } : {}),
        };
      });

      const total_score = Number(
        resolvedTasks.reduce((sum, task) => sum + task.points, 0).toFixed(2)
      );

      data.teacher_response = { total_score, tasks: resolvedTasks };
      data.final_points = total_score;
    }

    const updated = await prisma.grade.update({ where: { id: grade.id }, data });

    res.json({ grade: updated });
  } catch (error) {
    console.error('Błąd zapisu poprawek oceny:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * Nauczyciel wskazuje, który wariant trafił do tej pracy — bo AI jej nie rozstrzygnęło albo rozstrzygnęło
 * obok. To wskazanie nie jest sugestią doklejoną do istniejącego wyniku: punkty liczone z cudzego klucza
 * wyglądałyby jak zwykła, tylko zła nota, więc kasujemy dorobek sprawdzenia i tę jedną kartkę oceniamy
 * od nowa, z kluczem wskazanego wariantu.
 *
 * Koszt to dokładnie jedna strona z salda, pobrana dopiero po udanym sprawdzeniu — tak samo jak w
 * `/process`. Salda pilnujemy PRZED pierwszym zapisem: nauczyciel ma zostać z jasnym komunikatem o
 * braku stron, a nie z wyzerowaną pracą, której nie ma czym sprawdzić.
 */
async function applyVariantChoice(
  res: Response,
  grade: {
    id: string;
    image_path: string;
    grading_session: { group_assignment_mode?: string | null; answer_key_variants?: unknown };
  },
  variantName: unknown,
  tasks: unknown,
  userId: string
): Promise<void> {
  if (tasks !== undefined) {
    // Jedno żądanie nie może jednocześnie nadpisywać klucz wyniku i ręcznie poprawiać punktów —
    // poprawki odniosłyby się do wariantu, który za chwilę zamieniamy na inny.
    res.status(400).json({
      error: 'variant_name cannot be combined with task edits',
      code: 'GRADE_VARIANT_WITH_TASKS',
    });
    return;
  }

  const variants = frozenVariantsFor(grade.grading_session);

  if (!variants) {
    res.status(400).json({
      error: 'This session takes its variant from the group assignment, not from detection',
      code: 'VARIANT_DETECTION_DISABLED',
    });
    return;
  }

  const match = variantResolver(variants)(variantName);

  if (!match) {
    // Tak samo jak przy rozpoznaniu: nazwy spoza zamrożonej listy nie zapisujemy, bo punkty
    // wyszłyby z klucza, którego w tej sesji nigdy nie było.
    res.status(400).json({ error: 'Unknown variant for this session', code: 'VARIANT_NOT_AVAILABLE' });
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { pages_current_limit: true },
  });

  if (!user || user.pages_current_limit < 1) {
    res.status(403).json({
      error: 'Page limit exceeded',
      code: 'PAGE_LIMIT_EXCEEDED',
      current_limit: user?.pages_current_limit ?? 0,
      required_pages: 1,
      message: 'Re-grading this paper needs 1 page, but the balance is empty.',
    });
    return;
  }

  await prisma.grade.update({
    where: { id: grade.id },
    data: {
      variant_name: match.name,
      variant_confidence: null,
      variant_source: 'teacher',
      variant_note: null,
      // Dotychczasowy wynik jest nieważny, bo liczony z innego klucza — także poprawki nauczyciela
      // i pieczątka „sprawdzone", bo one odnoszą się do kasowanych wierszy.
      ai_response: {},
      confidence_score: 0,
      final_points: null,
      model_used: null,
      escalated: null,
      teacher_response: Prisma.JsonNull,
      manually_verified: false,
    },
  });

  try {
    const { result, model_used, escalated } = await gradeWithHybridAI(
      absoluteUploadPath(grade.image_path),
      match.answerKey
    );

    await prisma.grade.update({
      where: { id: grade.id },
      data: {
        ai_response: result as any,
        confidence_score: result.confidence_score,
        final_points: result.total_score,
        model_used,
        escalated,
      },
    });

    await prisma.user.update({
      where: { id: userId },
      data: {
        pages_current_limit: { decrement: 1 },
        pages_total_processed: { increment: 1 },
      },
    });

    const updated = await prisma.grade.findUnique({ where: { id: grade.id } });

    res.json({ grade: updated, variant_name: match.name, regraded: true });
  } catch (error) {
    console.error(`Nie udało się przeliczyć pracy ${grade.id} po wskazanym wariancie:`, error);

    // Wskazany wariant zostaje w bazie i żadna strona nie schodzi z salda: praca jest gotowa do
    // sprawdzenia bez ponownej klasyfikacji, więc wystarczy zwykłe „Sprawdź prace".
    res.status(502).json({
      error: 'Variant saved, but the paper could not be graded. Run the session check again.',
      code: 'VARIANT_GRADE_FAILED',
      variant_name: match.name,
    });
  }
}
