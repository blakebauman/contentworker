CREATE TABLE "references" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"from_entry_id" text NOT NULL,
	"from_field" text NOT NULL,
	"to_id" text NOT NULL,
	"to_type" text NOT NULL,
	CONSTRAINT "references_space_id_environment_id_from_entry_id_from_field_to_id_pk" PRIMARY KEY("space_id","environment_id","from_entry_id","from_field","to_id")
);
--> statement-breakpoint
CREATE INDEX "references_reverse" ON "references" USING btree ("space_id","environment_id","to_id");