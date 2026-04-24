-- Migration 004: fix parse_corrections.card_id type (uuid → bigint).
--
-- Migration 002 assumed user_cards(id) was uuid, but it is a bigint. Every
-- attempt to log a correction with a real card_id failed with
--   invalid input syntax for type uuid: "3438"
-- and the client's fire-and-forget path silently swallowed the error, so
-- parse_corrections stayed empty even though edits / deletes / alternate
-- approvals were firing logCorrection.
--
-- Safe to run on an empty table. If there are already rows in
-- parse_corrections, the USING null::bigint clause zeros out any existing
-- card_id values (they were all null or broken anyway, since inserts with
-- a non-uuid card_id would have been rejected at write time).
--
-- No indexes or FK constraints reference card_id (see migration_002), and
-- the correction_patterns_90d view does not select card_id, so no
-- dependent objects need to be rebuilt.

alter table public.parse_corrections
  alter column card_id type bigint using null::bigint;

comment on column public.parse_corrections.card_id is
  'user_cards.id (bigint) at time of correction. NOT a FK so deletes do not cascade away the ledger entry. Null for corrections that cannot be tied back to a specific row (e.g. alternate-answer flows where the lookup misses).';
