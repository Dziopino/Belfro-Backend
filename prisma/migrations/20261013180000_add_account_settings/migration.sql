-- Ustawienia konta (strona „Ustawienia konta", PATCH /api/account).
-- Same kolumny dodatkowe: żadna istniejąca nie znika, a konta założone przed tą zmianą
-- dostają wartości domyślne — puste imię (nagłówek dalej pokazuje email) i próg alertu 50 stron.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "display_name" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "low_balance_alert_threshold" INTEGER NOT NULL DEFAULT 50;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "default_grade_threshold_id" TEXT;

CREATE INDEX IF NOT EXISTS "users_default_grade_threshold_id_idx" ON "users"("default_grade_threshold_id");

-- SetNull, żeby skasowanie skali ocen nie kasowało konta i nie zostawiało wiszącego wskazania:
-- wybór w kreatorze po prostu wraca do „bez progów ocen".
ALTER TABLE "users"
  ADD CONSTRAINT "users_default_grade_threshold_id_fkey"
  FOREIGN KEY ("default_grade_threshold_id") REFERENCES "grade_thresholds"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
