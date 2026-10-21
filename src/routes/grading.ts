import { Router } from 'express';
import {
  createGradingSession,
  updateGradingSession,
  deleteGradingSession,
  uploadAndAnonymizeImage,
  processSessionWithAI,
  getGradingSession,
  getGradingSessionProgress,
  getGradingSessions,
  updateGrade,
} from '../controllers/gradingController';
import { authMiddleware } from '../middleware/auth';
import { upload } from '../config/upload';

const router = Router();

// Wszystkie endpointy wymagają autentykacji
router.use(authMiddleware);

// ============================================
// Grading Session Routes
// ============================================

// Tworzenie nowej sesji sprawdzania
router.post('/grading/sessions', createGradingSession);

// Lista sesji do historii sprawdzania prac
router.get('/grading/sessions', getGradingSessions);

// Pobieranie szczegółów sesji
router.get('/grading/sessions/:sessionId', getGradingSession);

// Licznik sprawdzonych prac — karmi pasek postępu, bez przenoszenia ai_response
router.get('/grading/sessions/:sessionId/progress', getGradingSessionProgress);

// Po utworzeniu sesji nauczyciel zmienia dwie rzeczy: listę nieobecnych i przydział uczniów do grup
router.patch('/grading/sessions/:sessionId', updateGradingSession);

// Bezpowrotne usunięcie sesji wraz z ocenami i skanami
router.delete('/grading/sessions/:sessionId', deleteGradingSession);

// Przetwarzanie sesji przez AI
router.post('/grading/sessions/:sessionId/process', processSessionWithAI);

// Ręczne poprawki nauczyciela do oceny pracy
router.patch('/grading/sessions/:sessionId/grades/:gradeId', updateGrade);

// ============================================
// Image Upload & Anonymization
// ============================================

// Upload i anonimizacja obrazu (multer.single('image') = jedno zdjęcie)
router.post('/grading/upload', upload.single('image'), uploadAndAnonymizeImage);

export default router;
