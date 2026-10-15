-- Warianty zadań wewnątrz klucza odpowiedzi („Grupa A", „Grupa B"). Tabela jest dodatkowa:
-- żaden klucz z biblioteki jej nie ma, a odczyty, które nie wiedzą o grupach, czytają
-- answer_keys.tasks dalej — tam od teraz trzymamy wariant zerowy.

-- CreateTable
CREATE TABLE "answer_key_groups" (
    "id" TEXT NOT NULL,
    "answer_key_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "tasks" JSONB NOT NULL,
    "total_points" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "answer_key_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "answer_key_groups_answer_key_id_idx" ON "answer_key_groups"("answer_key_id");

-- CreateIndex
CREATE INDEX "answer_key_groups_answer_key_id_position_idx" ON "answer_key_groups"("answer_key_id", "position");

-- AddForeignKey
-- Cascade: usunięcie klucza z biblioteki nie może zostawić wariantów bez właściciela.
ALTER TABLE "answer_key_groups" ADD CONSTRAINT "answer_key_groups_answer_key_id_fkey" FOREIGN KEY ("answer_key_id") REFERENCES "answer_keys"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Preferencja konta: czy uczniów do grup przypina nauczyciel, czy (docelowo) AI.
-- Domyślnie 'manual' — konta założone przed tą zmianą dostają dokładnie ten ekran, który znają.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "group_assignment_mode" TEXT NOT NULL DEFAULT 'manual';
