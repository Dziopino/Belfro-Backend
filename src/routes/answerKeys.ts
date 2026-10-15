import { Router } from 'express';
import {
  getAnswerKeys,
  createAnswerKey,
  getAnswerKey,
  updateAnswerKey,
  deleteAnswerKey,
} from '../controllers/answerKeyController';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Wszystkie endpointy wymagają autentykacji
router.use(authMiddleware);

// GET /api/answer-keys - lista kluczy (bez treści zadań)
router.get('/answer-keys', getAnswerKeys);

// POST /api/answer-keys - tworzenie
router.post('/answer-keys', createAnswerKey);

// GET /api/answer-keys/:keyId - pełny klucz z zadaniami
router.get('/answer-keys/:keyId', getAnswerKey);

// PATCH /api/answer-keys/:keyId - aktualizacja
router.patch('/answer-keys/:keyId', updateAnswerKey);

// DELETE /api/answer-keys/:keyId - usuwanie
router.delete('/answer-keys/:keyId', deleteAnswerKey);

export default router;
