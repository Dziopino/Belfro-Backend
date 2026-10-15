-- Weryfikacja adresu email. Kolumny są dodatkowe, żadna istniejąca nie znika.
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "verification_token" TEXT;
ALTER TABLE "users" ADD COLUMN "verification_token_expires" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "verification_sent_at" TIMESTAMP(3);

-- Istniejące konta nie mogą zostać przed drzwiami: link nigdy im nie przysługiwał,
-- a ponowne wysłanie wymaga hasła, którego organizacyjnie nie mamy.
UPDATE "users" SET "email_verified_at" = CURRENT_TIMESTAMP WHERE "email_verified_at" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "users_verification_token_key" ON "users"("verification_token");
