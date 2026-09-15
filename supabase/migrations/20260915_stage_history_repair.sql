-- Repair stage-change tracking.
--
-- Found 2026-09-15: account_stage_history held 325 rows, ALL stamped 2026-05-15 — the day the
-- table was seeded. fn_record_stage_change() existed but NO TRIGGER ever called it, so four
-- months of stage movement was never recorded. Only 18 of 142 live deals had any history.
--
-- This migration:
--   1. adds event_type so the table can carry more than stage changes
--   2. rewrites the function to fire on INSERT too (you cannot measure time-in-first-stage
--      without an "entered" event), stamp event_type, and fill days_in_prior_stage — a column
--      that already existed and was never populated
--   3. CREATES THE MISSING TRIGGER
--   4. seeds a 'baseline' row for live deals with no history, so time-in-stage has a start
--      point instead of being null for 87% of the pipeline
--
-- Written against the LIVE table shape, which had drifted from 20260513_stage_history.sql:
-- it also carries `stage` (NOT NULL), changed_by, changed_by_name and days_in_prior_stage.
--
-- Idempotent. Safe to re-run.

-- 1. ---------------------------------------------------------------------------------------
ALTER TABLE public.account_stage_history
  ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'stage_change';

COMMENT ON COLUMN public.account_stage_history.event_type IS
  'stage_change = a real move | created = row first seen in this stage | baseline = synthetic start point backfilled 2026-09-15, NOT an observed transition | left_pipeline / rejoined_pipeline = HubSpot stopped/resumed returning the deal';

CREATE INDEX IF NOT EXISTS idx_stage_history_account_changed
  ON public.account_stage_history (account_id, changed_at DESC);

-- 2. ---------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_record_stage_change()
RETURNS TRIGGER AS $$
DECLARE
  prev_at    TIMESTAMPTZ;
  days_prior INTEGER;
BEGIN
  -- Only act on a genuine stage move (or first sight of the row).
  IF TG_OP = 'UPDATE' AND NOT (OLD.stage IS DISTINCT FROM NEW.stage) THEN
    RETURN NEW;
  END IF;

  SELECT changed_at INTO prev_at
  FROM public.account_stage_history
  WHERE account_id = NEW.id
  ORDER BY changed_at DESC
  LIMIT 1;

  IF prev_at IS NOT NULL THEN
    days_prior := GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - prev_at)) / 86400))::INTEGER;
  END IF;

  INSERT INTO public.account_stage_history (
    account_id, stage, account_name, owner_name,
    from_stage, to_stage, deal_value_at_change, event_type, days_in_prior_stage
  ) VALUES (
    NEW.id,
    NEW.stage,
    NEW.name,
    NEW.owner_name,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.stage END,
    NEW.stage,
    NEW.deal_value,
    CASE WHEN TG_OP = 'INSERT' THEN 'created' ELSE 'stage_change' END,
    days_prior
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. THE MISSING PIECE ----------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_record_stage_change ON public.accounts;
CREATE TRIGGER trg_record_stage_change
  AFTER INSERT OR UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.fn_record_stage_change();

-- 4. ---------------------------------------------------------------------------------------
INSERT INTO public.account_stage_history (
  account_id, stage, account_name, owner_name,
  from_stage, to_stage, deal_value_at_change, event_type, changed_at
)
SELECT a.id, a.stage, a.name, a.owner_name, NULL, a.stage, a.deal_value, 'baseline', now()
FROM public.accounts a
WHERE a.stage IN ('qualifying','active_pursuit','demo','solution_validation','proposal','legal')
  AND NOT EXISTS (
    SELECT 1 FROM public.account_stage_history h WHERE h.account_id = a.id
  );
