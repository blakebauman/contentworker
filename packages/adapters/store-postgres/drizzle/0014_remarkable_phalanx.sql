CREATE TABLE "ai_actions" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"prompt_template" text NOT NULL,
	"variables" jsonb NOT NULL,
	"target_field" text,
	"tier" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ai_actions_space_id_environment_id_id_pk" PRIMARY KEY("space_id","environment_id","id")
);
