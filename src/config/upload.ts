import multer from 'multer';

// Konfiguracja multer - przechowywanie w pamięci RAM (NIE na dysku!)
// Oryginalny plik nigdy nie jest zapisywany - tylko buffer w RAM
const storage = multer.memoryStorage();

/**
 * Limit rozmiaru jednego skanu. Wyeksportowany, bo ta sama liczba musi występować w zdaniu dla
 * nauczyciela (`frontend/src/utils/apiError.ts`) — wpisana dwa razy w dwóch miejscach rozpędziłaby
 * się przy pierwszej zmianie.
 */
export const MAX_SCAN_BYTES = 10 * 1024 * 1024;

/**
 * Błąd odrzuconego pliku. Niesie stabilny `code`, więc terminalny middleware
 * (`middleware/errorHandler.ts`) nie musi rozgadywać przyczyny po angielskim zdaniu — to był
 * dokładnie ten błąd, przez który frontend tłumaczył błędy raz po kodzie, raz po treści.
 */
class ScanRejectedError extends Error {
  constructor(
    readonly code: 'UPLOAD_FILE_TYPE_INVALID',
    message: string
  ) {
    super(message);
    this.name = 'ScanRejectedError';
  }
}

/**
 * Nagłówek `Content-Type` przychodzi z części multipart, czyli w całości spod ręki klienta.
 * Zostawiamy tylko ASCII bez znaków sterujących, żeby klient nie włożył do loga serwera własnych
 * linii, a razem z nimi fałszywych wpisów.
 */
function printableTypeHint(mimetype: string): string {
  return mimetype.replace(/[^\x20-\x7e]/g, '').slice(0, 64);
}

// Filtr akceptujący tylko obrazy
const fileFilter = (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/heif'];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new ScanRejectedError(
        'UPLOAD_FILE_TYPE_INVALID',
        `Unsupported file type: ${printableTypeHint(file.mimetype)}`
      )
    );
  }
};

// Konfiguracja multer
export const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: MAX_SCAN_BYTES,
  },
});
