CREATE TABLE "emergency_login" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "emergency_login_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "emergency_login" ADD CONSTRAINT "emergency_login_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "emergency_login_user_idx" ON "emergency_login" USING btree ("user_id");