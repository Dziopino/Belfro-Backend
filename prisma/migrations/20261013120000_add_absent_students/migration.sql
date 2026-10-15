-- Nieobecności w sesji sprawdzania. Kolumna jest dodatkowa, żadna istniejąca nie znika,
-- a starsze sesje zostają z NULL — dla nich znaczy to tyle co "nikt nie był nieobecny".
ALTER TABLE "grading_sessions" ADD COLUMN IF NOT EXISTS "absent_student_ids" JSONB;
