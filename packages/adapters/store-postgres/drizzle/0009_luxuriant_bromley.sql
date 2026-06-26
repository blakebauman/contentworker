CREATE TABLE "comments" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"id" text NOT NULL,
	"entry_id" text NOT NULL,
	"parent_id" text,
	"author" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "comments_space_id_environment_id_id_pk" PRIMARY KEY("space_id","environment_id","id")
);
--> statement-breakpoint
CREATE TABLE "entry_workflow_state" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"workflow_id" text NOT NULL,
	"current_step_id" text NOT NULL,
	CONSTRAINT "entry_workflow_state_space_id_environment_id_entry_id_pk" PRIMARY KEY("space_id","environment_id","entry_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"id" text NOT NULL,
	"entry_id" text NOT NULL,
	"assignee" text,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "tasks_space_id_environment_id_id_pk" PRIMARY KEY("space_id","environment_id","id")
);
--> statement-breakpoint
CREATE TABLE "workflow_definitions" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"steps" jsonb NOT NULL,
	CONSTRAINT "workflow_definitions_space_id_environment_id_id_pk" PRIMARY KEY("space_id","environment_id","id")
);
--> statement-breakpoint
CREATE INDEX "comments_by_entry" ON "comments" USING btree ("space_id","environment_id","entry_id");--> statement-breakpoint
CREATE INDEX "tasks_by_entry" ON "tasks" USING btree ("space_id","environment_id","entry_id");