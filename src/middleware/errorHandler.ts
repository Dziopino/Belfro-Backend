import { NextFunction, Request, Response } from 'express';
import multer from 'multer';

/**
 * Terminalny przechwytywacz błędów.
 *
 * Bez niego każdy błąd, który nie skończył się w `catch` kontrolera, szedł do przeglądarki
 * domyślną odpowiedzią Expressa: HTML z nazwą modułu i stackiem. Dwie konkretne drogi
 * prowadziły tam często:
 *  1. multer odrzuca plik (`fileFilter` w `config/upload.ts`, limit rozmiaru, nazwa pola inna niż
 *     `image`) — to zdarza się każdemu, kto zamiast zdjęcia wgra PDF albo telefon z fotką 12 Mpx,
 *  2. `throw` synchroniczny w middleware lub w routingu przed kontrolerem.
 * Frontend tłumaczy błędy po `code`, więc odpowiedź bez kodu dawała nauczycielowi ogólnik, a
 * każdemu, kto zajrzał do odpowiedzi serwera, pokazywała strukturę aplikacji.
 *
 * Umowa jest ta sama co w kontrolerach: `error` po angielsku dla programisty, `code` stabilny dla
 * frontendu, zdanie po polsku układa `frontend/src/utils/apiError.ts`.
 */
const REJECTIONS: Record<string, { status: number; message: string }> = {
  UPLOAD_FILE_TYPE_INVALID: {
    status: 400,
    message: 'Unsupported file type. Only JPEG, PNG and HEIC images are accepted.',
  },
  UPLOAD_FILE_TOO_LARGE: {
    status: 413,
    message: 'Uploaded file exceeds the allowed size limit.',
  },
  UPLOAD_FIELD_UNEXPECTED: {
    status: 400,
    message: 'File was submitted under an unexpected form field name.',
  },
  UPLOAD_REJECTED: {
    status: 400,
    message: 'Upload was rejected by the form parser.',
  },
};

/** Kody multer (`LIMIT_*`) na kody aplikacji; reszta idzie przez `UPLOAD_REJECTED`. */
const MULTER_CODES: Partial<Record<multer.MulterError['code'], string>> = {
  LIMIT_FILE_SIZE: 'UPLOAD_FILE_TOO_LARGE',
  LIMIT_UNEXPECTED_FILE: 'UPLOAD_FIELD_UNEXPECTED',
};

function resolveCode(error: unknown): string {
  if (error instanceof multer.MulterError) {
    return MULTER_CODES[error.code] ?? 'UPLOAD_REJECTED';
  }
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'INTERNAL_ERROR';
}

export function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    _next(error);
    return;
  }

  const code = resolveCode(error);
  const rejection = REJECTIONS[code];

  // Treść błędu tylko do konsoli serwera: stack zawiera ścieżki z dysku, a nazwy plików skanów
  // noszą uuid-y uczniów.
  if (rejection) {
    // Odrzucenie wgrania nie jest usterką: `MulterError` niesie jeszcze `filename` i `field`
    // wpisane przez klienta, więc zostawiamy przy nim sam kod i zdanie.
    console.warn(`Wgranie odrzucone (${code}): ${error instanceof Error ? error.message : ''}`);
    res.status(rejection.status).json({ error: rejection.message, code });
    return;
  }

  console.error(`Błąd nierozstrzygnięty przez kontroler (${code}):`, error);

  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL_ERROR' });
}
