-- Grupy wewnątrz jednej sesji (warianty A, B, C). Tabela jest zamrożoną kopią podziału klasy,
-- więc nie ma tu klucza do "classes" ani do "students" — zmiana składu klasy po sprawdzaniu
-- nie może ruszyć już ocenionych prac.

-- CreateTable
CREATE TABLE "grading_session_groups" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "answer_key" JSONB NOT NULL,
    "answer_key_id" TEXT,
    "student_ids" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grading_session_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "grading_session_groups_session_id_idx" ON "grading_session_groups"("session_id");

-- CreateIndex
CREATE INDEX "grading_session_groups_session_id_position_idx" ON "grading_session_groups"("session_id", "position");

-- CreateIndex
CREATE INDEX "grading_session_groups_answer_key_id_idx" ON "grading_session_groups"("answer_key_id");

-- AddForeignKey
ALTER TABLE "grading_session_groups" ADD CONSTRAINT "grading_session_groups_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "grading_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grading_session_groups" ADD CONSTRAINT "grading_session_groups_answer_key_id_fkey" FOREIGN KEY ("answer_key_id") REFERENCES "answer_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;
