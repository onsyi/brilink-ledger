import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, ClipboardCheck, TriangleAlert, CheckCircle2 } from "lucide-react";
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
        .select("*")
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
        .select("*")
        .eq("shift_id", shiftId!);
      if (error) throw error;
      return data ?? [];
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

  const summary = useMemo(() => summarize(txns.data ?? []), [txns.data]);
  const pendingDebt = 0;

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
      if (!shiftId) throw new Error("Tidak ada shift aktif");
      if (finalCash === "") throw new Error("Saldo fisik akhir wajib diisi");
      if (depositMismatch) throw new Error("Setoran tidak boleh melebihi saldo fisik akhir");

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
    onError: (e: Error) => toast.error(e.message),
  });

  if (isOwner)
    return (
      <div className="ledger-card max-w-xl p-6">
        <h1 className="text-lg font-semibold">Owner tidak menjalankan shift</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Buka dan tutup shift hanya dilakukan kasir/teller. Sebagai owner, pantau hasilnya di
          ringkasan dan laporan.
        </p>
        <div className="mt-5 flex gap-2">
          <Button asChild variant="secondary">
            <Link to="/dashboard">Ringkasan owner</Link>
          </Button>
          <Button asChild variant="secondary">
            <Link to="/reports">Laporan & audit</Link>
          </Button>
        </div>
      </div>
    );

  if (authLoading || shiftQuery.isLoading)
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Memuat…
      </p>
    );

  if (!shiftQuery.data)
    return (
      <div className="ledger-card p-6">
        <h1 className="text-lg font-semibold">Tidak ada shift aktif</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Buka shift terlebih dahulu sebelum melakukan penutupan.
        </p>
        <Button asChild className="mt-5">
          <Link to="/dashboard">Ke halaman shift</Link>
        </Button>
      </div>
    );

  return (
    <form
      className="space-y-5 sm:space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        setShowConfirm(true);
      }}
    >
      <div>
        <h1 className="text-lg font-semibold sm:text-xl">Tutup Shift</h1>
        <p className="text-sm text-muted-foreground">
          Validasi fisik, dokumentasi pengeluaran, dan snapshot saldo mesin.
        </p>
      </div>

      <div className="responsive-grid-3">
        <div className="ledger-card p-4">
          <p className="text-xs text-muted-foreground">Expected balance (sistem)</p>
          <p className="num mt-2 text-base font-semibold text-cash sm:text-lg">
            {rupiah(expected)}
          </p>
        </div>
        <div className="ledger-card p-4">
          <p className="text-xs text-muted-foreground">Laba bersih shift</p>
          <p className="num mt-2 text-base font-semibold text-success sm:text-lg">
            {rupiah(summary.profit)}
          </p>
        </div>
        <div className="ledger-card p-4">
          <p className="text-xs text-muted-foreground">Piutang belum lunas</p>
          <p className="num mt-2 text-base font-semibold text-warning sm:text-lg">
            {rupiah(pendingDebt)}
          </p>
        </div>
      </div>

      <section className="ledger-card grid gap-3 p-4 sm:grid-cols-2 sm:gap-4 sm:p-5 lg:grid-cols-4">
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
        <MoneyInput id="topup" label="Permintaan top-up saldo" value={topup} onChange={setTopup} />
        <MoneyInput id="deposit" label="Setoran ke owner" value={deposit} onChange={setDeposit} />
        <div className="space-y-1.5 sm:col-span-2 lg:col-span-4">
          <Label htmlFor="expense-notes" className="text-xs text-muted-foreground">
            Rincian pengeluaran (listrik, parkir, bensin, …)
          </Label>
          <Input
            id="expense-notes"
            value={expenseNotes}
            maxLength={300}
            onChange={(e) => setExpenseNotes(e.target.value)}
            placeholder="Listrik 50.000; parkir 5.000"
          />
        </div>
      </section>

      {finalCash !== "" &&
        (Math.abs(variance) > 0 ? (
          <p className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2.5 text-xs sm:px-4 sm:py-3 sm:text-sm">
            <TriangleAlert className="size-4 shrink-0 text-destructive" />
            <span>
              Selisih (variance) {rupiah(variance)} antara saldo sistem dan fisik. Periksa transaksi
              atau pengeluaran sebelum menutup shift.
            </span>
          </p>
        ) : (
          <p className="flex items-center gap-2 rounded-lg border border-success/50 bg-success/10 px-3 py-2.5 text-xs sm:px-4 sm:py-3 sm:text-sm">
            <CheckCircle2 className="size-4 shrink-0 text-success" /> Saldo fisik cocok dengan
            sistem.
          </p>
        ))}
      {depositMismatch && (
        <p className="flex items-center gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2.5 text-xs sm:px-4 sm:py-3 sm:text-sm">
          <TriangleAlert className="size-4 shrink-0 text-destructive" />
          Setoran melebihi saldo fisik akhir.
        </p>
      )}

      <section className="ledger-card p-4 sm:p-5">
        <h2 className="text-base font-semibold">Detail saldo mesin (Bank)</h2>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-3">
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

      <section className="ledger-card p-4 sm:p-5">
        <h2 className="text-base font-semibold">Detail saldo PPOB</h2>
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

      <Button type="submit" size="lg" disabled={close.isPending} className="w-full sm:w-auto">
        {close.isPending ? (
          <Loader2 className="mr-2 size-4 animate-spin" />
        ) : (
          <ClipboardCheck className="mr-2 size-4" />
        )}
        Tutup shift
      </Button>

      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="ledger-card w-full max-w-md p-6 text-center">
            <ClipboardCheck className="mx-auto size-8 text-primary" />
            <h2 className="mt-4 text-lg font-semibold">Konfirmasi Tutup Shift</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Pastikan semua data sudah benar. Shift yang ditutup tidak dapat diubah kecuali oleh
              owner.
            </p>
            {variance !== 0 && (
              <p className="mt-2 text-sm font-medium text-destructive">
                Selisih: {rupiah(variance)}
              </p>
            )}
            <div className="mt-6 flex gap-3">
              <Button
                type="button"
                variant="secondary"
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
