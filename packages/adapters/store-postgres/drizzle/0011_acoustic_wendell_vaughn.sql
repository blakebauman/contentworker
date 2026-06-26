CREATE TABLE "environment_aliases" (
	"space_id" text NOT NULL,
	"alias" text NOT NULL,
	"target_environment_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_aliases_space_id_alias_pk" PRIMARY KEY("space_id","alias")
);
--> statement-breakpoint
ALTER TABLE "environment_aliases" ADD CONSTRAINT "environment_aliases_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;