-- Rozpoznawanie wariantu arkusza przez AI, zamiast przydziału uczniów do grup.
--
-- Sesja w tym trybie celowo NIE dostaje wierszy w grading_session_groups: nikt nie wie, kto dostał
-- który arkusz, więc nie ma czego zapisać jako członkostwo, a mianownikiem „kto powinien mieć pracę"
-- wraca cała klasa minus nieobecni. Warianty są zamrożone na samej sesji, bo edycja klucza w
-- bibliotece nie może przerobić już sprawdzanych prac.

-- AlterTable
ALTER TABLE "grading_sessions" ADD COLUMN IF NOT EXISTS "group_assignment_mode" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "grading_sessions" ADD COLUMN IF NOT EXISTS "answer_key_variants" JSONB;

-- AlterTable
-- Który wariant realnie poszedł do ocenienia tej pracy i skąd to wiemy ('ai' | 'teacher'). Same UUID i
-- nazwa wariantu — żaden z tych kolumn nie niesie danych osobowych, więc zero-knowledge zostaje nietknięte.
ALTER TABLE "grades" ADD COLUMN IF NOT EXISTS "variant_name" TEXT;
ALTER TABLE "grades" ADD COLUMN IF NOT EXISTS "variant_confidence" INTEGER;
ALTER TABLE "grades" ADD COLUMN IF NOT EXISTS "variant_source" TEXT;
