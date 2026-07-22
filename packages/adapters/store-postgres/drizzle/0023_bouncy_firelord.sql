CREATE TABLE "agent_reviews" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"id" text NOT NULL,
	"workflow" text NOT NULL,
	"entry_id" text NOT NULL,
	"proposed" jsonb NOT NULL,
	"notes" jsonb NOT NULL,
	"status" text NOT NULL,
	"awaiting" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"applied_at" timestamp with time zone,
	CONSTRAINT "agent_reviews_space_id_environment_id_id_pk" PRIMARY KEY("space_id","environment_id","id")
);
--> statement-breakpoint
CREATE INDEX "agent_reviews_pending" ON "agent_reviews" USING btree ("space_id","environment_id","status","created_at");