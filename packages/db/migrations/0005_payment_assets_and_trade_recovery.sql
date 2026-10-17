ALTER TABLE paper_positions RENAME COLUMN size_lamports TO size_raw;
--> statement-breakpoint
ALTER TABLE trade_attempts RENAME COLUMN input_amount_lamports TO input_amount_raw;
--> statement-breakpoint
ALTER TABLE "paper_positions" DROP CONSTRAINT "paper_positions_size_check";--> statement-breakpoint
ALTER TABLE "trade_attempts" DROP CONSTRAINT "trade_attempts_size_check";--> statement-breakpoint
ALTER TABLE "trade_attempts" DROP CONSTRAINT "trade_attempts_status_check";--> statement-breakpoint
ALTER TABLE "paper_positions" ADD COLUMN "input_mint" varchar(44) DEFAULT 'So11111111111111111111111111111111111111112' NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_attempts" ADD COLUMN "input_mint" varchar(44) DEFAULT 'So11111111111111111111111111111111111111112' NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_attempts" ADD COLUMN "output_mint" varchar(44);--> statement-breakpoint
ALTER TABLE "trade_attempts" ADD COLUMN "review" jsonb;--> statement-breakpoint
ALTER TABLE "trade_attempts" ADD COLUMN "receipt" jsonb;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD CONSTRAINT "paper_positions_size_check" CHECK ("paper_positions"."size_raw" > 0 AND (("paper_positions"."input_mint" = 'So11111111111111111111111111111111111111112' AND "paper_positions"."size_raw" <= 100000000) OR ("paper_positions"."network" = 'mainnet' AND "paper_positions"."input_mint" = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' AND "paper_positions"."size_raw" <= 10000000)));--> statement-breakpoint
ALTER TABLE "trade_attempts" ADD CONSTRAINT "trade_attempts_size_check" CHECK ("trade_attempts"."input_amount_raw" > 0 AND (("trade_attempts"."input_mint" = 'So11111111111111111111111111111111111111112' AND "trade_attempts"."input_amount_raw" <= 50000000) OR ("trade_attempts"."network" = 'mainnet' AND "trade_attempts"."input_mint" = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' AND "trade_attempts"."input_amount_raw" <= 5000000)));--> statement-breakpoint
ALTER TABLE "trade_attempts" ADD CONSTRAINT "trade_attempts_status_check" CHECK ("trade_attempts"."status" IN ('prepared', 'wallet_rejected', 'submitted', 'confirmed', 'failed', 'expired'));
--> statement-breakpoint
ALTER TABLE paper_positions DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trade_attempts DISABLE ROW LEVEL SECURITY;
--> statement-breakpoint
UPDATE paper_positions SET entry_quote =
  (entry_quote - 'inputAmountLamports') || jsonb_build_object('inputAmountRaw', entry_quote->'inputAmountLamports')
WHERE entry_quote ? 'inputAmountLamports';
--> statement-breakpoint
UPDATE paper_positions SET entry_quote = jsonb_set(entry_quote, '{assessment}',
  ((entry_quote->'assessment') - 'inputAmountLamports') || jsonb_build_object(
    'inputAmountRaw', entry_quote->'assessment'->'inputAmountLamports',
    'inputMint', 'So11111111111111111111111111111111111111112'))
WHERE entry_quote->'assessment' ? 'inputAmountLamports';
--> statement-breakpoint
UPDATE trade_attempts SET output_mint = signals.mint_address FROM signals WHERE signals.id = trade_attempts.signal_id;

--> statement-breakpoint
ALTER TABLE paper_positions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE paper_positions FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trade_attempts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE trade_attempts FORCE ROW LEVEL SECURITY;
