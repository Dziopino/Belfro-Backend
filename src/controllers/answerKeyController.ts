import { Request, Response } from 'express';
import prisma from '../config/database';

/**
 * Podpunkt zadania (a, b, c...). Istnieje tylko po to, żeby ocena częściowa była zapisana
 * strukturalnie, a nie opisana zdaniem w `guidelines`: jeśli zadanie ma podpunkty, jego
 * `max_points` to suma punktów podpunktów, liczona przez serwer. Punktów wpisanych osobno
 * dla takiego zadania nie przyjmujemy — to one pozwalały postawić 2/2 przy dwóch poprawnych
 * z czterech.
 */
export type AnswerKeySubItem = {
  id: string;
  max_points: number;
  correct_answer: string;
};

// Alias typu, nie interface: tylko pierwszy dostaje implicytną sygnaturę
// indeksową, więc Prisma przyjmuje go w kolumnie Json bez rzutu.
export type AnswerKeyTask = {
  id: string;
  max_points: number;
  correct_answer: string;
  guidelines: string;
  sub_items?: AnswerKeySubItem[];
};

type NormalizedTasks = {
  tasks: AnswerKeyTask[];
  total_points: number;
};

type ValidationProblem = {
  error: string;
  code: string;
};

/** Jeden wariant zadań w kluczu („Grupa A"): własne wiersze i własna suma punktów. */
export type AnswerKeyVariant = {
  name: string;
  tasks: AnswerKeyTask[];
  total_points: number;
};

const NAME_MAX_LENGTH = 100;
const SUBJECT_MAX_LENGTH = 60;
const TASKS_MAX_COUNT = 200;
const MAX_POINTS_LIMIT = 1000;

const SUB_ITEMS_MAX_COUNT = 20;
const SUB_ITEM_ID_MAX_LENGTH = 10;

/**
 * Punkty zaokrąglamy do dwóch miejsc: `0.1 + 0.1 + 0.1` w binarnym zmiennoprzecinkowym daje
 * 0.30000000000000004, a ta liczba idzie do kolumny Float i do tekstu promptu. Podpunkty po 0,5
 * są tu codziennością, więc zaokrąglenie robimy raz, przy normalizacji.
 */
function roundPoints(value: number): number {
  return Math.round(value * 100) / 100;
}

// Te same limity co po stronie grup sesji (gradingController) — klucz definiuje warianty,
// a sesja tylko przypisuje do nich uczniów, więc nic tu nie może być hojniejsze.
const GROUPS_MAX_COUNT = 8;
const GROUP_NAME_MAX_LENGTH = 30;

function isProblem<T extends object>(result: T | ValidationProblem): result is ValidationProblem {
  return 'error' in result;
}

/**
 * Waliduje i normalizuje wiersze zadań: przycina teksty, liczy sumę punktów po swojej
 * stronie i sortuje naturalnie po `id`, żeby ten sam klucz zawsze dawał identyczny blok
 * w promptcie (warunek trafienia cache po stronie API).
 *
 * To jedyne miejsce, gdzie sprawdzany jest kształt podpunktów. Wszystkie snapshoty klucza
 * (sesja, grupy sesji, warianty) przechodzą przez tę funkcję, więc raz zwalidowana treść
 * nie wymaga walidacji po raz drugi.
 */
