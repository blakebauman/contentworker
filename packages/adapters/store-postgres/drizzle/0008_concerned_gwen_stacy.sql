CREATE TABLE "release_items" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"release_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	CONSTRAINT "release_items_space_id_environment_id_release_id_entity_id_pk" PRIMARY KEY("space_id","environment_id","release_id","entity_id")
);
--> statement-breakpoint
CREATE TABLE "releases" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "releases_space_id_environment_id_id_pk" PRIMARY KEY("space_id","environment_id","id")
);
--> statement-breakpoint
CREATE TABLE "scheduled_actions" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"executed_at" timestamp with time zone,
	"error" text,
	CONSTRAINT "scheduled_actions_space_id_environment_id_id_pk" PRIMARY KEY("space_id","environment_id","id")
);
--> statement-breakpoint
CREATE INDEX "scheduled_actions_due" ON "scheduled_actions" USING btree ("status","scheduled_for");