import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  Loader2,
  ClipboardCheck,
  CreditCard,
  Building2,
  ArrowRight,
  DollarSign,
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
          "Penutupan shift: saldo fisik akhir, pengeluaran, permintaan top-up, saldo bank dan PPOB, serta setoran kasir.",
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
  const [banks, setBanks] = useState<Record<string, string>>({});
  const [ppob, setPpob] = useState<Record<string, string>>({});
  const [showConfirm, setShowConfirm] = useState(false);
  const submittingRef = useRef(false);

  const finalCashValue = num(finalCash);
  const depositValue = num(deposit);
  const depositExceedsCash = finalCash !== "" && depositValue > finalCashValue;

  const close = useMutation({
    mutationFn: async () => {
      if (submittingRef.current) throw new Error(IN_FLIGHT);
      submittingRef.current = true;
      if (!shiftId) throw new Error("Tidak ada shift aktif");
      if (finalCash === "") throw new Error("Saldo fisik akhir wajib diisi");
      if (Number(finalCash) < 0) throw new Error("Saldo fisik akhir tidak boleh negatif");
      if (Number(deposit || 0) < 0) throw new Error("Setoran tidak boleh negatif");
      if (Number(settlement || 0) < 0) throw new Error("Settlement tidak boleh negatif");
      if (Number(additionalCapital || 0) < 0) throw new Error("Modal tambahan tidak boleh negatif");
      // Saldo fisik akhir dihitung sebelum uang diserahkan ke owner, jadi setoran
      // tidak mungkin melebihi isi laci.
      if (depositExceedsCash)
        throw new Error(
          `Setoran (${rupiah(depositValue)}) melebihi saldo fisik akhir (${rupiah(finalCashValue)})`,
        );

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
            label="Saldo Fisik Akhir"
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
          <MoneyInput id="deposit" label="Setoran ke owner" value={deposit} onChange={setDeposit} />
          <MoneyInput
            id="settlement"
            label="Settlement (setel saldo)"
            value={settlement}
            onChange={setSettlement}
          />
        </div>
        {depositExceedsCash && (
          <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs font-medium text-destructive">
            Setoran {rupiah(depositValue)} melebihi saldo fisik akhir {rupiah(finalCashValue)}.
            Hitung saldo fisik akhir sebelum uang diserahkan ke owner.
          </p>
        )}
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
      <Button
        type="submit"
        size="lg"
        disabled={close.isPending || depositExceedsCash}
        className="w-full sm:w-auto"
      >
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
