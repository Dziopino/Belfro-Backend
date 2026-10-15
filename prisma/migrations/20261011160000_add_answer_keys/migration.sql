-- AlterTable
ALTER TABLE "grading_sessions" ADD COLUMN     "answer_key_id" TEXT;

-- CreateTable
CREATE TABLE "answer_keys" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT,
    "tasks" JSONB NOT NULL,
    "total_points" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "answer_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "answer_keys_user_id_idx" ON "answer_keys"("user_id");

-- CreateIndex
CREATE INDEX "grading_sessions_answer_key_id_idx" ON "grading_sessions"("answer_key_id");

-- AddForeignKey
ALTER TABLE "grading_sessions" ADD CONSTRAINT "grading_sessions_answer_key_id_fkey" FOREIGN KEY ("answer_key_id") REFERENCES "answer_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "answer_keys" ADD CONSTRAINT "answer_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
