CREATE TABLE "app_extensions" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"target" text NOT NULL,
	"entry_url" text NOT NULL,
	"field_types" jsonb,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "app_extensions_space_id_environment_id_id_pk" PRIMARY KEY("space_id","environment_id","id")
);
