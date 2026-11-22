CREATE TABLE "trips" (
	"id" text PRIMARY KEY,
	"revision" integer NOT NULL,
	"document" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
