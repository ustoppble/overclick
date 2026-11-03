CREATE INDEX "task_updated_at_idx" ON "task" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "task_comment_task_idx" ON "task_comment" USING btree ("task_id");