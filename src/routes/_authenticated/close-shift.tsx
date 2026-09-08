import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Loader2,
  ClipboardCheck,
  CreditCard,
  Building2,
  ArrowRight,
  DollarSign,
  Undo2,
  TriangleAlert,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/MoneyInput";
import { BANKS, num, PPOB_PROVIDERS, rupiah } from "@/lib/ledger";
import { openShiftQuery } from "@/lib/queries";
import { QueryError } from "@/components/QueryError";

export const Route = createFileRoute("/_authenticated/close-shift")({
  head: () => ({
    meta: [
      { title: "Tutup Shift — Kasir BRILink" },
      {
        name: "description",
        content:
          "Penutupan shift: saldo tunai akhir, pengeluaran, saldo bank dan PPOB, serta setoran kasir.",
      },
      { property: "og:title", content: "Tutup Shift — Kasir BRILink" },
      {
        property: "og:description",
        content: "Kalkulasi modal akhir (aset akhir dikurangi modal awal) otomatis.",
      },
    ],
  }),
  component: CloseShift,
});

/** Sentinel for a submission rejected because one is already in flight. */
const IN_FLIGHT = "__close_shift_in_flight__";

function CloseShift() {
  const { user, role, loading: authLoading } = useAuth();
  const userId = user?.id;
  const isOwner = role === "owner";
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const shiftQuery = useQuery(openShiftQuery(userId, true));

  const shiftId = shiftQuery.data?.id;

  const [finalCash, setFinalCash] = useState("");
  const [additionalCapital, setAdditionalCapital] = useState("");
  const [expenses, setExpenses] = useState("");
  const [expenseNotes, setExpenseNotes] = useState("");
  const [topup, setTopup] = useState("");
  const [deposit, setDeposit] = useState("");
  const [settlement, setSettlement] = useState("");
  const [withdrawal, setWithdrawal] = useState("");
  const [banks, setBanks] = useState<Record<string, string>>({});
  const [ppob, setPpob] = useState<Record<string, string>>({});
  const [showConfirm, setShowConfirm] = useState(false);
  const [prefilled, setPrefilled] = useState(false);
  const submittingRef = useRef(false);

  // Guard "pengeluaran ganda": top-up PPOB yang juga ditulis di Pengeluaran
  // dihitung dua kali (inflasi laba/FBI) — pola berulang yang ditemukan audit.
  const doubleCountRisk = Number(topup || 0) > 0 && Number(expenses || 0) > 0;

  // Laporan yang ditolak owner dikembalikan lengkap dengan angkanya. Yang
  // diminta koreksi, bukan ketik ulang: sepuluh saldo bank dan lima PPOB yang
  // harus diketik ulang dari nol justru tempat kesalahan baru bermunculan.
  const rejectedSnapshot = shiftQuery.data?.rejected_snapshot ?? null;
  useEffect(() => {
    if (prefilled || !rejectedSnapshot) return;
    const money = (v: number | string | null | undefined) => String(num(v) || "");
    const bankMap: Record<string, string> = {};
    for (const b of BANKS) bankMap[b] = money(rejectedSnapshot.bank?.[b]);
    const ppobMap: Record<string, string> = {};
    for (const p of PPOB_PROVIDERS) ppobMap[p] = money(rejectedSnapshot.ppob?.[p]);
    setFinalCash(money(rejectedSnapshot.final_physical_balance));
    setAdditionalCapital(money(rejectedSnapshot.additional_capital));
    setExpenses(money(rejectedSnapshot.total_expenses));
    setExpenseNotes(rejectedSnapshot.expense_notes ?? "");
    setTopup(money(rejectedSnapshot.topup_request));
    setDeposit(money(rejectedSnapshot.deposit_amount));
    setSettlement(money(rejectedSnapshot.settlement_amount));
    setWithdrawal(money(rejectedSnapshot.owner_withdrawal));
    setBanks(bankMap);
    setPpob(ppobMap);
    setPrefilled(true);
  }, [prefilled, rejectedSnapshot]);

  const close = useMutation({
    mutationFn: async () => {
      if (submittingRef.current) throw new Error(IN_FLIGHT);
      submittingRef.current = true;
      if (!shiftId) throw new Error("Tidak ada shift aktif");
      if (finalCash === "") throw new Error("Saldo Tunai Akhir Tutup Kasir wajib diisi");
      if (Number(finalCash) < 0)
        throw new Error("Saldo Tunai Akhir Tutup Kasir tidak boleh negatif");
      if (Number(deposit || 0) < 0) throw new Error("Setoran tidak boleh negatif");
      if (Number(settlement || 0) < 0) throw new Error("Settlement tidak boleh negatif");
      if (Number(additionalCapital || 0) < 0) throw new Error("Modal tambahan tidak boleh negatif");
      if (Number(withdrawal || 0) < 0) throw new Error("Penarikan owner tidak boleh negatif");
      // Setoran sengaja tidak dibandingkan dengan saldo fisik akhir: kasir
      // menyerahkan uang ke owner lebih dulu, lalu menghitung sisa di laci, jadi
      // setoran memang normal lebih besar dari saldo akhir.

      const bankSnapshots = BANKS.map((b) => ({
        bank_name: b,
        final_amount: Number(banks[b] || 0),
      }));
      const ppobSnapshots = PPOB_PROVIDERS.map((p) => ({
        provider_name: p,
        final_amount: Number(ppob[p] || 0),
      }));

      const { error } = await supabase.rpc("close_shift_atomic", {
        _shift_id: shiftId,
        _final_cash: Number(finalCash || 0),
        _additional_capital: Number(additionalCapital || 0),
        _expenses: Number(expenses || 0),
        _expense_notes: expenseNotes.trim() || null,
        _topup: Number(topup || 0),
        _deposit: Number(deposit || 0),
        _settlement: Number(settlement || 0),
        _owner_withdrawal: Number(withdrawal || 0),
        _bank_snapshots: bankSnapshots,
        _ppob_snapshots: ppobSnapshots,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Shift ditutup dan terkunci");
      queryClient.invalidateQueries({ queryKey: ["open-shift"] });
      queryClient.invalidateQueries({ queryKey: ["deposit-shifts"] });
      queryClient.invalidateQueries({ queryKey: ["last-closed-shift"] });
      navigate({ to: "/reports" });
    },
    onError: (e: Error) => {
      // A rejected duplicate must not release the guard — the first submission
      // still owns it. Clearing it here let a third click through to the RPC.
      if (e.message === IN_FLIGHT) return;
      submittingRef.current = false;
      toast.error(e.message);
    },
  });

  if (isOwner)
    return (
      <div className="glass-card max-w-xl p-6 sm:p-8">
        <h1 className="text-xl font-bold">Owner tidak menjalankan shift</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Buka dan tutup shift hanya dilakukan kasir/teller. Sebagai owner, pantau hasilnya di
          ringkasan dan laporan.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button asChild variant="outline">
            <Link to="/dashboard">Ringkasan owner</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/reports">Laporan & audit</Link>
          </Button>
        </div>
      </div>
    );

  if (authLoading || shiftQuery.isLoading)
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4">
        <Loader2 className="size-6 animate-spin text-primary" />
        <p className="text-sm font-medium text-muted-foreground">Memuat data shift…</p>
      </div>
    );

  if (shiftQuery.isError)
    return (
      <div className="glass-card p-6 sm:p-8">
        <QueryError
          message="Gagal memuat shift aktif. Periksa koneksi Anda."
          onRetry={() => shiftQuery.refetch()}
        />
      </div>
    );

  if (!shiftQuery.data)
    return (
      <div className="glass-card p-6 sm:p-8">
        <h1 className="text-xl font-bold">Tidak ada shift aktif</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Buka shift terlebih dahulu sebelum melakukan penutupan.
        </p>
        <Button asChild className="mt-6">
          <Link to="/dashboard">
            Ke halaman shift <ArrowRight className="ml-1.5 size-4" />
          </Link>
        </Button>
      </div>
    );

  return (
    <form
      className="space-y-6 sm:space-y-7"
      onSubmit={(e) => {
        e.preventDefault();
        setShowConfirm(true);
      }}
    >
      <div>
        <h1 className="flex items-center gap-2.5 text-xl font-bold sm:text-2xl">
          <div className="flex size-9 items-center justify-center rounded-xl bg-primary/15 shadow-[0_0_15px_-3px] shadow-primary/20">
            <ClipboardCheck className="size-5 text-primary" />
          </div>
          Tutup Shift
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Validasi kas fisik, dokumentasi pengeluaran, dan snapshot saldo mesin.
        </p>
      </div>

      {shiftQuery.data.rejected_at && (
        <div className="flex gap-2.5 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 backdrop-blur-sm">
          <Undo2 className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="text-xs">
            <p className="font-semibold text-destructive">
              Laporan shift ini ditolak owner —{" "}
              {new Date(shiftQuery.data.rejected_at).toLocaleString("id-ID")}
            </p>
            {shiftQuery.data.rejection_reason && (
              <p className="mt-1 italic text-muted-foreground">
                “{shiftQuery.data.rejection_reason}”
              </p>
            )}
            <p className="mt-1 text-muted-foreground">
              Angka di bawah adalah isian laporan Anda sebelumnya. Perbaiki yang keliru, lalu tutup
              shift lagi. Modal awal shift tidak ikut berubah.
            </p>
          </div>
        </div>
      )}

      {/* Main Inputs */}
      <section className="glass-card p-5 sm:p-6 space-y-4">
        <h2 className="text-base font-bold flex items-center gap-2">
          <DollarSign className="size-4 text-primary" /> Kas Fisik, Pengeluaran & Setoran
        </h2>
        <p className="text-xs text-muted-foreground">
          Lengkapi kas fisik, pengeluaran, setoran, dan settlement selama shift.
        </p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MoneyInput
            id="final-cash"
            label="Saldo Tunai Akhir Tutup Kasir"
            value={finalCash}
            onChange={setFinalCash}
            required
          />
          <MoneyInput
            id="additional-capital"
            label="Modal tambahan (opsional)"
            value={additionalCapital}
            onChange={setAdditionalCapital}
          />
          <MoneyInput
            id="expenses"
            label="Pengeluaran operasional"
            value={expenses}
            onChange={setExpenses}
          />
          <MoneyInput
            id="deposit"
            label="Setoran kasir (jual beli barang / ke owner)"
            value={deposit}
            onChange={setDeposit}
          />
          <MoneyInput
            id="settlement"
            label="Settlement (setel saldo)"
            value={settlement}
            onChange={setSettlement}
          />
          <MoneyInput
            id="owner-withdrawal"
            label="Penarikan owner (uang dibawa/ditransfer owner)"
            value={withdrawal}
            onChange={setWithdrawal}
            hint="Uang yang diambil owner dari outlet — jangan ditulis di Pengeluaran"
          />
        </div>
        <div className="space-y-1.5 pt-2">
          <Label htmlFor="expense-notes" className="text-xs font-medium text-muted-foreground">
            Rincian pengeluaran (listrik, parkir, bensin, …)
          </Label>
          <Input
            id="expense-notes"
            value={expenseNotes}
            maxLength={300}
            onChange={(e) => setExpenseNotes(e.target.value)}
            placeholder="Contoh: Listrik 50.000; parkir 5.000"
            className="transition-all focus-visible:ring-primary/50"
          />
        </div>
      </section>

      {/* Guard: top-up PPOB jangan dihitung ganda di Pengeluaran */}
      {doubleCountRisk && (
        <div className="flex gap-2.5 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 backdrop-blur-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="text-xs">
            <p className="font-semibold text-warning">
              Ada top-up PPOB dan pengeluaran sekaligus — cek jangan sampai dihitung dua kali
            </p>
            <p className="mt-1 text-muted-foreground">
              Top-up saldo PPOB sudah dicatat di kolom <b>Penambahan saldo PPOB</b>. Uang top-up itu{" "}
              <b>tidak boleh</b> ditulis ulang di Pengeluaran, kecuali benar-benar biaya lain.
              Pengeluaran hanya untuk biaya operasional (bensin, listrik, parkir). Uang yang diambil
              owner masuk ke <b>Penarikan owner</b>, bukan Pengeluaran.
            </p>
          </div>
        </div>
      )}

      {/* Bank Machine Snapshot */}
      <section className="glass-card p-5 sm:p-6">
        <h2 className="text-base font-bold flex items-center gap-2">
          <Building2 className="size-4 text-digital" /> Detail saldo mesin (Bank)
        </h2>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {BANKS.map((b) => (
            <MoneyInput
              key={b}
              id={`bank-${b}`}
              label={b}
              value={banks[b] ?? ""}
              onChange={(v) => setBanks((prev) => ({ ...prev, [b]: v }))}
            />
          ))}
        </div>
      </section>

      {/* PPOB Snapshot */}
      <section className="glass-card p-5 sm:p-6">
        <h2 className="text-base font-bold flex items-center gap-2">
          <CreditCard className="size-4 text-accent" /> Detail saldo PPOB
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Saldo akhir tiap provider, dan total penambahan saldo PPOB selama shift.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {PPOB_PROVIDERS.map((p) => (
            <MoneyInput
              key={p}
              id={`ppob-${p}`}
              label={p}
              value={ppob[p] ?? ""}
              onChange={(v) => setPpob((prev) => ({ ...prev, [p]: v }))}
            />
          ))}
        </div>
        <div className="mt-4 border-t border-border/40 pt-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <MoneyInput
              id="topup"
              label="Penambahan saldo PPOB"
              value={topup}
              onChange={setTopup}
              hint="Total saldo PPOB yang ditambahkan selama shift"
            />
          </div>
        </div>
      </section>

      {/* Submit Button */}
      <Button type="submit" size="lg" disabled={close.isPending} className="w-full sm:w-auto">
        {close.isPending ? (
          <Loader2 className="mr-2 size-4 animate-spin" />
        ) : (
          <ClipboardCheck className="mr-2 size-4" />
        )}
        Tutup shift
      </Button>

      {/* Confirmation Glass Dialog */}
      {showConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-md"
          role="dialog"
          aria-modal="true"
          aria-labelledby="close-shift-confirm-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowConfirm(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setShowConfirm(false);
          }}
        >
          <div className="glass-card w-full max-w-md p-6 sm:p-8 text-center shadow-2xl">
            <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary/20 shadow-[0_0_20px_-3px] shadow-primary/30">
              <ClipboardCheck className="size-7 text-primary" />
            </div>
            <h2 id="close-shift-confirm-title" className="mt-5 font-display text-xl font-bold">
              Konfirmasi Tutup Shift
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Pastikan saldo tunai dan snapshot mesin sudah diisi dengan benar. Shift yang ditutup
              tidak dapat diubah.
            </p>
            <div className="mt-7 flex gap-3">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => setShowConfirm(false)}
              >
                Batal
              </Button>
              <Button className="flex-1" disabled={close.isPending} onClick={() => close.mutate()}>
                {close.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                Ya, Tutup Shift
              </Button>
            </div>
          </div>
        </div>
      )}
    </form>
  );
}
