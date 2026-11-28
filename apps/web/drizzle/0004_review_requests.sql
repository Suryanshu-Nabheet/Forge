CREATE TABLE "pr_review_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"pr_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"source" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pr_review_requests" ADD CONSTRAINT "pr_review_requests_pr_id_pull_requests_id_fk" FOREIGN KEY ("pr_id") REFERENCES "public"."pull_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pr_review_requests" ADD CONSTRAINT "pr_review_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pr_review_requests_pr_user_idx" ON "pr_review_requests" USING btree ("pr_id","user_id");--> statement-breakpoint
CREATE INDEX "pr_review_requests_pr_idx" ON "pr_review_requests" USING btree ("pr_id");