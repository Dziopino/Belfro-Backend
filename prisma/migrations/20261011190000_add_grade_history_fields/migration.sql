-- AlterTable
ALTER TABLE "grades" ADD COLUMN     "teacher_response" JSONB,
ADD COLUMN     "model_used" TEXT,
ADD COLUMN     "escalated" BOOLEAN;
