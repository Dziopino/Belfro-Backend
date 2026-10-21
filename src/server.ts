import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { UPLOADS_ROOT } from './config/paths';
import { errorHandler } from './middleware/errorHandler';
import authRoutes from './routes/auth';
import classRoutes from './routes/classes';
import gradingRoutes from './routes/grading';
import gradeThresholdsRoutes from './routes/gradeThresholds';
import answerKeysRoutes from './routes/answerKeys';
import walletRoutes from './routes/wallet';
import accountRoutes from './routes/account';

// Załaduj zmienne środowiskowe
dotenv.config();

const app: Application = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Statyczne pliki (zanonimizowane obrazy) — ten sam korzeń, do którego zapisuje kontroler
app.use('/uploads', express.static(UPLOADS_ROOT));

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api', classRoutes); // Classes and Students routes
app.use('/api', gradingRoutes); // Grading and AI routes
app.use('/api', gradeThresholdsRoutes); // Grade Thresholds routes
app.use('/api', answerKeysRoutes); // Answer Keys routes
app.use('/api', walletRoutes); // Saldo stron i katalog doładowań
app.use('/api', accountRoutes); // Ustawienia konta: profil i preferencje

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Route not found', code: 'ROUTE_NOT_FOUND' });
});

// Terminalny przechwytywacz błędów — ostatni w łańcuchu, bo Express rozpoznaje go po czterech
// argumentach i odpala tylko wtedy, gdy coś w łańcuchu zawoła `next(error)`.
app.use(errorHandler);

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Serwer działa na porcie ${PORT}`);
  console.log(`📝 Środowisko: ${process.env.NODE_ENV || 'development'}`);
});

export default app;
