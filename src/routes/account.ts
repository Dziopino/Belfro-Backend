import { Router } from 'express';
import { updateAccount } from '../controllers/accountController';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Wszystkie endpointy wymagają autentykacji
router.use(authMiddleware);

// PATCH /api/account - zapisz profil i preferencje
router.patch('/account', updateAccount);

export default router;
