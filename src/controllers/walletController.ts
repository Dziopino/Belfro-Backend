import { Request, Response } from 'express';
import prisma from '../config/database';
import { CURRENCY, MONTHLY_PLANS, PAGE_PACKS } from '../config/pricing';

/**
 * Saldo konta i cały cennik w jednej odpowiedzi. Ceny mieszkają w config/pricing.ts
 * i wychodzą stąd, więc nie trafiają do bundla Reacta — zmianę cennika widać bez przebudowy frontu.
 *
 * Dwie rodziny ofert: `packs` to doładowanie jednorazowe (strony bez daty ważności), `plans` to
 * abonament miesięczny (~25-30% taniej za stronę, ale niewykorzystane strony przepadają z okresem).
 *
 * Saldem jest `pages_current_limit`: strony naliczone przy rejestracji i przy każdym doładowaniu
 * znikają po jednej za sprawdzoną pracę i nigdy nie przepadają z upływem czasu.
 */
export async function getWallet(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    return;
  }

  try {
    const account = await prisma.user.findUnique({
      where: { id: req.user.userId },
      select: { pages_current_limit: true, pages_total_processed: true },
    });

    if (!account) {
      res.status(404).json({ error: 'User not found', code: 'USER_NOT_FOUND' });
      return;
    }

    res.json({
      pages_balance: account.pages_current_limit,
      pages_used_total: account.pages_total_processed,
      currency: CURRENCY,
      // Płatności dokleimy w następnym kroku; dopóki ich nie ma, frontend oznacza zakupy jako niedostępne.
      payments_enabled: process.env.PAYMENTS_ENABLED === 'true',
      packs: PAGE_PACKS,
      plans: MONTHLY_PLANS,
    });
  } catch (error) {
    console.error('Błąd pobierania salda stron:', error);
    res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
  }
}
