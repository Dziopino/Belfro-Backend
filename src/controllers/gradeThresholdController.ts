import { Request, Response } from 'express';
import prisma from '../config/database';

// Alias typu, nie interface: tylko pierwszy dostaje implicytną sygnaturę
// indeksową, więc Prisma przyjmuje go w kolumnie Json bez rzutu.
type GradeEntry = {
  grade: string;
  min_percent: number;
};

/**
 * GET /api/thresholds
 * Pobiera wszystkie skale progów ocen zalogowanego użytkownika
 */
export async function getThresholds(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const thresholds = await prisma.gradeThreshold.findMany({
      where: { user_id: req.user.userId },
      orderBy: { created_at: 'desc' },
    });

    res.json({ thresholds });
  } catch (error) {
    console.error('Błąd pobierania progów ocen:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * POST /api/thresholds
 * Tworzy nową skalę progów ocen
 */
export async function createThreshold(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const { name, thresholds } = req.body;

    // Walidacja name
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName || trimmedName.length < 1 || trimmedName.length > 60) {
      res.status(400).json({
        error: 'Threshold name must be between 1 and 60 characters',
        code: 'THRESHOLD_NAME_INVALID',
      });
      return;
    }

    // Walidacja thresholds
    if (!Array.isArray(thresholds) || thresholds.length < 2 || thresholds.length > 6) {
      res.status(400).json({
        error: 'Thresholds must be an array with 2-6 entries',
        code: 'THRESHOLD_ENTRIES_INVALID',
      });
      return;
    }

    // Walidacja każdego wpisu i normalizacja
    const normalized: GradeEntry[] = [];
    const seenGrades = new Set<string>();
    const seenPercents = new Set<number>();

    for (const entry of thresholds) {
      // Walidacja grade
      const trimmedGrade = typeof entry.grade === 'string' ? entry.grade.trim() : '';
      if (!trimmedGrade || trimmedGrade.length < 1 || trimmedGrade.length > 8) {
        res.status(400).json({
          error: 'Each grade must be a string with 1-8 characters',
          code: 'THRESHOLD_ENTRIES_INVALID',
        });
        return;
      }

      // Walidacja min_percent
      const percent = entry.min_percent;
      if (
        typeof percent !== 'number' ||
        !Number.isInteger(percent) ||
        percent < 0 ||
        percent > 100
      ) {
        res.status(400).json({
          error: 'Each min_percent must be an integer between 0 and 100',
          code: 'THRESHOLD_PERCENT_OUT_OF_RANGE',
        });
        return;
      }

      // Sprawdzenie duplikatów grade
      if (seenGrades.has(trimmedGrade)) {
        res.status(400).json({
          error: 'Duplicate grade values are not allowed',
          code: 'THRESHOLD_DUPLICATE_ENTRY',
        });
        return;
      }
      seenGrades.add(trimmedGrade);

      // Sprawdzenie duplikatów min_percent
      if (seenPercents.has(percent)) {
        res.status(400).json({
          error: 'Duplicate min_percent values are not allowed',
          code: 'THRESHOLD_DUPLICATE_ENTRY',
        });
        return;
      }
      seenPercents.add(percent);

      normalized.push({ grade: trimmedGrade, min_percent: percent });
    }

    // Sortowanie malejąco po min_percent
    normalized.sort((a, b) => b.min_percent - a.min_percent);

    const newThreshold = await prisma.gradeThreshold.create({
      data: {
        user_id: req.user.userId,
        name: trimmedName,
        thresholds: normalized,
      },
    });

    res.status(201).json({ threshold: newThreshold });
  } catch (error) {
    console.error('Błąd tworzenia skali progów:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * PUT /api/thresholds/:thresholdId
 * Aktualizuje skalę progów ocen
 */
export async function updateThreshold(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const { thresholdId } = req.params;
    const { name, thresholds } = req.body;

    // Sprawdzenie własności
    const existing = await prisma.gradeThreshold.findFirst({
      where: {
        id: thresholdId,
        user_id: req.user.userId,
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Threshold not found', code: 'THRESHOLD_NOT_FOUND' });
      return;
    }

    // Walidacja name
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName || trimmedName.length < 1 || trimmedName.length > 60) {
      res.status(400).json({
        error: 'Threshold name must be between 1 and 60 characters',
        code: 'THRESHOLD_NAME_INVALID',
      });
      return;
    }

    // Walidacja thresholds
    if (!Array.isArray(thresholds) || thresholds.length < 2 || thresholds.length > 6) {
      res.status(400).json({
        error: 'Thresholds must be an array with 2-6 entries',
        code: 'THRESHOLD_ENTRIES_INVALID',
      });
      return;
    }

    // Walidacja każdego wpisu i normalizacja
    const normalized: GradeEntry[] = [];
    const seenGrades = new Set<string>();
    const seenPercents = new Set<number>();

    for (const entry of thresholds) {
      // Walidacja grade
      const trimmedGrade = typeof entry.grade === 'string' ? entry.grade.trim() : '';
      if (!trimmedGrade || trimmedGrade.length < 1 || trimmedGrade.length > 8) {
        res.status(400).json({
          error: 'Each grade must be a string with 1-8 characters',
          code: 'THRESHOLD_ENTRIES_INVALID',
        });
        return;
      }

      // Walidacja min_percent
      const percent = entry.min_percent;
      if (
        typeof percent !== 'number' ||
        !Number.isInteger(percent) ||
        percent < 0 ||
        percent > 100
      ) {
        res.status(400).json({
          error: 'Each min_percent must be an integer between 0 and 100',
          code: 'THRESHOLD_PERCENT_OUT_OF_RANGE',
        });
        return;
      }

      // Sprawdzenie duplikatów grade
      if (seenGrades.has(trimmedGrade)) {
        res.status(400).json({
          error: 'Duplicate grade values are not allowed',
          code: 'THRESHOLD_DUPLICATE_ENTRY',
        });
        return;
      }
      seenGrades.add(trimmedGrade);

      // Sprawdzenie duplikatów min_percent
      if (seenPercents.has(percent)) {
        res.status(400).json({
          error: 'Duplicate min_percent values are not allowed',
          code: 'THRESHOLD_DUPLICATE_ENTRY',
        });
        return;
      }
      seenPercents.add(percent);

      normalized.push({ grade: trimmedGrade, min_percent: percent });
    }

    // Sortowanie malejąco po min_percent
    normalized.sort((a, b) => b.min_percent - a.min_percent);

    const updated = await prisma.gradeThreshold.update({
      where: { id: thresholdId },
      data: {
        name: trimmedName,
        thresholds: normalized,
      },
    });

    res.json({ threshold: updated });
  } catch (error) {
    console.error('Błąd zapisu skali progów:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}

/**
 * DELETE /api/thresholds/:thresholdId
 * Usuwa skalę progów ocen
 */
export async function deleteThreshold(req: Request, res: Response): Promise<void> {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
      return;
    }

    const { thresholdId } = req.params;

    // Sprawdzenie własności
    const existing = await prisma.gradeThreshold.findFirst({
      where: {
        id: thresholdId,
        user_id: req.user.userId,
      },
    });

    if (!existing) {
      res.status(404).json({ error: 'Threshold not found', code: 'THRESHOLD_NOT_FOUND' });
      return;
    }

    await prisma.gradeThreshold.delete({
      where: { id: thresholdId },
    });

    res.json({ message: 'Threshold deleted successfully' });
  } catch (error) {
    console.error('Błąd usuwania skali progów:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}
