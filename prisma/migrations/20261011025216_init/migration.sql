-- AlterTable
ALTER TABLE "grading_sessions" ADD COLUMN     "grade_threshold_id" TEXT;

-- CreateTable
CREATE TABLE "grade_thresholds" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "thresholds" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grade_thresholds_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "grade_thresholds_user_id_idx" ON "grade_thresholds"("user_id");

-- CreateIndex
CREATE INDEX "grading_sessions_grade_threshold_id_idx" ON "grading_sessions"("grade_threshold_id");

-- AddForeignKey
ALTER TABLE "grading_sessions" ADD CONSTRAINT "grading_sessions_grade_threshold_id_fkey" FOREIGN KEY ("grade_threshold_id") REFERENCES "grade_thresholds"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grade_thresholds" ADD CONSTRAINT "grade_thresholds_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
