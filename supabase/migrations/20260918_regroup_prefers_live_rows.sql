-- regroup_account_hierarchy() picked a company's master row by stage priority, then highest
-- deal_value. It had no idea some rows are merged-away corpses in HubSpot, so a dead row could
-- win and the genuinely live deal became a hidden child.
--
-- Found 2026-09-18 via Coastal Ridge: five rows, all named the same. Three sit in `legal`, so
-- deal_value broke the tie and the STALE $37,500 row (merged into 63673389680 back in August)
-- became master, while the live $32,500 deal HubSpot still returns became its child. The deal
-- list shows company rows and hides stale ones, so the company vanished from both filters.
--
-- 38 live deals were invisible this way, including Equity Residential ($450k), TruAmerica
-- ($334k, whose master read inactive_sdr_follow_up while the live deal sat in proposal),
-- Camden ($250k), RPM Living ($200k), Sunrise ($120k), Goldrich Kest and Coastal Ridge in Legal.
--
-- Fix: a row HubSpot still returns always outranks one that was merged away. Everything else
-- about the ordering is unchanged. This also makes the nightly run self-healing, so no one-off
-- re-parenting is needed — just call the function once.

CREATE OR REPLACE FUNCTION public.regroup_account_hierarchy()
RETURNS void AS $$
begin
  update accounts set is_master = false, parent_account_id = null
  where is_master or parent_account_id is not null;

  with n as (
    select id, stage, deal_value, updated_at, hubspot_merged_into,
      trim(regexp_replace(regexp_replace(regexp_replace(lower(name),'[^a-z0-9]+',' ','g'),
        '\s+(inc|llc|corp|corporation|incorporated|ltd|limited|lp|llp|co)\s*$','','g'),'\s+',' ','g')) as nk
    from accounts
  ),
  grp as (
    select id, nk, count(*) over (partition by nk) as grp_size,
      row_number() over (partition by nk order by
        -- Live rows first: false sorts before true, so a merged-away row can never be master
        -- while any surviving row exists in the group.
        (hubspot_merged_into is not null),
        case stage when 'legal' then 1 when 'proposal' then 2 when 'solution_validation' then 3
          when 'demo' then 4 when 'active_pursuit' then 5 when 'qualifying' then 6
          when 'intro_scheduled' then 7 when 'closed_won' then 8 else 9 end,
        coalesce(deal_value,0) desc, updated_at desc nulls last, id) as rn
    from n
  ),
  masters as (select nk, id as master_id from grp where rn = 1 and grp_size > 1)
  update accounts a set is_master = true, parent_account_id = null
  from masters m where a.id = m.master_id;

  with n as (
    select id, stage, deal_value, updated_at, hubspot_merged_into,
      trim(regexp_replace(regexp_replace(regexp_replace(lower(name),'[^a-z0-9]+',' ','g'),
        '\s+(inc|llc|corp|corporation|incorporated|ltd|limited|lp|llp|co)\s*$','','g'),'\s+',' ','g')) as nk
    from accounts
  ),
  grp as (
    select id, nk, count(*) over (partition by nk) as grp_size,
      row_number() over (partition by nk order by
        (hubspot_merged_into is not null),
        case stage when 'legal' then 1 when 'proposal' then 2 when 'solution_validation' then 3
          when 'demo' then 4 when 'active_pursuit' then 5 when 'qualifying' then 6
          when 'intro_scheduled' then 7 when 'closed_won' then 8 else 9 end,
        coalesce(deal_value,0) desc, updated_at desc nulls last, id) as rn
    from n
  ),
  masters as (select nk, id as master_id from grp where rn = 1 and grp_size > 1)
  update accounts a set parent_account_id = m.master_id
  from grp g join masters m on m.nk = g.nk
  where a.id = g.id and g.rn > 1;

  -- Name grouping alone is not enough. HubSpot merges rows whose names normalise differently
  -- ("Core Spaces - 2/6/2025 - Capex" vs "Core Spaces"), so they land in separate groups and the
  -- merged corpse stays a master of its own. The merge link is authoritative: park every
  -- merged-away row under its survivor's family root. Using the root rather than the survivor
  -- itself avoids creating a second master inside one name group, and the id guard prevents
  -- a row ever becoming its own parent.
  update accounts a
  set parent_account_id = coalesce(s.parent_account_id, s.id), is_master = false
  from accounts s
  where a.hubspot_merged_into is not null
    and s.hubspot_deal_id = a.hubspot_merged_into
    and s.id <> a.id
    and coalesce(s.parent_account_id, s.id) <> a.id;
end
$$ LANGUAGE plpgsql;

-- Apply it now rather than waiting for the nightly HubSpot sync.
SELECT public.regroup_account_hierarchy();
