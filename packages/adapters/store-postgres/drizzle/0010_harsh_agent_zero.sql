CREATE TABLE "concept_schemes" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "concept_schemes_space_id_environment_id_id_pk" PRIMARY KEY("space_id","environment_id","id")
);
--> statement-breakpoint
CREATE TABLE "concepts" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"id" text NOT NULL,
	"scheme_id" text NOT NULL,
	"pref_label" text NOT NULL,
	"broader_id" text,
	CONSTRAINT "concepts_space_id_environment_id_id_pk" PRIMARY KEY("space_id","environment_id","id")
);
--> statement-breakpoint
CREATE TABLE "entry_metadata" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"tags" jsonb NOT NULL,
	"concepts" jsonb NOT NULL,
	CONSTRAINT "entry_metadata_space_id_environment_id_entry_id_pk" PRIMARY KEY("space_id","environment_id","entry_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"id" text NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "tags_space_id_environment_id_id_pk" PRIMARY KEY("space_id","environment_id","id")
);
--> statement-breakpoint
ALTER TABLE "entry_published" ADD COLUMN "metadata" jsonb;--> statement-breakpoint
CREATE INDEX "concepts_by_scheme" ON "concepts" USING btree ("space_id","environment_id","scheme_id");