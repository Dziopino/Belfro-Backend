-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "encryption_salt" TEXT NOT NULL,
    "pages_current_limit" INTEGER NOT NULL DEFAULT 350,
    "pages_total_processed" INTEGER NOT NULL DEFAULT 0,
    "subscription_tier" TEXT NOT NULL DEFAULT 'free',
    "subscription_ends_at" TIMESTAMP(3),
    "reset_token" TEXT,
    "reset_token_expires" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "classes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "encrypted_name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "students" (
    "id" TEXT NOT NULL,
    "class_id" TEXT NOT NULL,
    "encrypted_first_name" TEXT NOT NULL,
    "encrypted_last_name" TEXT NOT NULL,
    "encrypted_number" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grading_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "class_id" TEXT NOT NULL,
    "answer_key" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grading_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "grades" (
    "id" TEXT NOT NULL,
    "grading_session_id" TEXT NOT NULL,
    "student_id" TEXT NOT NULL,
    "image_path" TEXT NOT NULL,
    "ai_response" JSONB NOT NULL,
    "confidence_score" DOUBLE PRECISION NOT NULL,
    "manually_verified" BOOLEAN NOT NULL DEFAULT false,
    "final_points" DOUBLE PRECISION,
    "teacher_notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "grades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_reset_token_key" ON "users"("reset_token");

-- CreateIndex
CREATE INDEX "classes_user_id_idx" ON "classes"("user_id");

-- CreateIndex
CREATE INDEX "students_class_id_idx" ON "students"("class_id");

-- CreateIndex
CREATE INDEX "grading_sessions_user_id_idx" ON "grading_sessions"("user_id");

-- CreateIndex
CREATE INDEX "grading_sessions_class_id_idx" ON "grading_sessions"("class_id");

-- CreateIndex
CREATE INDEX "grades_grading_session_id_idx" ON "grades"("grading_session_id");

-- CreateIndex
CREATE INDEX "grades_student_id_idx" ON "grades"("student_id");

-- AddForeignKey
ALTER TABLE "classes" ADD CONSTRAINT "classes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grading_sessions" ADD CONSTRAINT "grading_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grading_sessions" ADD CONSTRAINT "grading_sessions_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grades" ADD CONSTRAINT "grades_grading_session_id_fkey" FOREIGN KEY ("grading_session_id") REFERENCES "grading_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grades" ADD CONSTRAINT "grades_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
