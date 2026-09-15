-- Deals that vanish from HubSpot's search API are almost always MERGED, not deleted.
-- Proven 2026-09-15: GET /crm/v3/objects/deals/13692694838 returns id 63673380271 — HubSpot
-- redirects a merged-away id to its survivor, while excluding it from search/list results.
-- ~598 of our accounts were in this state, frozen at a stale stage (a closed MAA deal sat in
-- Proposal for five weeks).
--
-- Records the survivor so the UI can say "merged into X" instead of guessing, and so these
-- rows can eventually be re-parented under the surviving company.
ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS hubspot_merged_into TEXT;

COMMENT ON COLUMN public.accounts.hubspot_merged_into IS
  'If set, this account''s hubspot_deal_id was merged in HubSpot into this surviving deal id. Its stage is frozen and should not be trusted.';

CREATE INDEX IF NOT EXISTS idx_accounts_merged_into
  ON public.accounts (hubspot_merged_into) WHERE hubspot_merged_into IS NOT NULL;
