CREATE TABLE "preview_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"entry_id" text NOT NULL,
	"hashed_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "preview_tokens_hashed_token" ON "preview_tokens" USING btree ("hashed_token");--> statement-breakpoint
CREATE INDEX "preview_tokens_by_entry" ON "preview_tokens" USING btree ("space_id","environment_id","entry_id");