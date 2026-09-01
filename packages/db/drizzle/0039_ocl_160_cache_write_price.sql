ALTER TABLE "model_price" ADD COLUMN "cache_write_per_mtok" numeric(12, 6);--> statement-breakpoint

-- OCL-160: a workspace's custom price row never separately priced a cache
-- write before this column existed, so it billed at the read rate — the same
-- bug this card fixes in the seed table. Backfilling at the input rate is the
-- same fallback the seed table uses for a model with no published write
-- price: never zero, never the (wrong) read rate.
UPDATE "model_price" SET "cache_write_per_mtok" = "input_per_mtok" WHERE "cache_write_per_mtok" IS NULL;--> statement-breakpoint

ALTER TABLE "model_price" ALTER COLUMN "cache_write_per_mtok" SET NOT NULL;
