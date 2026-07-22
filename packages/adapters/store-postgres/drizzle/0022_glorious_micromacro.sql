CREATE TABLE "agent_schedules" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"id" text NOT NULL,
	"workflow" text NOT NULL,
	"content_type_api_id" text,
	"cron" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"auto_apply" boolean DEFAULT false NOT NULL,
	"last_run_at" timestamp with time zone,
	"cursor_entry_id" text,
	"next_run_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "agent_schedules_space_id_environment_id_id_pk" PRIMARY KEY("space_id","environment_id","id")
);
--> statement-breakpoint
CREATE INDEX "agent_schedules_due" ON "agent_schedules" USING btree ("enabled","next_run_at");