CREATE TABLE "bulk_job_chunks" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"job_id" text NOT NULL,
	"chunk_id" text NOT NULL,
	"entry_ids" jsonb NOT NULL,
	"status" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"failures" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "bulk_job_chunks_space_id_environment_id_job_id_chunk_id_pk" PRIMARY KEY("space_id","environment_id","job_id","chunk_id")
);
--> statement-breakpoint
CREATE TABLE "bulk_jobs" (
	"space_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"id" text NOT NULL,
	"action" text NOT NULL,
	"status" text NOT NULL,
	"total_items" integer NOT NULL,
	"total_chunks" integer NOT NULL,
	"completed_chunks" integer DEFAULT 0 NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "bulk_jobs_space_id_environment_id_id_pk" PRIMARY KEY("space_id","environment_id","id")
);
--> statement-breakpoint
CREATE INDEX "bulk_chunks_open" ON "bulk_job_chunks" USING btree ("status","created_at") WHERE "bulk_job_chunks"."status" IN ('pending', 'running');