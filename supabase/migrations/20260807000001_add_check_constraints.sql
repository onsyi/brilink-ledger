-- Add CHECK constraints for monetary columns to prevent negative values
-- These are defense-in-depth; the application should also validate.

ALTER TABLE public.shifts
  DROP CONSTRAINT IF EXISTS shifts_initial_physical_balance_check,
  DROP CONSTRAINT IF EXISTS shifts_total_expenses_check,
  DROP CONSTRAINT IF EXISTS shifts_topup_request_check,
  DROP CONSTRAINT IF EXISTS shifts_deposit_amount_check;
ALTER TABLE public.shifts
  ADD CONSTRAINT shifts_initial_physical_balance_check CHECK (initial_physical_balance >= 0),
  ADD CONSTRAINT shifts_total_expenses_check CHECK (total_expenses >= 0),
  ADD CONSTRAINT shifts_topup_request_check CHECK (topup_request >= 0),
  ADD CONSTRAINT shifts_deposit_amount_check CHECK (deposit_amount >= 0);

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_principal_amount_check,
  DROP CONSTRAINT IF EXISTS transactions_customer_fee_check,
  DROP CONSTRAINT IF EXISTS transactions_provider_cost_check;
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_principal_amount_check CHECK (principal_amount >= 0),
  ADD CONSTRAINT transactions_customer_fee_check CHECK (customer_fee >= 0),
  ADD CONSTRAINT transactions_provider_cost_check CHECK (provider_cost >= 0);

ALTER TABLE public.bank_balances
  DROP CONSTRAINT IF EXISTS bank_balances_final_amount_check;
ALTER TABLE public.bank_balances
  ADD CONSTRAINT bank_balances_final_amount_check CHECK (final_amount >= 0);

ALTER TABLE public.ppob_balances
  DROP CONSTRAINT IF EXISTS ppob_balances_final_amount_check;
ALTER TABLE public.ppob_balances
  ADD CONSTRAINT ppob_balances_final_amount_check CHECK (final_amount >= 0);

ALTER TABLE public.receivables
  DROP CONSTRAINT IF EXISTS receivables_debt_amount_check;
ALTER TABLE public.receivables
  ADD CONSTRAINT receivables_debt_amount_check CHECK (debt_amount >= 0);
