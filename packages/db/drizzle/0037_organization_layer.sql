CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"context" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_workspace_name" UNIQUE("workspace_id","name")
);
--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- OCL-139: every existing workspace gets one organization so the columns below
-- can be backfilled and then made NOT NULL. A board that never sorted its
-- projects by business has exactly one business until its owner says otherwise.
INSERT INTO "organization" ("workspace_id", "name", "context")
SELECT "id", 'General', NULL FROM "workspace";--> statement-breakpoint

ALTER TABLE "mission" ADD COLUMN "organization_id" uuid;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "organization_id" uuid;--> statement-breakpoint

UPDATE "mission" m
SET "organization_id" = o."id"
FROM "organization" o
WHERE o."workspace_id" = m."workspace_id" AND o."name" = 'General';--> statement-breakpoint

UPDATE "project" p
SET "organization_id" = o."id"
FROM "organization" o
WHERE o."workspace_id" = p."workspace_id" AND o."name" = 'General';--> statement-breakpoint

ALTER TABLE "mission" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mission" ADD CONSTRAINT "mission_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE restrict ON UPDATE no action;
