CREATE TABLE "functions" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"event_pattern" text NOT NULL,
	"url" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "functions_space_id_environment_id_id_pk" PRIMARY KEY("space_id","environment_id","id")
);
