-- Perbaikan regresi dari 20260909000001_add_owner_withdrawal.sql:
--
-- CREATE OR REPLACE FUNCTION dengan daftar argumen yang BERBEDA tidak menimpa
-- fungsi lama, melainkan membuat overload kedua. Akibatnya PostgREST punya dua
-- kandidat close_shift_atomic untuk pemanggil gaya lama (10 argumen — bundle
-- frontend lama), dan menolak dengan:
--   "Could not choose the best candidate function between:
--    close_shift_atomic(10 arg) , close_shift_atomic(11 arg)"
--
-- Solusi: hapus overload 10-argumen. Fungsi 11-argumen punya DEFAULT 0 untuk
-- _owner_withdrawal, jadi pemanggil lama (10 arg) dan baru (11 arg) sama-sama
-- menemui tepat satu kandidat.
--
-- Sekalian menutup kebocoran privilege: CREATE FUNCTION otomatis memberi
-- EXECUTE ke PUBLIC, sehingga overload baru sempat terekspos ke anon —
-- dikembalikan ke pola least-privilege proyek.

DROP FUNCTION IF EXISTS public.close_shift_atomic(
  uuid, numeric, numeric, numeric, text, numeric, numeric, numeric, jsonb, jsonb
);

REVOKE ALL ON FUNCTION public.close_shift_atomic(
  uuid, numeric, numeric, numeric, text, numeric, numeric, numeric, jsonb, jsonb, numeric
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.close_shift_atomic(
  uuid, numeric, numeric, numeric, text, numeric, numeric, numeric, jsonb, jsonb, numeric
) TO authenticated, service_role;
