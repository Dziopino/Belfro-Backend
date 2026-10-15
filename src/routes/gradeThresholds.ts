import { Router } from 'express';
import {
  getThresholds,
  createThreshold,
  updateThreshold,
  deleteThreshold,
} from '../controllers/gradeThresholdController';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Wszystkie endpointy wymagają autentykacji
router.use(authMiddleware);

// GET /api/thresholds - lista skal
router.get('/thresholds', getThresholds);

// POST /api/thresholds - tworzenie
router.post('/thresholds', createThreshold);

// PUT /api/thresholds/:thresholdId - aktualizacja
router.put('/thresholds/:thresholdId', updateThreshold);

// DELETE /api/thresholds/:thresholdId - usuwanie
router.delete('/thresholds/:thresholdId', deleteThreshold);

export default router;
