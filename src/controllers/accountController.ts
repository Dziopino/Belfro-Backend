import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { CLIENT_USER_SELECT, withMaskedPhone } from './authController';

// Te same limity co nazwy skali ocen — nauczyciel widzi jedną regułę, nie trzy.
const DISPLAY_NAME_MAX_LENGTH = 60;
const LOW_BALANCE_MAX = 100000;

// Tryb przydzielania uczniów do grup. 'ai' jest przyjęte i zapisane, choć ekran jeszcze go nie
// realizuje — wybór musi przetrwać, żeby dopracowanie ręcznego trybu nie kasowało ustawienia konta.
const GROUP_ASSIGNMENT_MODES = ['manual', 'ai'] as const;

/**
 * PATCH /api/account
 * Ustawienia ze strony „Ustawienia konta". Zmieniamy wyłącznie te pola, które przyszły w ciele
 * requestu — nieobecne zostają nietknięte, więc dwa zapisy z różnych kart nie nadpisują się nawzajem.
 * `null` jawnie kasuje ustawienie (puste imię, brak domyślnej skali).
 */
export async function updateAccount(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    return;
  }

  try {
    const { display_name, default_grade_threshold_id, low_balance_alert_threshold, group_assignment_mode } =
      req.body ?? {};
    const data: Prisma.UserUpdateInput = {};

    if (display_name !== undefined) {
      if (display_name === null) {
        data.display_name = null;
      } else if (typeof display_name !== 'string' || display_name.length > DISPLAY_NAME_MAX_LENGTH) {
        res.status(400).json({
          error: `Display name must be a string of at most ${DISPLAY_NAME_MAX_LENGTH} characters`,
          code: 'DISPLAY_NAME_INVALID',
        });
        return;
      } else {
        const trimmed = display_name.trim();
        data.display_name = trimmed.length > 0 ? trimmed : null;
      }
    }

    if (default_grade_threshold_id !== undefined) {
      if (default_grade_threshold_id === null) {
        data.default_grade_threshold = { disconnect: true };
      } else if (typeof default_grade_threshold_id !== 'string') {
        res.status(400).json({ error: 'Threshold id must be a string', code: 'THRESHOLD_NOT_FOUND' });
        return;
      } else {
        // Własność sprawdzana przed zapisem: cudzy id to błąd klienta, nie informacja do wycieku.
        const owned = await prisma.gradeThreshold.findFirst({
          where: { id: default_grade_threshold_id, user_id: req.user.userId },
          select: { id: true },
        });

        if (!owned) {
          res.status(400).json({ error: 'Threshold not found', code: 'THRESHOLD_NOT_FOUND' });
          return;
        }

        data.default_grade_threshold = { connect: { id: owned.id } };
      }
    }

    if (low_balance_alert_threshold !== undefined) {
      const threshold = low_balance_alert_threshold;
      if (
        typeof threshold !== 'number' ||
        !Number.isInteger(threshold) ||
        threshold < 0 ||
        threshold > LOW_BALANCE_MAX
      ) {
        res.status(400).json({
          error: `Low balance threshold must be an integer between 0 and ${LOW_BALANCE_MAX}`,
          code: 'LOW_BALANCE_THRESHOLD_INVALID',
        });
        return;
      }

      data.low_balance_alert_threshold = threshold;
    }

    if (group_assignment_mode !== undefined) {
      // Kolumna jest NOT NULL, więc „wyczyść ustawienie" oznacza powrót do domyślnego trybu.
      if (group_assignment_mode === null) {
        data.group_assignment_mode = 'manual';
      } else if (
        typeof group_assignment_mode !== 'string' ||
        !GROUP_ASSIGNMENT_MODES.includes(group_assignment_mode as (typeof GROUP_ASSIGNMENT_MODES)[number])
      ) {
        res.status(400).json({
          error: `Group assignment mode must be one of: ${GROUP_ASSIGNMENT_MODES.join(', ')}`,
          code: 'GROUP_ASSIGNMENT_MODE_INVALID',
        });
        return;
      } else {
        data.group_assignment_mode = group_assignment_mode;
      }
    }

    if (Object.keys(data).length === 0) {
      // Nic nie przyszło — odpowiadamy aktualnym stanem zamiast wykonywać pusty zapis.
      const current = await prisma.user.findUnique({
        where: { id: req.user.userId },
        select: CLIENT_USER_SELECT,
      });

      if (!current) {
        res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
        return;
      }

      res.json({ user: withMaskedPhone(current) });
      return;
    }

    const updated = await prisma.user.update({
      where: { id: req.user.userId },
      data,
      select: CLIENT_USER_SELECT,
    });

    res.json({ user: withMaskedPhone(updated) });
  } catch (error) {
    console.error('Błąd aktualizacji konta:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}
