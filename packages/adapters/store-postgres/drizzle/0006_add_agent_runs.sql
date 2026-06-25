CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"workflow" text NOT NULL,
	"entry_id" text NOT NULL,
	"status" text NOT NULL,
	"decisions" jsonb NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_runs_by_space" ON "agent_runs" USING btree ("space_id","created_at");