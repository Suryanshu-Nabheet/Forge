ALTER TABLE "review_comments" ALTER COLUMN "pr_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "intent_id" integer;--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "in_reply_to" integer;--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_intent_id_intents_id_fk" FOREIGN KEY ("intent_id") REFERENCES "public"."intents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_in_reply_to_review_comments_id_fk" FOREIGN KEY ("in_reply_to") REFERENCES "public"."review_comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "rc_intent_idx" ON "review_comments" USING btree ("intent_id");--> statement-breakpoint
CREATE INDEX "rc_reply_idx" ON "review_comments" USING btree ("in_reply_to");