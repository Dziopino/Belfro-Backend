import path from 'path';

// Dwa poziomy w górę od tego modułu (src/config lub dist/config) — korzeń backendu niezależny od katalogu startowego
export const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

// Korzeń katalogu serwowany pod `/uploads` — ten sam, do którego zapisuje kontroler
export const UPLOADS_ROOT = path.join(BACKEND_ROOT, 'uploads');

export const ANONYMIZED_DIR = path.join(UPLOADS_ROOT, 'anonymized');

// Kolumna `grades.image_path` trzyma ścieżkę względną właśnie w tej formie
const UPLOAD_PREFIX = 'uploads/';

// `image_path` z bazy na ścieżkę dyskową; kontrola przynależności odcina wszelkie `..`
export function absoluteUploadPath(storedPath: string): string {
  if (!storedPath.startsWith(UPLOAD_PREFIX)) {
    throw new Error(`Unexpected stored upload path: ${storedPath}`);
  }

  const absolute = path.resolve(UPLOADS_ROOT, storedPath.slice(UPLOAD_PREFIX.length));

  if (absolute !== UPLOADS_ROOT && !absolute.startsWith(UPLOADS_ROOT + path.sep)) {
    throw new Error('Stored upload path escapes the uploads directory');
  }

  return absolute;
}
