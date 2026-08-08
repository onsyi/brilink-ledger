import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Loader2,
  ClipboardCheck,
  TriangleAlert,
  CheckCircle2,
  Wallet,
  TrendingUp,
  CreditCard,
  Building2,
  ArrowRight,
  Sparkles,
  DollarSign,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/MoneyInput";
import { BANKS, PPOB_PROVIDERS, expectedCash, num, rupiah, summarize } from "@/lib/ledger";

export const Route = createFileRoute("/_authenticated/close-shift")({
  head: () => ({
    meta: [
      { title: "Tutup Shift — Kasir BRILink" },
      {
        name: "description",
        content:
          "Penutupan shift: saldo fisik akhir, pengeluaran, permintaan top-up, saldo bank dan PPOB, serta setoran kasir.",
      },
      { property: "og:title", content: "Tutup Shift — Kasir BRILink" },
      {
        property: "og:description",
        content: "Kalkulasi expected balance dan peringatan selisih kas otomatis.",
      },
    ],
  }),
  component: CloseShift,
});

function CloseShift() {
  const { user, role, loading: authLoading } = useAuth();
  const userId = user?.id;
  const isOwner = role === "owner";
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const shiftQuery = useQuery({
    queryKey: ["open-shift", userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shifts")
        .select("id, user_id, start_time, initial_physical_balance, status")
        .eq("user_id", userId!)
        .eq("status", "open")
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const shiftId = shiftQuery.data?.id;

  const txns = useQuery({
    queryKey: ["txns", shiftId],
    enabled: !!shiftId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("transactions")
        .select(
          "transaction_type, source_account, destination_account, principal_amount, customer_fee, provider_cost, profit_net",
        )
        .eq("shift_id", shiftId!);
      if (error) throw error;
      return data ?? [];
    },
  });

  const pendingReceivables = useQuery({
    queryKey: ["pending-receivables", shiftId],
    enabled: !!shiftId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("receivables")
        .select("debt_amount")
        .eq("shift_id", shiftId!)
        .eq("status", "pending");
      if (error) throw error;
      return (data ?? []).reduce((sum, r) => sum + num(r.debt_amount), 0);
    },
  });

  const [finalCash, setFinalCash] = useState("");
  const [expenses, setExpenses] = useState("");
  const [expenseNotes, setExpenseNotes] = useState("");
  const [topup, setTopup] = useState("");
  const [deposit, setDeposit] = useState("");
  const [banks, setBanks] = useState<Record<string, string>>({});
  const [ppob, setPpob] = useState<Record<string, string>>({});
  const [showConfirm, setShowConfirm] = useState(false);
  const submittingRef = useRef(false);

  const summary = useMemo(() => summarize(txns.data ?? []), [txns.data]);
  const pendingDebt = pendingReceivables.data ?? 0;

  const expected = shiftQuery.data
    ? expectedCash({
        initial: num(shiftQuery.data.initial_physical_balance),
        cashNet: summary.cashNet,
        pendingReceivables: pendingDebt,
        expenses: Number(expenses || 0),
      })
    : 0;
  const variance = Number(finalCash || 0) - expected;
  const depositMismatch = Number(deposit || 0) > Number(finalCash || 0);

  const close = useMutation({
    mutationFn: async () => {
      if (submittingRef.current) throw new Error("Sedang diproses");
      submittingRef.current = true;
      if (!shiftId) throw new Error("Tidak ada shift aktif");
      if (finalCash === "") throw new Error("Saldo fisik akhir wajib diisi");
      if (Number(finalCash) < 0) throw new Error("Saldo fisik akhir tidak boleh negatif");
      if (depositMismatch) throw new Error("Setoran tidak boleh melebihi saldo fisik akhir");
      if (Number(deposit || 0) < 0) throw new Error("Setoran tidak boleh negatif");

      const bankRows = BANKS.map((b) => ({
        shift_id: shiftId,
        bank_name: b,
        final_amount: Number(banks[b] || 0),
      }));
      const ppobRows = PPOB_PROVIDERS.map((p) => ({
        shift_id: shiftId,
        provider_name: p,
        final_amount: Number(ppob[p] || 0),
      }));

      const [bankRes, ppobRes] = await Promise.all([
        supabase.from("bank_balances").upsert(bankRows, { onConflict: "shift_id,bank_name" }),
        supabase.from("ppob_balances").upsert(ppobRows, { onConflict: "shift_id,provider_name" }),
      ]);
      if (bankRes.error) throw bankRes.error;
      if (ppobRes.error) throw ppobRes.error;

      const { error } = await supabase
        .from("shifts")
        .update({
          final_physical_balance: Number(finalCash || 0),
          total_expenses: Number(expenses || 0),
          expense_notes: expenseNotes.trim() || null,
          topup_request: Number(topup || 0),
          deposit_amount: Number(deposit || 0),
          end_time: new Date().toISOString(),
          status: "closed",
        })
        .eq("id", shiftId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Shift ditutup dan terkunci");
      queryClient.invalidateQueries({ queryKey: ["open-shift"] });
      queryClient.invalidateQueries({ queryKey: ["deposit-shifts"] });
      navigate({ to: "/reports" });
    },
    onError: (e: Error) => {
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

      {/* Overview Cards */}
      <div className="responsive-grid-3">
        <div className="ledger-card p-5">
          <p className="text-xs font-medium text-muted-foreground">Expected balance (sistem)</p>
          <p className="num mt-2 text-xl font-bold gradient-text-gold sm:text-2xl">
            {rupiah(expected)}
          </p>
        </div>
        <div className="ledger-card p-5">
          <p className="text-xs font-medium text-muted-foreground">Laba bersih shift</p>
          <p className="num mt-2 text-xl font-bold gradient-text-emerald sm:text-2xl">
            {rupiah(summary.profit)}
          </p>
        </div>
        <div className="ledger-card p-5">
          <p className="text-xs font-medium text-muted-foreground">Piutang belum lunas</p>
          <p className="num mt-2 text-xl font-bold text-warning sm:text-2xl">
            {rupiah(pendingDebt)}
          </p>
        </div>
      </div>

      {/* Main Inputs */}
      <section className="glass-card p-5 sm:p-6 space-y-4">
        <h2 className="text-base font-bold flex items-center gap-2">
          <DollarSign className="size-4 text-primary" /> Kas Fisik & Pengeluaran Shift
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <MoneyInput
            id="final-cash"
            label="Saldo Fisik Akhir"
            value={finalCash}
            onChange={setFinalCash}
            required
          />
          <MoneyInput
            id="expenses"
            label="Pengeluaran operasional"
            value={expenses}
            onChange={setExpenses}
          />
          <MoneyInput
            id="topup"
            label="Permintaan top-up saldo"
            value={topup}
            onChange={setTopup}
          />
          <MoneyInput id="deposit" label="Setoran ke owner" value={deposit} onChange={setDeposit} />
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

      {/* Variance & Validation Badges */}
      {finalCash !== "" &&
        (Math.abs(variance) > 500 ? (
          <div className="flex items-center gap-3 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3.5 text-sm backdrop-blur-sm">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-destructive/20">
              <TriangleAlert className="size-5 text-destructive" />
            </div>
            <span>
              Selisih (variance){" "}
              <span className="font-bold text-destructive num">{rupiah(variance)}</span> antara
              saldo sistem dan kas fisik. Periksa transaksi sebelum menutup shift.
            </span>
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-2xl border border-success/40 bg-success/10 px-4 py-3.5 text-sm backdrop-blur-sm">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-success/20">
              <CheckCircle2 className="size-5 text-success" />
            </div>
            <span className="font-medium text-success">
              Saldo kas fisik cocok sempurna dengan sistem.
            </span>
          </div>
        ))}

      {depositMismatch && (
        <div className="flex items-center gap-3 rounded-2xl border border-destructive/40 bg-destructive/10 px-4 py-3.5 text-sm backdrop-blur-sm">
          <TriangleAlert className="size-5 shrink-0 text-destructive" />
          <span className="text-destructive font-medium">
            Setoran tidak boleh melebihi saldo fisik akhir.
          </span>
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
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
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
              Pastikan semua saldo fisik dan snapshot mesin sudah diisi dengan benar. Shift yang
              ditutup tidak dapat diubah.
            </p>
            {variance !== 0 && (
              <p className="mt-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive num">
                Selisih kas: {rupiah(variance)}
              </p>
            )}
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
