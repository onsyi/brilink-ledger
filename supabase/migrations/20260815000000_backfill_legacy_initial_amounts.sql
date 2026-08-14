-- Backfill initial_amount for legacy shifts (opened before the capital model
-- added initial_amount to bank_balances/ppob_balances).
-- Legacy shifts are identified by: modal_awal = initial_physical_balance
-- (post-model shifts have modal_awal = fisik + bank + ppob).
-- Opening balances are reconstructed via carry-over: the previous closed
-- shift's final_amount for the same account (per user).

-- bank_balances
UPDATE bank_balances bb
SET initial_amount = COALESCE((
  SELECT prev_bb.final_amount
  FROM bank_balances prev_bb
  JOIN shifts prev_s ON prev_s.id = prev_bb.shift_id
  WHERE prev_s.user_id = cur_s.user_id
    AND prev_s.status = 'closed'
    AND prev_s.start_time < cur_s.start_time
    AND prev_bb.bank_name = bb.bank_name
  ORDER BY prev_s.start_time DESC
  LIMIT 1
), 0)
FROM shifts cur_s
WHERE cur_s.id = bb.shift_id
  AND bb.initial_amount = 0
  AND cur_s.modal_awal IS NOT DISTINCT FROM cur_s.initial_physical_balance;

-- ppob_balances
UPDATE ppob_balances pb
SET initial_amount = COALESCE((
  SELECT prev_pb.final_amount
  FROM ppob_balances prev_pb
  JOIN shifts prev_s ON prev_s.id = prev_pb.shift_id
  WHERE prev_s.user_id = cur_s.user_id
    AND prev_s.status = 'closed'
    AND prev_s.start_time < cur_s.start_time
    AND prev_pb.provider_name = pb.provider_name
  ORDER BY prev_s.start_time DESC
  LIMIT 1
), 0)
FROM shifts cur_s
WHERE cur_s.id = pb.shift_id
  AND pb.initial_amount = 0
  AND cur_s.modal_awal IS NOT DISTINCT FROM cur_s.initial_physical_balance;
