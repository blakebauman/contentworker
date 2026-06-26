CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"environment_id" text,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"status" integer NOT NULL,
	"at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_log_by_space" ON "audit_log" USING btree ("space_id","at");