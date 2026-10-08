ALTER TABLE "trade_attempts" DROP CONSTRAINT "trade_attempts_router_check";--> statement-breakpoint
DROP INDEX "watched_wallets_address_unique";--> statement-breakpoint
ALTER TABLE "watched_wallets" ADD COLUMN "network" varchar(16) DEFAULT 'mainnet' NOT NULL;--> statement-breakpoint
ALTER TABLE "paper_positions" ADD COLUMN "network" varchar(16) DEFAULT 'mainnet' NOT NULL;--> statement-breakpoint
ALTER TABLE "trade_attempts" ADD COLUMN "network" varchar(16) DEFAULT 'mainnet' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "watched_wallets_network_address_unique" ON "watched_wallets" USING btree ("network","address");--> statement-breakpoint
ALTER TABLE "watched_wallets" ADD CONSTRAINT "watched_wallets_network_check" CHECK ("watched_wallets"."network" IN ('mainnet', 'devnet', 'testnet'));--> statement-breakpoint
ALTER TABLE "trade_attempts" ADD CONSTRAINT "trade_attempts_router_check" CHECK ("trade_attempts"."router" IN ('metis', 'dflow', 'okx', 'pumpswap'));