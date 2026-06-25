CREATE TABLE "content_types" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"api_id" text NOT NULL,
	"name" text NOT NULL,
	"display_field" text NOT NULL,
	"fields" jsonb NOT NULL,
	"version" integer NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "content_types_space_id_environment_id_api_id_pk" PRIMARY KEY("space_id","environment_id","api_id")
);
--> statement-breakpoint
CREATE TABLE "entries" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"id" text NOT NULL,
	"content_type_api_id" text NOT NULL,
	"status" text NOT NULL,
	"current_version" integer NOT NULL,
	"published_version" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entries_space_id_environment_id_id_pk" PRIMARY KEY("space_id","environment_id","id")
);
--> statement-breakpoint
CREATE TABLE "entry_published" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"content_type_api_id" text NOT NULL,
	"version" integer NOT NULL,
	"fields" jsonb NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "entry_published_space_id_environment_id_entry_id_pk" PRIMARY KEY("space_id","environment_id","entry_id")
);
--> statement-breakpoint
CREATE TABLE "entry_versions" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"version" integer NOT NULL,
	"fields" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "entry_versions_space_id_environment_id_entry_id_version_pk" PRIMARY KEY("space_id","environment_id","entry_id","version")
);
--> statement-breakpoint
CREATE TABLE "environments" (
	"id" text NOT NULL,
	"space_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environments_space_id_id_pk" PRIMARY KEY("space_id","id")
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"relayed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "spaces" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"default_locale" text NOT NULL,
	"locales" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_space_id_spaces_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."spaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entry_published_by_type" ON "entry_published" USING btree ("space_id","environment_id","content_type_api_id");--> statement-breakpoint
CREATE INDEX "outbox_pending" ON "outbox" USING btree ("occurred_at") WHERE "outbox"."relayed_at" IS NULL;