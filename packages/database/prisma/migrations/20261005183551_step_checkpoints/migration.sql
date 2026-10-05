-- AlterTable
ALTER TABLE "WorkflowExecutionStep" ADD COLUMN     "checkpoint" JSONB,
ADD COLUMN     "pollStartedAt" TIMESTAMP(3),
ADD COLUMN     "polls" INTEGER NOT NULL DEFAULT 0;
