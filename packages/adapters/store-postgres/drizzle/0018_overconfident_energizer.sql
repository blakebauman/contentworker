CREATE TABLE "roles" (
	"space_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"scopes" jsonb NOT NULL,
	"content_grants" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_space_id_id_pk" PRIMARY KEY("space_id","id")
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "role_id" text;