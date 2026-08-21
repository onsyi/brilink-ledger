-- Carry the closing balances of a branch's last shift into the next one, even
-- when a different cashier opens it.
--
-- Saldo bank dan PPOB itu milik outlet, bukan milik kasir: satu rekening BRI D
-- dipakai bergantian oleh siapa pun yang jaga. Tapi sampai sekarang lookup
-- "saldo akhir shift sebelumnya" disaring per user di dua lapis --
--
--   1. dashboard.tsx memfilter .eq("user_id", …), dan
--   2. shifts_select hanya membuka baris milik auth.uid() (atau owner).
--
-- -- sehingga kasir shift kedua di cabang yang sama membuka form dengan kolom
-- bank/PPOB kosong, lalu mengisinya dari ingatan atau membiarkannya nol. Modal
-- awal shift kedua jadi tidak nyambung dengan modal akhir shift pertama, dan
-- Laba Fee ikut salah karena rumusnya memakai selisih saldo awal-akhir.
--
-- Melonggarkan shifts_select ke satu cabang bukan jawabannya: itu sekaligus
-- membuka transaksi, laba, dan setoran kasir lain lewat shift_is_readable().
-- Yang dibutuhkan hanya angka penutupan, jadi pintunya dibuat sempit -- satu
-- RPC SECURITY DEFINER yang mengembalikan snapshot saldo saja, dan menentukan
-- cabang dari profiles server-side (bukan dari argumen klien) sesuai pola yang
-- sudah dipakai open_shift_atomic sejak 20260815000002.
--
-- Idempotent: safe to re-run.

CREATE OR REPLACE FUNCTION public.last_closed_shift_balances()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _branch UUID;
  _shift  public.shifts%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT branch_id INTO _branch FROM public.profiles WHERE id = auth.uid();

  IF _branch IS NOT NULL THEN
    SELECT * INTO _shift
    FROM public.shifts
    WHERE branch_id = _branch
      AND status = 'closed'
    ORDER BY end_time DESC NULLS LAST, start_time DESC
    LIMIT 1;
  END IF;

  -- Shift lama dari sebelum fitur cabang ada tidak punya branch_id, jadi
  -- pencarian per cabang di atas melewatinya. Hanya shift milik pemanggil
  -- sendiri yang boleh jadi cadangan -- outlet lain tetap tidak terlihat.
  IF _shift.id IS NULL THEN
    SELECT * INTO _shift
    FROM public.shifts
    WHERE user_id = auth.uid()
      AND branch_id IS NULL
      AND status = 'closed'
    ORDER BY end_time DESC NULLS LAST, start_time DESC
    LIMIT 1;
  END IF;

  IF _shift.id IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'shift', jsonb_build_object(
      'id', _shift.id,
      'end_time', _shift.end_time,
      'final_physical_balance', _shift.final_physical_balance,
      'closed_by', (SELECT username FROM public.profiles WHERE id = _shift.user_id),
      'is_own', _shift.user_id = auth.uid()
    ),
    'banks', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object('bank_name', bank_name, 'final_amount', final_amount)
               ORDER BY bank_name
             )
      FROM public.bank_balances WHERE shift_id = _shift.id
    ), '[]'::jsonb),
    'ppob', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object('provider_name', provider_name, 'final_amount', final_amount)
               ORDER BY provider_name
             )
      FROM public.ppob_balances WHERE shift_id = _shift.id
    ), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.last_closed_shift_balances() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.last_closed_shift_balances() TO authenticated, service_role;

-- Mempercepat pencarian shift terakhir per cabang di atas.
CREATE INDEX IF NOT EXISTS idx_shifts_branch_closed
  ON public.shifts (branch_id, end_time DESC)
  WHERE status = 'closed';
