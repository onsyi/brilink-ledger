import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  PlayCircle,
  Loader2,
  ArrowRight,
  Banknote,
  CreditCard,
  TriangleAlert,
  Building2,
  Pencil,
  XCircle,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/MoneyInput";
import { OwnerOverview } from "@/components/OwnerOverview";
import { BANKS, modalAwal, num, PPOB_PROVIDERS, rupiah } from "@/lib/ledger";
import { openShiftQuery, type OpenShiftRow } from "@/lib/queries";
import { QueryError } from "@/components/QueryError";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Shift — Kasir BRILink" },
      { name: "description", content: "Buka shift, lihat ringkasan mutasi, dan tutup shift." },
      { property: "og:title", content: "Shift — Kasir BRILink" },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { user, role, loading, username, branchId } = useAuth();
  const userId = user?.id;
  const isOwner = role === "owner";

  const shiftQuery = useQuery(openShiftQuery(userId, !loading && !isOwner));

  if (loading) return <LoadingBlock />;
  if (isOwner) return <OwnerOverview username={username} />;
  if (shiftQuery.isError) return <QueryError onRetry={() => shiftQuery.refetch()} />;
  if (shiftQuery.isLoading) return <LoadingBlock />;
  if (!shiftQuery.data) return <OpenShiftPanel userId={userId} branchId={branchId} />;
  return <ActiveShiftPanel shiftId={shiftQuery.data.id} shift={shiftQuery.data} />;
}

function LoadingBlock() {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4">
      <div className="relative">
        <div className="absolute inset-0 rounded-full bg-primary/20 blur-xl" />
        <div className="relative flex size-14 items-center justify-center rounded-full border border-primary/20 bg-primary/10">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      </div>
      <p className="text-sm font-medium text-muted-foreground">Memuat data shift…</p>
    </div>
  );
}