export function normalizeTasks(input: unknown): NormalizedTasks | ValidationProblem {
  if (!Array.isArray(input) || input.length === 0) {
    return {
      error: 'Answer key must contain at least one task',
      code: 'ANSWER_KEY_TASKS_REQUIRED',
    };
  }

  if (input.length > TASKS_MAX_COUNT) {
    return {
      error: `Answer key must contain at most ${TASKS_MAX_COUNT} tasks`,
      code: 'ANSWER_KEY_TASK_INVALID',
    };
  }

  const tasks: AnswerKeyTask[] = [];
  const seenIds = new Set<string>();

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') {
      return {
        error: 'Each task must be an object with id, max_points, correct_answer and guidelines',
        code: 'ANSWER_KEY_TASK_INVALID',
      };
    }

    const raw = entry as Record<string, unknown>;

    // Identyfikator zadania przychodzi jako numer (kreator) albo tekst (biblioteka) —
    // zapisujemy zawsze string, żeby sortowanie i porównania miały jeden kształt.
    const rawId =
      typeof raw.id === 'string'
        ? raw.id.trim()
        : typeof raw.id === 'number' && Number.isFinite(raw.id)
          ? String(raw.id)
          : '';
    if (!rawId || rawId.length > 20) {
      return {
        error: 'Each task id must be a string with 1-20 characters',
        code: 'ANSWER_KEY_TASK_INVALID',
      };
    }

    if (seenIds.has(rawId)) {
      return {
        error: 'Duplicate task ids are not allowed',
        code: 'ANSWER_KEY_TASK_INVALID',
      };
    }
    seenIds.add(rawId);

    const correctAnswer = typeof raw.correct_answer === 'string' ? raw.correct_answer.trim() : '';
    const guidelines = typeof raw.guidelines === 'string' ? raw.guidelines.trim() : '';

    if (raw.sub_items !== undefined && raw.sub_items !== null && !Array.isArray(raw.sub_items)) {
      return { error: 'sub_items must be an array', code: 'ANSWER_KEY_SUB_ITEM_INVALID' };
    }

    // Pusta tablica to „bez podpunktów": edytor wysyła to pole przy każdym zadaniu, więc
    // przełączenie funkcji nie może wymagać kasowania klucza.
    const rawSubItems = Array.isArray(raw.sub_items) ? raw.sub_items : [];
    let subItems: AnswerKeySubItem[] | undefined;

    if (rawSubItems.length > 0) {
      if (rawSubItems.length > SUB_ITEMS_MAX_COUNT) {
        return {
          error: `A task may have at most ${SUB_ITEMS_MAX_COUNT} sub-items`,
          code: 'ANSWER_KEY_SUB_ITEM_INVALID',
        };
      }

      const parsed: AnswerKeySubItem[] = [];
      const seenSubIds = new Set<string>();

      for (const subEntry of rawSubItems) {
        if (!subEntry || typeof subEntry !== 'object') {
          return {
            error: 'Each sub-item must be an object with id, max_points and correct_answer',
            code: 'ANSWER_KEY_SUB_ITEM_INVALID',
          };
        }

        const subRaw = subEntry as Record<string, unknown>;
        const subId =
          typeof subRaw.id === 'string'
            ? subRaw.id.trim()
            : typeof subRaw.id === 'number' && Number.isFinite(subRaw.id)
              ? String(subRaw.id)
              : '';
        if (!subId || subId.length > SUB_ITEM_ID_MAX_LENGTH) {
          return {
            error: `Each sub-item id must be a string with 1-${SUB_ITEM_ID_MAX_LENGTH} characters`,
            code: 'ANSWER_KEY_SUB_ITEM_INVALID',
          };
        }

        // Zakres unikalności to jedno zadanie, nie cały klucz: „a" powtarza się w każdym
        // teście, a rozróżniamy podpunkty wyłącznie w obrębie ich rodzica.
        const dedupKey = subId.toLocaleLowerCase();
        if (seenSubIds.has(dedupKey)) {
          return {
            error: 'Sub-item ids must be unique within a task',
            code: 'ANSWER_KEY_SUB_ITEM_ID_DUPLICATED',
          };
        }
        seenSubIds.add(dedupKey);

        const subMaxPoints = subRaw.max_points;
        if (
          typeof subMaxPoints !== 'number' ||
          !Number.isFinite(subMaxPoints) ||
          subMaxPoints <= 0 ||
          subMaxPoints > MAX_POINTS_LIMIT
        ) {
          return {
            error: `Each sub-item max_points must be a positive number up to ${MAX_POINTS_LIMIT}`,
            code: 'ANSWER_KEY_SUB_ITEM_INVALID',
          };
        }

        parsed.push({
          id: subId,
          max_points: roundPoints(subMaxPoints),
          correct_answer: typeof subRaw.correct_answer === 'string' ? subRaw.correct_answer.trim() : '',
        });
      }

      subItems = parsed;
    }

    let maxPoints: number;
    if (subItems) {
      // Zadanie z podpunktami nie ma własnej punktacji do wpisania — bierze ją z ich sumy, więc
      // klucz nie może być wewnętrznie sprzeczny. Wartość od klienta jest tu świadomie ignorowana.
      maxPoints = roundPoints(subItems.reduce((sum, sub) => sum + sub.max_points, 0));
      if (maxPoints > MAX_POINTS_LIMIT) {
        return {
          error: `Sum of sub-item points must not exceed ${MAX_POINTS_LIMIT}`,
          code: 'ANSWER_KEY_SUB_ITEM_INVALID',
        };
      }
    } else {
      const declaredMaxPoints = raw.max_points;
      if (
        typeof declaredMaxPoints !== 'number' ||
        !Number.isFinite(declaredMaxPoints) ||
        declaredMaxPoints <= 0 ||
        declaredMaxPoints > MAX_POINTS_LIMIT
      ) {
        return {
          error: `Each max_points must be a number between 1 and ${MAX_POINTS_LIMIT}`,
          code: 'ANSWER_KEY_TASK_INVALID',
        };
      }
      maxPoints = roundPoints(declaredMaxPoints);
    }

    tasks.push({
      id: rawId,
      max_points: maxPoints,
      correct_answer: correctAnswer,
      guidelines,
      ...(subItems ? { sub_items: subItems } : {}),
    });
  }

  const total_points = roundPoints(tasks.reduce((sum, task) => sum + task.max_points, 0));

  tasks.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));

  return { tasks, total_points };
}

