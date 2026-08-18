ALTER TYPE "public"."task_status" ADD VALUE 'descartado';--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "supersedes_id" uuid;--> statement-breakpoint
ALTER TABLE "task" ADD COLUMN "superseded_by_id" uuid;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_supersedes_id_task_id_fk" FOREIGN KEY ("supersedes_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_superseded_by_id_task_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."task"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "task_supersedes_idx" ON "task" USING btree ("supersedes_id");--> statement-breakpoint
CREATE INDEX "task_superseded_by_idx" ON "task" USING btree ("superseded_by_id");