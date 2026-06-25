CREATE TABLE "asset_published" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"file" jsonb NOT NULL,
	"title" jsonb NOT NULL,
	"description" jsonb NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "asset_published_space_id_environment_id_asset_id_pk" PRIMARY KEY("space_id","environment_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"id" text NOT NULL,
	"status" text NOT NULL,
	"file" jsonb NOT NULL,
	"title" jsonb NOT NULL,
	"description" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_space_id_environment_id_id_pk" PRIMARY KEY("space_id","environment_id","id")
);
