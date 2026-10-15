import { Router } from 'express';
import { getWallet } from '../controllers/walletController';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Wszystkie endpointy wymagają autentykacji
router.use(authMiddleware);

// GET /api/wallet - saldo stron + katalog doładowań
router.get('/wallet', getWallet);

export default router;
