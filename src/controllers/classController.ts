import { Request, Response } from 'express';
import prisma from '../config/database';
import {
  MAX_ROSTER_SIZE,
  STUDENT_ORDER,
  buildNumberedRoster,
  parseRosterNumber,
  rosterModeFor,
} from '../utils/roster';

/**
 * GET /api/classes
 * Pobiera wszystkie klasy zalogowanego użytkownika
 */
export async function getClasses(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const classes = await prisma.class.findMany({
      where: { user_id: req.user.userId },
      include: {
        students: { orderBy: STUDENT_ORDER },
        _count: {
          select: { students: true },
        },
      },
      orderBy: { created_at: 'desc' },
    });

    res.json({ classes });
  } catch (error) {
    console.error('Błąd pobierania klas:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * POST /api/classes
 * Tworzy nową klasę (z zaszyfrowaną nazwą). Kształt listy uczniów rozstrzyga typ konta:
 * nauczyciel bez umowy ze szkołą dostaje listę numerową, czyli uczniów nr 1..N bez nazwisk.
 */
export async function createClass(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const { encrypted_name, student_count } = req.body;
    const userId = req.user.userId;

    if (!encrypted_name) {
      res.status(400).json({ error: 'Encrypted class name is required', code: 'CLASS_NAME_REQUIRED' });
      return;
    }

    const account = await prisma.user.findUnique({
      where: { id: userId },
      select: { account_kind: true },
    });

    if (!account) {
      res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
      return;
    }

    // Tryb bierze się z konta, nigdy z ciała requestu — patrz utils/roster.
    if (rosterModeFor(account.account_kind) === 'named') {
      if (student_count !== undefined) {
        res.status(400).json({
          error: 'student_count applies only to accounts without a school agreement',
          code: 'STUDENT_COUNT_INVALID',
        });
        return;
      }

      const newClass = await prisma.class.create({
        data: {
          user_id: userId,
          encrypted_name,
          roster_mode: 'named',
        },
        include: {
          students: true,
          _count: {
            select: { students: true },
          },
        },
      });

      res.status(201).json({ class: newClass });
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

    // Klasa i jej lista w jednym przebiegu. Bez transakcji awaria między dwoma zapisami zostałaby
    // klasą zeroosobową, której nauczyciel już nie domyśli i której nie da się rozszerzyć w UI.
    const classId = await prisma.$transaction(async (tx) => {
      const created = await tx.class.create({
        data: {
          user_id: userId,
          encrypted_name,
          roster_mode: 'numbered',
        },
      });

      await tx.student.createMany({ data: buildNumberedRoster(created.id, 1, count) });

      return created.id;
    });

    const newClass = await prisma.class.findUniqueOrThrow({
      where: { id: classId },
      include: {
        students: { orderBy: STUDENT_ORDER },
        _count: {
          select: { students: true },
        },
      },
    });

    res.status(201).json({ class: newClass });
  } catch (error) {
    console.error('Błąd tworzenia klasy:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * GET /api/classes/:classId
 * Pobiera szczegóły pojedynczej klasy wraz z uczniami
 */
export async function getClass(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const { classId } = req.params;

    const classData = await prisma.class.findFirst({
      where: {
        id: classId,
        user_id: req.user.userId, // Tylko własne klasy
      },
      include: {
        students: {
          orderBy: STUDENT_ORDER,
        },
      },
    });

    if (!classData) {
      res.status(404).json({ error: 'Class not found', code: 'CLASS_NOT_FOUND' });
      return;
    }

    res.json({ class: classData });
  } catch (error) {
    console.error('Błąd pobierania klasy:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * DELETE /api/classes/:classId
 * Usuwa klasę (wraz ze wszystkimi uczniami - CASCADE)
 */
export async function deleteClass(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const { classId } = req.params;

    // Sprawdź czy klasa należy do użytkownika
    const classData = await prisma.class.findFirst({
      where: {
        id: classId,
        user_id: req.user.userId,
      },
    });

    if (!classData) {
      res.status(404).json({ error: 'Class not found', code: 'CLASS_NOT_FOUND' });
      return;
    }

    // Usuń klasę (uczniowie zostaną usunięci automatycznie przez CASCADE)
    await prisma.class.delete({
      where: { id: classId },
    });

    res.json({ message: 'Class deleted successfully' });
  } catch (error) {
    console.error('Błąd usuwania klasy:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}
