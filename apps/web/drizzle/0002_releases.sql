CREATE TABLE "releases" (
	"id" serial PRIMARY KEY NOT NULL,
	"repo_id" integer NOT NULL,
	"tag_name" text NOT NULL,
	"target_sha" text NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"is_draft" boolean DEFAULT false NOT NULL,
	"is_prerelease" boolean DEFAULT false NOT NULL,
	"author_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_repo_id_repositories_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repositories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "releases_repo_tag_idx" ON "releases" USING btree ("repo_id","tag_name");--> statement-breakpoint
CREATE INDEX "releases_repo_idx" ON "releases" USING btree ("repo_id","id");