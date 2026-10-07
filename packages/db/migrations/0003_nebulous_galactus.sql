CREATE TABLE "user_tracked_wallets" (
	"user_id" uuid NOT NULL,
	"watched_wallet_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_tracked_wallets_user_id_watched_wallet_id_pk" PRIMARY KEY("user_id","watched_wallet_id")
);
--> statement-breakpoint
ALTER TABLE "watched_wallets" ADD COLUMN "source" varchar(16) DEFAULT 'catalog' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_tracked_wallets" ADD CONSTRAINT "user_tracked_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tracked_wallets" ADD CONSTRAINT "user_tracked_wallets_watched_wallet_id_watched_wallets_id_fk" FOREIGN KEY ("watched_wallet_id") REFERENCES "public"."watched_wallets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_tracked_wallets_wallet_idx" ON "user_tracked_wallets" USING btree ("watched_wallet_id");--> statement-breakpoint
ALTER TABLE "watched_wallets" ADD CONSTRAINT "watched_wallets_source_check" CHECK ("watched_wallets"."source" IN ('catalog', 'user'));--> statement-breakpoint
-- Custom SQL migration file, put your code below! --
-- User wallet tracking: the API may append user-sourced catalog rows and pause them,
-- and may manage owner-scoped tracking rows. Catalog rows stay curated by the seed.
REVOKE ALL ON public.user_tracked_wallets FROM PUBLIC;--> statement-breakpoint
GRANT INSERT ON public.watched_wallets TO waffle_api;--> statement-breakpoint
GRANT UPDATE (active, label, source, inclusion_reason) ON public.watched_wallets TO waffle_api;--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON public.user_tracked_wallets TO waffle_api;--> statement-breakpoint
ALTER TABLE public.user_tracked_wallets ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE public.user_tracked_wallets FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- Writes are owner-scoped. Reads are open to the API role because pausing an unused
-- user-sourced wallet requires counting trackers across users; the API only ever
-- exposes the caller's own tracking rows (filtered by user_id).
CREATE POLICY user_tracked_wallets_read ON public.user_tracked_wallets
  FOR SELECT TO waffle_api USING (true);--> statement-breakpoint
CREATE POLICY user_tracked_wallets_insert ON public.user_tracked_wallets
  FOR INSERT TO waffle_api
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);--> statement-breakpoint
CREATE POLICY user_tracked_wallets_delete ON public.user_tracked_wallets
  FOR DELETE TO waffle_api
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid);