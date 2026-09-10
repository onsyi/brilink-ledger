-- =========================================================================
-- Fix: Grant INSERT and DELETE on public.transactions to authenticated
-- =========================================================================
-- Migration 20260821000002 revoked INSERT/DELETE on public.transactions because
-- at that time the cashier transaction form had not yet been built.
-- When TransactionPanel was implemented in dashboard.tsx, cashiers attempting
-- to record transactions hit "permission denied for table transactions".
--
-- Writes remain fully secured by:
-- 1. RLS policies txn_insert and txn_delete using shift_is_writable(shift_id)
-- 2. Trigger trg_prevent_closed_txn_edit enforcing immutability of closed shifts

GRANT SELECT, INSERT, DELETE ON public.transactions TO authenticated;