function OpenShiftPanel({
  userId,
  branchId,
}: {
  userId?: string | undefined;
  branchId?: string | null;
}) {
  const queryClient = useQueryClient();
  const [initial, setInitial] = useState("");
  const [banks, setBanks] = useState<Record<string, string>>({});
  const [ppob, setPpob] = useState<Record<string, string>>({});
  const [hydrated, setHydrated] = useState(false);
  const isBranchMissing = !branchId;

  const lastShift = useQuery({
    queryKey: ["last-closed-shift", userId],
    enabled: !!userId,
    staleTime: 0,
    queryFn: async () => {
      const { data: shift } = await supabase
        .from("shifts")
        .select(
          "id, end_time, final_physical_balance, bank_balances(bank_name, final_amount), ppob_balances(provider_name, final_amount)",
        )
        .eq("user_id", userId!)
        .eq("status", "closed")
        .order("end_time", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!shift) return null;
      return {
        shift: {
          id: shift.id,
          end_time: shift.end_time,
          final_physical_balance: shift.final_physical_balance,
        },
        banks: (shift["bank_balances"] ?? []) as { bank_name: string; final_amount: number }[],
        ppob: (shift["ppob_balances"] ?? []) as { provider_name: string; final_amount: number }[],
      };
    },
  });

  useEffect(() => {
    if (hydrated || lastShift.isLoading) return;
    const prev = lastShift.data;
    const bankMap: Record<string, string> = {};
    for (const b of BANKS) {
      const prevBank = prev?.banks.find((x) => x.bank_name === b);
      bankMap[b] = prevBank ? String(num(prevBank.final_amount) || "") : "";
    }
    const ppobMap: Record<string, string> = {};
    for (const p of PPOB_PROVIDERS) {
      const prevPpob = prev?.ppob.find((x) => x.provider_name === p);
      ppobMap[p] = prevPpob ? String(num(prevPpob.final_amount) || "") : "";
    }
    setBanks(bankMap);
    setPpob(ppobMap);
    setHydrated(true);
  }, [hydrated, lastShift.isLoading, lastShift.data]);

  const openingTotal = modalAwal({
    initialPhysical: num(initial),
    bankInitials: BANKS.map((b) => num(banks[b])),
    ppobInitials: PPOB_PROVIDERS.map((p) => num(ppob[p])),
  });

  const bankInitialsTotal = BANKS.reduce((s, b) => s + num(banks[b]), 0);
  const ppobInitialsTotal = PPOB_PROVIDERS.reduce((s, p) => s + num(ppob[p]), 0);
  const fisikBankTotal = num(initial) + bankInitialsTotal;

  const openShift = useMutation({
    mutationFn: async () => {
      const bankSnapshots = BANKS.map((b) => ({
        bank_name: b,
        initial_amount: Number(banks[b] || 0),
      }));
      const ppobSnapshots = PPOB_PROVIDERS.map((p) => ({
        provider_name: p,
        initial_amount: Number(ppob[p] || 0),
      }));
      const { error } = await supabase.rpc("open_shift_atomic", {
        _user_id: userId!,
        _branch_id: branchId ?? null,
        _initial_cash: Number(initial || 0),
        _bank_snapshots: bankSnapshots,
        _ppob_snapshots: ppobSnapshots,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Shift dibuka");
      queryClient.invalidateQueries({ queryKey: ["open-shift", userId] });
      queryClient.invalidateQueries({ queryKey: ["last-closed-shift", userId] });
    },
    onError: (e: Error & { code?: string }) =>
      toast.error(
        e.code === "23505" || e.message.includes("duplicate") || e.message.includes("aktif")
          ? "Masih ada shift aktif di akun ini. Tutup dulu shift tersebut."
          : e.message,
      ),
  });

  const digitalCarry =
    (lastShift.data?.banks.reduce((s, b) => s + num(b.final_amount), 0) ?? 0) +
    (lastShift.data?.ppob.reduce((s, p) => s + num(p.final_amount), 0) ?? 0);

  return (
    <div className="grid gap-5 lg:grid-cols-[1.25fr_0.75fr]">
      {/* Open Shift Card */}
      <section className="glass-card glass-card-hover p-6 sm:p-8">
        <div className="flex items-start gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 shadow-[0_0_15px_-3px] shadow-primary/20">
            <PlayCircle className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold sm:text-2xl">Buka Shift</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Isi modal awal: kas fisik dan saldo rekening (dari shift sebelumnya).
            </p>
            {isBranchMissing && (
              <p className="mt-2 text-sm font-medium text-destructive">
                Akun Anda belum terdaftar di cabang manapun. Hubungi owner untuk assign cabang
                terlebih dahulu.
              </p>
            )}
          </div>
        </div>
        <form
          className="mt-6 space-y-5"
          onSubmit={(e) => {
            e.preventDefault();
            openShift.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <MoneyInput
              id="initial"
              label="Saldo Tunai Awal Buka Kasir"
              value={initial}
              onChange={setInitial}
              required
            />
          </div>

          <section className="rounded-xl border border-border/40 bg-secondary/20 p-4">
            <div className="flex items-center gap-2">
              <Building2 className="size-4 text-digital" />
              <h2 className="text-sm font-bold">Saldo awal rekening (Bank)</h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {lastShift.data
                ? "Terisi otomatis dari saldo akhir shift sebelumnya — bisa dikoreksi."
                : "Isi manual hanya untuk shift pertama kali."}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {BANKS.map((b) => (
                <MoneyInput
                  key={b}
                  id={`open-bank-${b}`}
                  label={b}
                  value={banks[b] ?? ""}
                  onChange={(v) => setBanks((prev) => ({ ...prev, [b]: v }))}
                />
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-border/40 bg-secondary/20 p-4">
            <div className="flex items-center gap-2">
              <CreditCard className="size-4 text-accent" />
              <h2 className="text-sm font-bold">Saldo awal PPOB</h2>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {lastShift.data
                ? "Terisi otomatis dari saldo akhir shift sebelumnya — bisa dikoreksi."
                : "Isi manual hanya untuk shift pertama kali."}
            </p>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {PPOB_PROVIDERS.map((p) => (
                <MoneyInput
                  key={p}
                  id={`open-ppob-${p}`}
                  label={p}
                  value={ppob[p] ?? ""}
                  onChange={(v) => setPpob((prev) => ({ ...prev, [p]: v }))}
                />
              ))}
            </div>
          </section>

          <div className="space-y-2 rounded-xl border border-primary/25 bg-primary/10 px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Kas fisik + Bank</span>
              <span className="num text-sm font-semibold">{rupiah(fisikBankTotal)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Saldo PPOB</span>
              <span className="num text-sm font-semibold">{rupiah(ppobInitialsTotal)}</span>
            </div>
          </div>

          <Button
            type="submit"
            className="w-full"
            size="lg"
            disabled={openShift.isPending || isBranchMissing}
          >
            {openShift.isPending ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <PlayCircle className="mr-2 size-4" />
            )}
            Mulai shift
          </Button>
        </form>
      </section>

      {/* Previous Shift Digital Balances */}
      <section className="ledger-card p-6 sm:p-8">
        <div className="flex items-start gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-digital/15">
            <CreditCard className="size-5 text-digital" />
          </div>
          <div>
            <h2 className="text-lg font-bold">Saldo digital sebelumnya</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Dari snapshot penutupan terakhir. Terisi otomatis ke form di samping.
            </p>
          </div>
        </div>
        {lastShift.isError ? (
          <QueryError onRetry={() => lastShift.refetch()} />
        ) : lastShift.isLoading ? (
          <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Memuat…
          </div>
        ) : !lastShift.data ? (
          <p className="mt-6 rounded-xl border border-border/60 bg-secondary/30 px-4 py-3 text-sm text-muted-foreground">
            Belum ada shift tertutup. Snapshot tersedia setelah shift pertama ditutup.
          </p>
        ) : (
          <>
            <p className="num mt-5 text-2xl font-bold gradient-text-cyan sm:text-3xl">
              {rupiah(digitalCarry)}
            </p>
            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <BalanceList title="Bank" rows={lastShift.data.banks} nameKey="bank_name" />
              <BalanceList title="PPOB" rows={lastShift.data.ppob} nameKey="provider_name" />
            </div>
            <div className="mt-4 flex items-center gap-2 rounded-lg border border-border/50 bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
              <Banknote className="size-3.5 shrink-0 text-cash" />
              <span className="num">
                Kas fisik akhir shift lalu: {rupiah(lastShift.data.shift.final_physical_balance)}
              </span>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function BalanceList({
  title,
  rows,
  nameKey,
}: {
  title: string;
  rows: Record<string, unknown>[];
  nameKey: string;
}) {
  return (
    <div className="rounded-xl border border-border/40 bg-secondary/20 p-3">
      <h3 className="text-[10px] font-bold tracking-widest text-muted-foreground uppercase">
        {title}
      </h3>
      <ul className="mt-2 space-y-1.5 text-sm">
        {rows.length === 0 && <li className="text-muted-foreground">—</li>}
        {rows.map((r) => (
          <li key={String(r[nameKey])} className="flex justify-between gap-3">
            <span className="text-muted-foreground">{String(r[nameKey])}</span>
            <span className="num font-medium">{rupiah(r["final_amount"] as number)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ActiveShiftPanel({ shiftId, shift }: { shiftId: string; shift: OpenShiftRow }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [initial, setInitial] = useState("");
  const [banks, setBanks] = useState<Record<string, string>>({});
  const [ppob, setPpob] = useState<Record<string, string>>({});

  const opening = useQuery({
    queryKey: ["shift-opening", shiftId],
    queryFn: async () => {
      const [bankRes, ppobRes] = await Promise.all([
        supabase.from("bank_balances").select("bank_name, initial_amount").eq("shift_id", shiftId),
        supabase
          .from("ppob_balances")
          .select("provider_name, initial_amount")
          .eq("shift_id", shiftId),
      ]);
      if (bankRes.error) throw bankRes.error;
      if (ppobRes.error) throw ppobRes.error;
      const bankMap: Record<string, number> = {};
      (bankRes.data ?? []).forEach((b) => (bankMap[b.bank_name] = num(b.initial_amount)));
      const ppobMap: Record<string, number> = {};
      (ppobRes.data ?? []).forEach((p) => (ppobMap[p.provider_name] = num(p.initial_amount)));
      return { bankMap, ppobMap };
    },
  });

  const startEditing = () => {
    const b: Record<string, string> = {};
    for (const name of BANKS) b[name] = String(opening.data?.bankMap[name] || "");
    const p: Record<string, string> = {};
    for (const name of PPOB_PROVIDERS) p[name] = String(opening.data?.ppobMap[name] || "");
    setInitial(String(num(shift.initial_physical_balance) || ""));
    setBanks(b);
    setPpob(p);
    setEditing(true);
  };

  const amend = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("amend_open_shift", {
        _shift_id: shiftId,
        _initial_cash: Number(initial || 0),
        _bank_snapshots: BANKS.map((b) => ({
          bank_name: b,
          initial_amount: Number(banks[b] || 0),
        })),
        _ppob_snapshots: PPOB_PROVIDERS.map((p) => ({
          provider_name: p,
          initial_amount: Number(ppob[p] || 0),
        })),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Modal awal diperbarui");
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["open-shift"] });
      queryClient.invalidateQueries({ queryKey: ["shift-opening", shiftId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const cancelShift = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.rpc("cancel_open_shift", { _shift_id: shiftId });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Shift dibatalkan — silakan buka ulang");
      setShowCancel(false);
      queryClient.invalidateQueries({ queryKey: ["open-shift"] });
      queryClient.invalidateQueries({ queryKey: ["last-closed-shift"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const editTotal = modalAwal({
    initialPhysical: num(initial),
    bankInitials: BANKS.map((b) => num(banks[b])),
    ppobInitials: PPOB_PROVIDERS.map((p) => num(ppob[p])),
  });

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-bold sm:text-2xl">
            <span className="relative flex size-2.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
              <span className="relative inline-flex size-2.5 rounded-full bg-success" />
            </span>
            Shift aktif
          </h1>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Dibuka {new Date(shift.start_time).toLocaleString("id-ID")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {!editing && (
            <Button variant="outline" size="sm" onClick={startEditing} disabled={opening.isLoading}>
              <Pencil className="mr-1.5 size-4" /> Perbaiki modal awal
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowCancel(true)}
            className="border-destructive/40 text-destructive hover:bg-destructive/10"
          >
            <XCircle className="mr-1.5 size-4" /> Batalkan shift
          </Button>
          <Button asChild size="sm">
            <Link to="/close-shift">
              Tutup shift <ArrowRight className="ml-1 size-4" />
            </Link>
          </Button>
        </div>
      </div>

      {opening.isError && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm backdrop-blur-sm">
          <TriangleAlert className="size-5 shrink-0 text-destructive" />
          <span className="text-muted-foreground">Gagal memuat modal awal shift ini.</span>
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => opening.refetch()}>
            Coba lagi
          </Button>
        </div>
      )}

      {editing ? (
        <form
          className="glass-card space-y-5 p-6 sm:p-8"
          onSubmit={(e) => {
            e.preventDefault();
            amend.mutate();
          }}
        >
          <div>
            <h2 className="text-lg font-bold">Perbaiki modal awal</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Koreksi angka yang salah diinput saat membuka shift. Perubahan tercatat dan bisa
              dilihat owner.
            </p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <MoneyInput
              id="edit-initial"
              label="Saldo Tunai Awal Buka Kasir"
              value={initial}
              onChange={setInitial}
              required
            />
          </div>

          <section className="rounded-xl border border-border/40 bg-secondary/20 p-4">
            <div className="flex items-center gap-2">
              <Building2 className="size-4 text-digital" />
              <h3 className="text-sm font-bold">Saldo awal rekening (Bank)</h3>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {BANKS.map((b) => (
                <MoneyInput
                  key={b}
                  id={`edit-bank-${b}`}
                  label={b}
                  value={banks[b] ?? ""}
                  onChange={(v) => setBanks((prev) => ({ ...prev, [b]: v }))}
                />
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-border/40 bg-secondary/20 p-4">
            <div className="flex items-center gap-2">
              <CreditCard className="size-4 text-accent" />
              <h3 className="text-sm font-bold">Saldo awal PPOB</h3>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
              {PPOB_PROVIDERS.map((p) => (
                <MoneyInput
                  key={p}
                  id={`edit-ppob-${p}`}
                  label={p}
                  value={ppob[p] ?? ""}
                  onChange={(v) => setPpob((prev) => ({ ...prev, [p]: v }))}
                />
              ))}
            </div>
          </section>

          <div className="flex items-center justify-between rounded-xl border border-primary/25 bg-primary/10 px-4 py-3">
            <span className="text-sm text-muted-foreground">Total modal awal</span>
            <span className="num text-sm font-semibold">{rupiah(editTotal)}</span>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button type="submit" disabled={amend.isPending}>
              {amend.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
              Simpan perbaikan
            </Button>
            <Button type="button" variant="outline" onClick={() => setEditing(false)}>
              Batal
            </Button>
          </div>
        </form>
      ) : (
        <section className="ledger-card p-6 sm:p-8">
          <h2 className="text-lg font-bold">Modal awal shift ini</h2>
          <p className="num mt-3 text-2xl font-bold gradient-text-gold sm:text-3xl">
            {rupiah(shift.modal_awal)}
          </p>
          <div className="mt-5 flex items-center justify-between rounded-lg border border-border/50 bg-secondary/30 px-3 py-2 text-sm">
            <span className="text-muted-foreground">Saldo Tunai Awal Buka Kasir</span>
            <span className="num font-medium">{rupiah(shift.initial_physical_balance)}</span>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <OpeningList title="Bank" entries={opening.data?.bankMap} names={BANKS} />
            <OpeningList title="PPOB" entries={opening.data?.ppobMap} names={PPOB_PROVIDERS} />
          </div>
        </section>
      )}

      {showCancel && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-md"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cancel-shift-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowCancel(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setShowCancel(false);
          }}
        >
          <div className="glass-card w-full max-w-md p-6 text-center sm:p-8">
            <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-destructive/20">
              <XCircle className="size-7 text-destructive" />
            </div>
            <h2 id="cancel-shift-title" className="mt-5 font-display text-xl font-bold">
              Batalkan Shift?
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Shift ini akan dihapus dan Anda kembali ke halaman buka shift. Pembatalan tercatat dan
              bisa dilihat owner.
            </p>
            <div className="mt-7 flex gap-3">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => setShowCancel(false)}
              >
                Tidak
              </Button>
              <Button
                variant="destructive"
                className="flex-1"
                disabled={cancelShift.isPending}
                onClick={() => cancelShift.mutate()}
              >
                {cancelShift.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                Ya, batalkan
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OpeningList({
  title,
  entries,
  names,
}: {
  title: string;
  entries: Record<string, number> | undefined;
  names: readonly string[];
}) {
  const rows = names.filter((n) => (entries?.[n] ?? 0) > 0);
  return (
    <div className="rounded-xl border border-border/40 bg-secondary/20 p-3">
      <h3 className="text-[10px] font-bold tracking-widest text-muted-foreground uppercase">
        {title}
      </h3>
      <ul className="mt-2 space-y-1.5 text-sm">
        {rows.length === 0 && <li className="text-muted-foreground">—</li>}
        {rows.map((n) => (
          <li key={n} className="flex justify-between gap-3">
            <span className="text-muted-foreground">{n}</span>
            <span className="num font-medium">{rupiah(entries?.[n] ?? 0)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
