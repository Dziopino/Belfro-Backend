-- Weryfikacja numeru telefonu. Kolumny są dodatkowe, żadna istniejąca nie znika.
ALTER TABLE "users" ADD COLUMN "phone" TEXT;
ALTER TABLE "users" ADD COLUMN "is_phone_verified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "users" ADD COLUMN "sms_code" TEXT;
ALTER TABLE "users" ADD COLUMN "sms_code_expires" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "sms_code_sent_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "sms_code_attempts" INTEGER NOT NULL DEFAULT 0;

-- Istniejący nauczyciele nie mogą zostać przed drzwiami: bramka ma chronić przed mnożeniem
-- darmowych kont, a nie przed pracą ludzi, którzy konto już mają i numeru nigdy nie podawali.
UPDATE "users" SET "is_phone_verified" = true WHERE "is_phone_verified" = false;

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");
