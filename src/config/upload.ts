import multer from 'multer';

// Konfiguracja multer - przechowywanie w pamięci RAM (NIE na dysku!)
// Oryginalny plik nigdy nie jest zapisywany - tylko buffer w RAM
const storage = multer.memoryStorage();

// Filtr akceptujący tylko obrazy
const fileFilter = (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
  const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/heif'];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only JPEG, PNG, and HEIC images are allowed.'));
  }
};

// Konfiguracja multer
export const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: 10 * 1024 * 1024, // Maksymalnie 10MB na plik
  },
});
