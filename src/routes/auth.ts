import { Router } from 'express';
import {
  register,
  login,
  forgotPassword,
  resetPassword,
  verifyEmail,
  resendVerification,
  getCurrentUser,
  sendSmsCode,
  verifySmsCode,
  captchaConfig,
} from '../controllers/authController';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Publiczne endpointy (bez JWT)
router.get('/captcha-config', captchaConfig);
router.post('/register', register);
router.post('/login', login);
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);
router.post('/verify-email', verifyEmail);
router.post('/resend-verification', resendVerification);

// Chronione endpointy (wymagają JWT)
router.get('/me', authMiddleware, getCurrentUser);

// Weryfikacja numeru telefonu. Numery nie pochodzą z body, tylko z rekordu za tokenem,
// więc te trasy nie potrafią wysłać kodu na adres wskazany przez wołającego.
router.post('/send-sms-code', authMiddleware, sendSmsCode);
router.post('/verify-sms-code', authMiddleware, verifySmsCode);

export default router;