/**
 * Wyciąga wiersze zadań z kolumny Json (Prisma zwraca `JsonValue`). Używane przy robieniu
 * snapshotu klucza na sesji — bez tego nie da się wpisać tablicy do kolejnej kolumny Json.
 */
export function toTaskArray(value: unknown): AnswerKeyTask[] {
  const result = normalizeTasks(value);
  return isProblem(result) ? [] : result.tasks;
}

/**
 * Waliduje opcjonalną listę wariantów. Brak lub pusta tablica to klucz jednowariantowy — dokładnie
 * to, co biblioteka znała do teraz, więc żadne istniejące wywołanie nie zmienia zachowania.
 * Nazwy muszą być różne: po stronie sesji i PDF warianty są rozróżniane właśnie po nazwie, więc
 * dwa „A" dałyby arkusz z punktem przydzielonym do złej tabeli.
 */
export function normalizeGroupsInput(input: unknown): AnswerKeyVariant[] | ValidationProblem {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) {
    return { error: 'groups must be an array', code: 'ANSWER_KEY_GROUPS_INVALID' };
  }
  if (input.length === 0) return [];

  if (input.length > GROUPS_MAX_COUNT) {
    return {
      error: `Answer key must contain at most ${GROUPS_MAX_COUNT} groups`,
      code: 'ANSWER_KEY_GROUPS_INVALID',
    };
  }

  const variants: AnswerKeyVariant[] = [];
  const seenNames = new Set<string>();

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') {
      return { error: 'Each group must be an object with name and tasks', code: 'ANSWER_KEY_GROUPS_INVALID' };
    }

    const raw = entry as Record<string, unknown>;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name || name.length > GROUP_NAME_MAX_LENGTH) {
      return {
        error: `Each group name must be between 1 and ${GROUP_NAME_MAX_LENGTH} characters`,
        code: 'ANSWER_KEY_GROUP_NAME_INVALID',
      };
    }

    if (seenNames.has(name.toLocaleLowerCase())) {
      return { error: 'Group names must be unique', code: 'ANSWER_KEY_GROUP_NAME_DUPLICATED' };
    }
    seenNames.add(name.toLocaleLowerCase());

    const tasksResult = normalizeTasks(raw.tasks);
    if (isProblem(tasksResult)) return tasksResult;

    variants.push({ name, tasks: tasksResult.tasks, total_points: tasksResult.total_points });
  }

  return variants;
}

function validateNameInput(name: unknown, subject: unknown): { name: string; subject: string | null } | ValidationProblem {
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName || trimmedName.length > NAME_MAX_LENGTH) {
    return {
      error: `Answer key name must be between 1 and ${NAME_MAX_LENGTH} characters`,
      code: 'ANSWER_KEY_NAME_REQUIRED',
    };
  }

  const trimmedSubject = typeof subject === 'string' ? subject.trim() : '';
  if (trimmedSubject.length > SUBJECT_MAX_LENGTH) {
    return {
      error: `Subject must be at most ${SUBJECT_MAX_LENGTH} characters`,
      code: 'ANSWER_KEY_NAME_REQUIRED',
    };
  }

  return { name: trimmedName, subject: trimmedSubject || null };
}

