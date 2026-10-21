-- Dwa rodzaje konta: nauczyciel prywatny (tylko numer z dziennika) i szkoła (umowa na dane osobowe).
-- Zmiana tylko dopisuje kolumny i indeks. Żadna istniejąca kolumna nie znika, żaden wiersz nie jest
-- nadpisywany — klasy i uczniowie założeni przed nią zostają dokładnie tacy, jacy byli.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "account_kind" TEXT NOT NULL DEFAULT 'school';

ALTER TABLE "classes" ADD COLUMN IF NOT EXISTS "roster_mode" TEXT NOT NULL DEFAULT 'named';

-- Lista numerowa nie trzyma nazwisk wcale, a lista z nazwiskami nie trzyma numeru jawnego.
-- DROP NOT NULL niczego nie usuwa: dotyczy wyłącznie wierszy teraz tworzonych.
ALTER TABLE "students" ALTER COLUMN "encrypted_first_name" DROP NOT NULL;
ALTER TABLE "students" ALTER COLUMN "encrypted_last_name" DROP NOT NULL;
ALTER TABLE "students" ALTER COLUMN "encrypted_number" DROP NOT NULL;

ALTER TABLE "students" ADD COLUMN IF NOT EXISTS "journal_number" INTEGER;

-- Ten sam numer u dwóch uczniów tej samej klasy to pomyłka, a w trybie numerowym nie ma nazwiska,
-- które by ich rozstrzygnęło. W Postgres wiele NULL-i nie kolizjonuje, więc wiersze z nazwiskami
-- (journal_number IS NULL) ten indeks w ogóle nie obowiązuje.
CREATE UNIQUE INDEX IF NOT EXISTS "students_class_id_journal_number_key"
    ON "students"("class_id", "journal_number");
