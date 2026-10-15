-- AlterTable
ALTER TABLE "grading_sessions" ADD COLUMN     "name" TEXT;

-- CreateIndex
CREATE INDEX "grading_sessions_user_id_name_idx" ON "grading_sessions"("user_id", "name");