/**
 * Warianty dla klienta: bez znaczników czasu, za to z tablicą zadań odzyskaną z kolumny Json.
 * Porządek bierzemy z `position`, nie z kolejności wierszy — usunięty wariant zostawia dziurę.
 */
function variantRows(
  rows: Array<{ id: string; position: number; name: string; tasks: unknown; total_points: number }>
): Array<{ id: string; position: number; name: string; tasks: AnswerKeyTask[]; total_points: number }> {
  return rows
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((row) => ({
      id: row.id,
      position: row.position,
      name: row.name,
      tasks: toTaskArray(row.tasks),
      total_points: row.total_points,
    }));
}

type KeyWithVariants = {
  id: string;
  user_id: string;
  name: string;
  subject: string | null;
  tasks: unknown;
  total_points: number;
  created_at: Date;
  updated_at: Date;
  answer_key_groups: Array<{ id: string; position: number; name: string; tasks: unknown; total_points: number }>;
};

/**
 * Klucz dla klienta: wiersz answer_keys z wariantami pod spójną nazwą `groups`.
 * `tasks`/`total_points` na kluczu zostają surowe — to zawsze wariant zerowy, więc starszy
 * klient (np. kreator bez grup) czyta z niego dalej.
 */
function keyPayload(key: KeyWithVariants) {
  const { answer_key_groups: groups, ...rest } = key;
  return { ...rest, groups: variantRows(groups) };
}

/**
 * GET /api/answer-keys
 * Lista kluczy zalogowanego nauczyciela. Bez treści zadań — pełny klucz pobiera się jednym
 * GET-em po id, żeby lista nie taszczyła starych sprawdzianów.
 */
