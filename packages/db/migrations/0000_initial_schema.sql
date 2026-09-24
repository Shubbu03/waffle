CREATE TABLE "auth_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nonce_hash" varchar(64) NOT NULL,
	"domain" varchar(253) NOT NULL,
	"uri" text NOT NULL,
	"version" varchar(8) DEFAULT '1' NOT NULL,
	"chain_id" varchar(20) NOT NULL,
	"statement" varchar(300) NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "auth_challenges_expiry_check" CHECK ("auth_challenges"."expires_at" > "auth_challenges"."issued_at" AND "auth_challenges"."expires_at" <= "auth_challenges"."issued_at" + interval '5 minutes'),
	CONSTRAINT "auth_challenges_version_check" CHECK ("auth_challenges"."version" = '1'),
	CONSTRAINT "auth_challenges_chain_check" CHECK ("auth_challenges"."chain_id" IN ('mainnet', 'solana:mainnet'))
);
--> statement-breakpoint
CREATE TABLE "paper_positions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"signal_id" uuid NOT NULL,
	"size_lamports" bigint NOT NULL,
	"entry_quote" jsonb NOT NULL,
	"simulated" boolean DEFAULT true NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "paper_positions_size_check" CHECK ("paper_positions"."size_lamports" > 0 AND "paper_positions"."size_lamports" <= 100000000),
	CONSTRAINT "paper_positions_simulated_check" CHECK ("paper_positions"."simulated" = true),
	CONSTRAINT "paper_positions_status_check" CHECK (("paper_positions"."status" = 'open' AND "paper_positions"."closed_at" IS NULL) OR ("paper_positions"."status" = 'closed' AND "paper_positions"."closed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "push_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signal_event_id" bigint NOT NULL,
	"push_token_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_deliveries_status_check" CHECK ("push_deliveries"."status" IN ('pending', 'sent', 'failed', 'disabled')),
	CONSTRAINT "push_deliveries_attempts_check" CHECK ("push_deliveries"."attempts" >= 0),
	CONSTRAINT "push_deliveries_sent_check" CHECK ("push_deliveries"."status" <> 'sent' OR "push_deliveries"."sent_at" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "push_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"token" text NOT NULL,
	"platform" varchar(16) DEFAULT 'android' NOT NULL,
	"notification_permission" varchar(16) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_tokens_hash_check" CHECK ("push_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "push_tokens_platform_check" CHECK ("push_tokens"."platform" = 'android'),
	CONSTRAINT "push_tokens_permission_check" CHECK ("push_tokens"."notification_permission" IN ('granted', 'denied'))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_expiry_check" CHECK ("sessions"."expires_at" > "sessions"."created_at" AND "sessions"."expires_at" <= "sessions"."created_at" + interval '7 days')
);
--> statement-breakpoint
CREATE TABLE "signal_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"signal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"push_expanded_at" timestamp with time zone,
	"live_dispatched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"signature" varchar(88) NOT NULL,
	"wallet_id" uuid NOT NULL,
	"mint_address" varchar(44) NOT NULL,
	"source_program_id" varchar(44) NOT NULL,
	"slot" bigint NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	"score_version" integer NOT NULL,
	"score" integer NOT NULL,
	"status" varchar(20) NOT NULL,
	"data_status" varchar(20) NOT NULL,
	"reasons" jsonb NOT NULL,
	"snapshot" jsonb NOT NULL,
	CONSTRAINT "signals_slot_nonnegative_check" CHECK ("signals"."slot" >= 0),
	CONSTRAINT "signals_score_range_check" CHECK ("signals"."score" BETWEEN 0 AND 100),
	CONSTRAINT "signals_score_version_check" CHECK ("signals"."score_version" > 0),
	CONSTRAINT "signals_status_check" CHECK ("signals"."status" IN ('eligible', 'history-only', 'suppressed')),
	CONSTRAINT "signals_data_status_check" CHECK ("signals"."data_status" IN ('complete', 'partial', 'stale', 'unknown'))
);
--> statement-breakpoint
CREATE TABLE "trade_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"signal_id" uuid NOT NULL,
	"quote_id" uuid NOT NULL,
	"request_id" varchar(200) NOT NULL,
	"taker" varchar(44) NOT NULL,
	"router" varchar(16) NOT NULL,
	"input_amount_lamports" bigint NOT NULL,
	"status" varchar(20) DEFAULT 'prepared' NOT NULL,
	"signature" varchar(88),
	"execute_code" integer,
	"failure_reason" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trade_attempts_size_check" CHECK ("trade_attempts"."input_amount_lamports" > 0 AND "trade_attempts"."input_amount_lamports" <= 50000000),
	CONSTRAINT "trade_attempts_router_check" CHECK ("trade_attempts"."router" IN ('metis', 'dflow', 'okx')),
	CONSTRAINT "trade_attempts_status_check" CHECK ("trade_attempts"."status" IN ('prepared', 'wallet_rejected', 'submitted', 'confirmed', 'failed')),
	CONSTRAINT "trade_attempts_confirmed_check" CHECK ("trade_attempts"."status" <> 'confirmed' OR ("trade_attempts"."signature" IS NOT NULL AND "trade_attempts"."execute_code" = 0 AND "trade_attempts"."failure_reason" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "user_wallet_subscriptions" (
	"user_id" uuid NOT NULL,
	"watched_wallet_id" uuid NOT NULL,
	"alerts_enabled" boolean DEFAULT false NOT NULL,
	"alerts_enabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_wallet_subscriptions_user_id_watched_wallet_id_pk" PRIMARY KEY("user_id","watched_wallet_id"),
	CONSTRAINT "user_wallet_subscriptions_alert_timestamp_check" CHECK ("user_wallet_subscriptions"."alerts_enabled" = ("user_wallet_subscriptions"."alerts_enabled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_address" varchar(44) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watched_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"address" varchar(44) NOT NULL,
	"label" varchar(80) NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"inclusion_reason" text NOT NULL,
	"recent_supported_activity_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_signal_event_id_signal_events_id_fk" FOREIGN KEY ("signal_event_id") REFERENCES "public"."signal_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_deliveries" ADD CONSTRAINT "push_deliveries_push_token_id_push_tokens_id_fk" FOREIGN KEY ("push_token_id") REFERENCES "public"."push_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_tokens" ADD CONSTRAINT "push_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signal_events" ADD CONSTRAINT "signal_events_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_wallet_id_watched_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."watched_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_attempts" ADD CONSTRAINT "trade_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trade_attempts" ADD CONSTRAINT "trade_attempts_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_wallet_subscriptions" ADD CONSTRAINT "user_wallet_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_wallet_subscriptions" ADD CONSTRAINT "user_wallet_subscriptions_watched_wallet_id_watched_wallets_id_fk" FOREIGN KEY ("watched_wallet_id") REFERENCES "public"."watched_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_challenges_nonce_hash_unique" ON "auth_challenges" USING btree ("nonce_hash");--> statement-breakpoint
CREATE INDEX "auth_challenges_expires_idx" ON "auth_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "paper_positions_user_created_idx" ON "paper_positions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "push_deliveries_event_token_unique" ON "push_deliveries" USING btree ("signal_event_id","push_token_id");--> statement-breakpoint
CREATE INDEX "push_deliveries_due_idx" ON "push_deliveries" USING btree ("next_attempt_at") WHERE "push_deliveries"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "push_tokens_token_hash_unique" ON "push_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "push_tokens_user_idx" ON "push_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_unique" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "signal_events_signal_unique" ON "signal_events" USING btree ("signal_id");--> statement-breakpoint
CREATE INDEX "signal_events_push_pending_idx" ON "signal_events" USING btree ("id") WHERE "signal_events"."push_expanded_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "signals_signature_wallet_unique" ON "signals" USING btree ("signature","wallet_id");--> statement-breakpoint
CREATE INDEX "signals_wallet_published_idx" ON "signals" USING btree ("wallet_id","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "trade_attempts_user_request_unique" ON "trade_attempts" USING btree ("user_id","request_id");--> statement-breakpoint
CREATE INDEX "trade_attempts_user_created_idx" ON "trade_attempts" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "user_wallet_subscriptions_wallet_idx" ON "user_wallet_subscriptions" USING btree ("watched_wallet_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_wallet_address_unique" ON "users" USING btree ("wallet_address");--> statement-breakpoint
CREATE UNIQUE INDEX "watched_wallets_address_unique" ON "watched_wallets" USING btree ("address");