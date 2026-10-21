import { Request, Response } from 'express';
import prisma from '../config/database';
import { MAX_ROSTER_SIZE, STUDENT_ORDER, buildNumberedRoster, parseRosterNumber } from '../utils/roster';
import { uniqueViolationFields } from './authController';

/**
 * Klasa należąca do tego nauczyciela, razem z trybem jej listy uczniów. Własność sprawdzamy przed
 * każdym zapisem, a tryb czytamy z rekordu klasy — nigdy z requestu. To on rozstrzyga, czy wolno
 * nam przyjąć imię i nazwisko, a klient nie ma prawa tego ustawienia przestawiać.
 */
async function findOwnedClass(classId: string, userId: string) {
  return prisma.class.findFirst({
    where: { id: classId, user_id: userId },
    select: { id: true, roster_mode: true },
  });
}

/**
 * Jedyna odpowiedź dla klienta, który wcisnął nazwisko do klasy numerowanej. To nie jest defensywa
 * na wypadek ataku: cała zmiana po to właśnie istnieje, żeby u nauczyciela bez umowy ze szkołą
 * nazwisko nie leżało w bazie nawet zaszyfrowane. Wolimy głośny 400 po dev stronie zamiast
 * cichego odrzucenia pola, którego nikt potem nie znajdzie w logach.
 */
function rejectNamedFields(res: Response): void {
  res.status(400).json({
    error: 'Students in a numbered class are identified by journal number only',
    code: 'STUDENT_NAMED_FIELDS_FORBIDDEN',
  });
}

/**
 * GET /api/classes/:classId/students
 * Pobiera wszystkich uczniów z klasy
 */
