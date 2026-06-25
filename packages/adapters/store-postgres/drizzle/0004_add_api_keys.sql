CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"hashed_token" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hashed_token" ON "api_keys" USING btree ("hashed_token");--> statement-breakpoint
CREATE INDEX "api_keys_by_space" ON "api_keys" USING btree ("space_id");