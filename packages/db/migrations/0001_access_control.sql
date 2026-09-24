-- Custom SQL migration file, put your code below! --
-- These are NOLOGIN privilege groups. Provision separate non-owner login roles in Neon
-- and grant exactly one group to each credential outside this migration.
CREATE ROLE waffle_api NOLOGIN NOBYPASSRLS;
--> statement-breakpoint
CREATE ROLE waffle_watcher NOLOGIN NOBYPASSRLS;
--> statement-breakpoint
CREATE ROLE waffle_delivery NOLOGIN NOBYPASSRLS;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO waffle_api, waffle_watcher, waffle_delivery;
--> statement-breakpoint
REVOKE ALL ON public.watched_wallets, public.users, public.user_wallet_subscriptions,
  public.signals, public.push_tokens, public.paper_positions, public.trade_attempts,
  public.auth_challenges, public.sessions, public.signal_events, public.push_deliveries
  FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT ON public.watched_wallets, public.signals, public.signal_events TO waffle_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users, public.auth_challenges, public.sessions TO waffle_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_wallet_subscriptions,
  public.push_tokens, public.paper_positions, public.trade_attempts TO waffle_api;
--> statement-breakpoint
GRANT SELECT ON public.watched_wallets TO waffle_watcher;
--> statement-breakpoint
GRANT UPDATE (recent_supported_activity_at) ON public.watched_wallets TO waffle_watcher;
--> statement-breakpoint
GRANT INSERT ON public.signals, public.signal_events TO waffle_watcher;
--> statement-breakpoint
GRANT SELECT (id, signature, wallet_id) ON public.signals TO waffle_watcher;
--> statement-breakpoint
GRANT SELECT (id) ON public.signal_events TO waffle_watcher;
--> statement-breakpoint
GRANT USAGE ON SEQUENCE public.signal_events_id_seq TO waffle_watcher;
--> statement-breakpoint
GRANT SELECT ON public.watched_wallets, public.signals, public.signal_events,
  public.user_wallet_subscriptions, public.push_tokens TO waffle_delivery;
--> statement-breakpoint
GRANT UPDATE (push_expanded_at, live_dispatched_at) ON public.signal_events TO waffle_delivery;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON public.push_deliveries TO waffle_delivery;
--> statement-breakpoint
GRANT UPDATE (active, updated_at) ON public.push_tokens TO waffle_delivery;
--> statement-breakpoint
ALTER TABLE public.user_wallet_subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.user_wallet_subscriptions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.push_tokens FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.paper_positions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.paper_positions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.trade_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.trade_attempts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.push_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE public.push_deliveries FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY subscriptions_owner ON public.user_wallet_subscriptions
  FOR ALL TO waffle_api
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY push_tokens_owner ON public.push_tokens
  FOR ALL TO waffle_api
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY paper_positions_owner ON public.paper_positions
  FOR ALL TO waffle_api
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY trade_attempts_owner ON public.trade_attempts
  FOR ALL TO waffle_api
  USING (user_id = nullif(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = nullif(current_setting('app.user_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY subscriptions_delivery_read ON public.user_wallet_subscriptions
  FOR SELECT TO waffle_delivery USING (true);
--> statement-breakpoint
CREATE POLICY push_tokens_delivery_read ON public.push_tokens
  FOR SELECT TO waffle_delivery USING (true);
--> statement-breakpoint
CREATE POLICY push_tokens_delivery_disable ON public.push_tokens
  FOR UPDATE TO waffle_delivery USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY push_deliveries_worker ON public.push_deliveries
  FOR ALL TO waffle_delivery USING (true) WITH CHECK (true);