export async function getStudents(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const { classId } = req.params;

    // Sprawdź czy klasa należy do użytkownika
    const classData = await findOwnedClass(classId, req.user.userId);

    if (!classData) {
      res.status(404).json({ error: 'Class not found', code: 'CLASS_NOT_FOUND' });
      return;
    }

    const students = await prisma.student.findMany({
      where: { class_id: classId },
      orderBy: STUDENT_ORDER,
    });

    res.json({ students });
  } catch (error) {
    console.error('Błąd pobierania uczniów:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * POST /api/classes/:classId/students
 * Dodaje nowego ucznia do klasy — z zaszyfrowanymi danymi albo tylko z numerem, zależnie od
 * trybu, w jakim klasa została założona.
 */
export async function createStudent(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const { classId } = req.params;
    const { encrypted_first_name, encrypted_last_name, encrypted_number, journal_number } = req.body;

    // Sprawdź czy klasa należy do użytkownika
    const classData = await findOwnedClass(classId, req.user.userId);

    if (!classData) {
      res.status(404).json({ error: 'Class not found', code: 'CLASS_NOT_FOUND' });
      return;
    }

    if (classData.roster_mode === 'numbered') {
      if (encrypted_first_name || encrypted_last_name || encrypted_number) {
        rejectNamedFields(res);
        return;
      }

      const number = parseRosterNumber(journal_number);
      if (number === null) {
        res.status(400).json({
          error: `journal_number must be an integer between 1 and ${MAX_ROSTER_SIZE}`,
          code: 'STUDENT_NUMBER_REQUIRED',
        });
        return;
      }

      try {
        const student = await prisma.student.create({
          data: { class_id: classId, journal_number: number },
        });

        res.status(201).json({ student });
      } catch (createError) {
        // Dwa zapisy tego samego numeru w tym samym ułamku sekundy: indeks unikalności jest
        // jedyną rzeczą, która tego nie przepuści, więc musi zamienić się w czytelny 400.
        if (uniqueViolationFields(createError).includes('journal_number')) {
          res.status(400).json({
            error: 'Journal number is already taken in this class',
            code: 'STUDENT_NUMBER_TAKEN',
          });
          return;
        }
        throw createError;
      }
      return;
    }

    // Walidacja
    if (!encrypted_first_name || !encrypted_last_name || !encrypted_number) {
      res.status(400).json({ error: 'All encrypted fields are required', code: 'STUDENT_FIELDS_REQUIRED' });
      return;
    }

    // Pola journal_number tu nie zapisujemy nawet gdyby klient je przysłał: w klasie z nazwiskami
    // numer i tak leży w encrypted_number, a dwa jego obrazy tylko się rozjechałyby.
    const student = await prisma.student.create({
      data: {
        class_id: classId,
        encrypted_first_name,
        encrypted_last_name,
        encrypted_number,
      },
    });

    res.status(201).json({ student });
  } catch (error) {
    console.error('Błąd dodawania ucznia:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * POST /api/classes/:classId/students/append
 * Dokłada uczniów do klasy numerowanej: numery zaczynają się za największym zajętym, więc klasa,
 * do której w połowie roku doszło dziecko, nie musi być zakładana od nowa. W klasie z nazwiskami
 * nie ma czego dokładać — tam każdy uczeń ma własny formularz z imieniem i nazwiskiem.
 */
export async function appendStudents(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const { classId } = req.params;
    const { student_count } = req.body ?? {};

    const classData = await findOwnedClass(classId, req.user.userId);

    if (!classData) {
      res.status(404).json({ error: 'Class not found', code: 'CLASS_NOT_FOUND' });
      return;
    }

    if (classData.roster_mode !== 'numbered') {
      res.status(400).json({
        error: 'Bulk append is available only for numbered classes',
        code: 'STUDENT_APPEND_NOT_NUMBERED',
      });
      return;
    }

    const count = parseRosterNumber(student_count);
    if (count === null) {
      res.status(400).json({
        error: `student_count must be an integer between 1 and ${MAX_ROSTER_SIZE}`,
        code: 'STUDENT_COUNT_INVALID',
      });
      return;
    }

    const lastTaken = await prisma.student.findFirst({
      where: { class_id: classId },
      orderBy: { journal_number: 'desc' },
      select: { journal_number: true },
    });

    const from = (lastTaken?.journal_number ?? 0) + 1;

    if (from + count - 1 > MAX_ROSTER_SIZE) {
      res.status(400).json({
        error: `A class cannot exceed ${MAX_ROSTER_SIZE} students; the first free number is ${from}`,
        code: 'STUDENT_COUNT_INVALID',
      });
      return;
    }

    await prisma.student.createMany({ data: buildNumberedRoster(classId, from, count) });

    const students = await prisma.student.findMany({
      where: { class_id: classId, journal_number: { gte: from, lte: from + count - 1 } },
      orderBy: STUDENT_ORDER,
    });

    res.status(201).json({ students });
  } catch (error) {
    console.error('Błąd dokłaniania uczniów:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * PUT /api/students/:studentId
 * Aktualizuje dane ucznia — zaszyfrowane albo numer, zależnie od trybu klasy
 */
export async function updateStudent(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const { studentId } = req.params;
    const { encrypted_first_name, encrypted_last_name, encrypted_number, journal_number } = req.body;

    // Sprawdź czy uczeń należy do klasy użytkownika
    const student = await prisma.student.findFirst({
      where: { id: studentId },
      include: {
        class: true,
      },
    });

    if (!student || student.class.user_id !== req.user.userId) {
      res.status(404).json({ error: 'Student not found', code: 'STUDENT_NOT_FOUND' });
      return;
    }

    if (student.class.roster_mode === 'numbered') {
      if (encrypted_first_name || encrypted_last_name || encrypted_number) {
        rejectNamedFields(res);
        return;
      }

      const number = parseRosterNumber(journal_number);
      if (number === null) {
        res.status(400).json({
          error: `journal_number must be an integer between 1 and ${MAX_ROSTER_SIZE}`,
          code: 'STUDENT_NUMBER_REQUIRED',
        });
        return;
      }

      try {
        const updatedStudent = await prisma.student.update({
          where: { id: studentId },
          data: { journal_number: number },
        });

        res.json({ student: updatedStudent });
      } catch (updateError) {
        if (uniqueViolationFields(updateError).includes('journal_number')) {
          res.status(400).json({
            error: 'Journal number is already taken in this class',
            code: 'STUDENT_NUMBER_TAKEN',
          });
          return;
        }
        throw updateError;
      }
      return;
    }

    const updatedStudent = await prisma.student.update({
      where: { id: studentId },
      data: {
        encrypted_first_name: encrypted_first_name || student.encrypted_first_name,
        encrypted_last_name: encrypted_last_name || student.encrypted_last_name,
        encrypted_number: encrypted_number || student.encrypted_number,
      },
    });

    res.json({ student: updatedStudent });
  } catch (error) {
    console.error('Błąd aktualizacji ucznia:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * DELETE /api/students/:studentId
 * Usuwa ucznia
 */
export async function deleteStudent(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const { studentId } = req.params;

    // Sprawdź czy uczeń należy do klasy użytkownika
    const student = await prisma.student.findFirst({
      where: { id: studentId },
      include: {
        class: true,
      },
    });

    if (!student || student.class.user_id !== req.user.userId) {
      res.status(404).json({ error: 'Student not found', code: 'STUDENT_NOT_FOUND' });
      return;
    }

    await prisma.student.delete({
      where: { id: studentId },
    });

    res.json({ message: 'Student deleted successfully' });
  } catch (error) {
    console.error('Błąd usuwania ucznia:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}