export async function getAnswerKeys(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const keys = await prisma.answerKey.findMany({
      where: { user_id: req.user.userId },
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        name: true,
        subject: true,
        tasks: true,
        total_points: true,
        created_at: true,
        updated_at: true,
        // Tylko metadane wariantów: lista biblioteki nie może taszczyć treści wszystkich kluczy.
        answer_key_groups: {
          orderBy: { position: 'asc' },
          select: { id: true, position: true, name: true, total_points: true },
        },
        _count: { select: { grading_sessions: true } },
      },
    });

    res.json({
      answer_keys: keys.map((key) => ({
        id: key.id,
        name: key.name,
        subject: key.subject,
        tasks_count: Array.isArray(key.tasks) ? key.tasks.length : 0,
        total_points: key.total_points,
        sessions_count: key._count.grading_sessions,
        groups: key.answer_key_groups,
        groups_count: key.answer_key_groups.length,
        created_at: key.created_at,
        updated_at: key.updated_at,
      })),
    });
  } catch (error) {
    console.error('Get answer keys error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * POST /api/answer-keys
 * Tworzy klucz w bibliotece. Sumy punktów nigdy nie bierzemy od klienta.
 */
export async function createAnswerKey(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { name, subject, tasks, groups } = req.body;

    const nameResult = validateNameInput(name, subject);
    if (isProblem(nameResult)) {
      res.status(400).json(nameResult);
      return;
    }

    const groupsResult = normalizeGroupsInput(groups);
    if (isProblem(groupsResult)) {
      res.status(400).json(groupsResult);
      return;
    }

    // Z wariantami płaskie `tasks` jest ignorowane: kolumny klucza to kopia wariantu zerowego.
    const tasksResult =
      groupsResult.length > 0
        ? { tasks: groupsResult[0].tasks, total_points: groupsResult[0].total_points }
        : normalizeTasks(tasks);
    if (isProblem(tasksResult)) {
      res.status(400).json(tasksResult);
      return;
    }

    const newKey = await prisma.answerKey.create({
      data: {
        user_id: req.user.userId,
        name: nameResult.name,
        subject: nameResult.subject,
        tasks: tasksResult.tasks,
        total_points: tasksResult.total_points,
        answer_key_groups: {
          create: groupsResult.map((variant, index) => ({
            position: index,
            name: variant.name,
            tasks: variant.tasks,
            total_points: variant.total_points,
          })),
        },
      },
      include: { answer_key_groups: true },
    });

    res.status(201).json({ answer_key: keyPayload(newKey) });
  } catch (error) {
    console.error('Create answer key error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * GET /api/answer-keys/:keyId
 * Pełny klucz z wierszami zadań — potrzebny edytorowi i kreatorowi sprawdzania.
 */
export async function getAnswerKey(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { keyId } = req.params;

    const key = await prisma.answerKey.findFirst({
      where: {
        id: keyId,
        user_id: req.user.userId,
      },
      include: { answer_key_groups: true },
    });

    if (!key) {
      res.status(404).json({ error: 'Answer key not found' });
      return;
    }

    res.json({ answer_key: keyPayload(key) });
  } catch (error) {
    console.error('Get answer key error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * PATCH /api/answer-keys/:keyId
 * Aktualizuje klucz. Sesje sprawdzone wcześniej zachowują swój snapshot, więc zmiana
 * nie przerabia już wystawionych ocen.
 */
export async function updateAnswerKey(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { keyId } = req.params;
    const { name, subject, tasks, groups, total_points } = req.body;

    const existing = await prisma.answerKey.findFirst({
      where: {
        id: keyId,
        user_id: req.user.userId,
      },
      include: { _count: { select: { answer_key_groups: true } } },
    });

    if (!existing) {
      res.status(404).json({ error: 'Answer key not found' });
      return;
    }

    const nameResult = validateNameInput(name, subject);
    if (isProblem(nameResult)) {
      res.status(400).json(nameResult);
      return;
    }

    const groupsResult = normalizeGroupsInput(groups);
    if (isProblem(groupsResult)) {
      res.status(400).json(groupsResult);
      return;
    }

    // Warianty wymieniamy zawsze w całości, więc PATCH bez `groups` przy kluczu z wariantami
    // kasowałby pozostałe warianty po cichu. Nieletni klient musi je dopisać, a nie tracić pracę.
    if (groups === undefined && existing._count.answer_key_groups > 0) {
      res.status(400).json({
        error: 'This answer key has groups; send the complete groups array',
        code: 'ANSWER_KEY_GROUPS_REQUIRED',
      });
      return;
    }

    const tasksResult =
      groupsResult.length > 0
        ? { tasks: groupsResult[0].tasks, total_points: groupsResult[0].total_points }
        : normalizeTasks(tasks);
    if (isProblem(tasksResult)) {
      res.status(400).json(tasksResult);
      return;
    }

    // Klient może podać swoją sumę — jeśli się różni, coś się rozjechało z serwerem.
    // Przy wariantach nie ma czego porównywać: płaskie pola są liczone z wariantu zerowego.
    // Liczbę zaokrąglamy tak samo jak przy normalizacji: suma 0,1+0,1+0,1 w zmiennoprzecinkowym
    // daje 0.30000000000000004 i odrzucenie takiego klucza byłoby karą za binarny zapis, nie za błąd.
    const declaredTotal = typeof total_points === 'number' ? roundPoints(total_points) : total_points;
    if (
      groupsResult.length === 0 &&
      declaredTotal !== undefined &&
      declaredTotal !== tasksResult.total_points
    ) {
      res.status(400).json({
        error: 'total_points does not match the sum of task max_points',
        code: 'ANSWER_KEY_POINTS_MISMATCH',
      });
      return;
    }

    const updated = await prisma.answerKey.update({
      where: { id: keyId },
      data: {
        name: nameResult.name,
        subject: nameResult.subject,
        tasks: tasksResult.tasks,
        total_points: tasksResult.total_points,
        // deleteMany bez warunku + create: jeden zapis, więc klucz nigdy nie zostaje
        // z częścią starych i częścią nowych wariantów.
        answer_key_groups: { deleteMany: {}, create: groupsResult.map((variant, index) => ({
          position: index,
          name: variant.name,
          tasks: variant.tasks,
          total_points: variant.total_points,
        })) },
      },
      include: { answer_key_groups: true },
    });

    res.json({ answer_key: keyPayload(updated) });
  } catch (error) {
    console.error('Update answer key error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

/**
 * DELETE /api/answer-keys/:keyId
 * Usuwa klucz z biblioteki. Sesje zostają (FK SET NULL + snapshot w `answer_key`).
 */
export async function deleteAnswerKey(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { keyId } = req.params;

    const existing = await prisma.answerKey.findFirst({
      where: {
        id: keyId,
        user_id: req.user.userId,
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Answer key not found' });
      return;
    }

    await prisma.answerKey.delete({
      where: { id: keyId },
    });

    res.json({ message: 'Answer key deleted successfully' });
  } catch (error) {
    console.error('Delete answer key error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
}
