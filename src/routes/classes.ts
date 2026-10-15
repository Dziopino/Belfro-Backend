import { Router } from 'express';
import {
  getClasses,
  createClass,
  getClass,
  deleteClass,
} from '../controllers/classController';
import {
  getStudents,
  createStudent,
  updateStudent,
  deleteStudent,
} from '../controllers/studentController';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Wszystkie endpointy wymagają autentykacji
router.use(authMiddleware);

// ============================================
// Class Routes
// ============================================
router.get('/classes', getClasses);
router.post('/classes', createClass);
router.get('/classes/:classId', getClass);
router.delete('/classes/:classId', deleteClass);

// ============================================
// Student Routes
// ============================================
router.get('/classes/:classId/students', getStudents);
router.post('/classes/:classId/students', createStudent);
router.put('/students/:studentId', updateStudent);
router.delete('/students/:studentId', deleteStudent);

export default router;
