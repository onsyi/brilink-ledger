import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
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
  Undo2,
  Receipt,
  Plus,
  Trash2,
  HandCoins,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/MoneyInput";
import { OwnerOverview } from "@/components/OwnerOverview";
import { BANKS, modalAwal, num, PPOB_PROVIDERS, rupiah, summarize } from "@/lib/ledger";
import {
  openShiftQuery,
  pendingReceivablesQuery,
  txnsQuery,
  type OpenShiftRow,
} from "@/lib/queries";
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

  // Saldo bank/PPOB menempel pada cabang, bukan pada kasir -- shift kedua di
  // outlet yang sama harus melanjutkan angka penutupan shift pertama meski yang
  // jaga orang lain. RLS shifts_select hanya membuka baris milik sendiri, jadi
  // snapshot-nya diambil lewat RPC yang menentukan cabang dari profil pemanggil.
  const lastShift = useQuery({
    queryKey: ["last-closed-shift", branchId ?? userId],
    enabled: !!userId,
    staleTime: 0,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("last_closed_shift_balances");
      if (error) throw error;
      if (!data) return null;
      return {
        shift: data.shift,
        banks: data.banks ?? [],
        ppob: data.ppob ?? [],
      };
    },
  });

  useEffect(() => {
    // Menunggu query selesai *dan* berhasil. Hydrating saat error akan mengunci
    // form pada nilai kosong: `hydrated` sekali true tidak pernah dibuka lagi,
    // jadi refetch yang berhasil tidak akan mengisi ulang kolomnya.
    if (hydrated || lastShift.isPending || lastShift.isError) return;
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
  }, [hydrated, lastShift.isPending, lastShift.isError, lastShift.data]);

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
      if (Number(initial || 0) < 0) {
        throw new Error("Saldo Tunai Awal Buka Kasir tidak boleh negatif");
      }
      for (const b of BANKS) {
        if (Number(banks[b] || 0) < 0) {
          throw new Error(`Saldo awal ${b} tidak boleh negatif`);
        }
      }
      for (const p of PPOB_PROVIDERS) {
        if (Number(ppob[p] || 0) < 0) {
          throw new Error(`Saldo awal ${p} tidak boleh negatif`);
        }
      }

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
      queryClient.invalidateQueries({ queryKey: ["last-closed-shift"] });
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

  // Kalau shift sebelumnya ditutup kasir lain, sebutkan namanya: angka yang
  // muncul di form bukan bekas ketikan sendiri, jadi serah terimanya harus
  // terbaca -- itu yang menentukan siapa yang ditanya kalau saldonya meleset.
  const prevShift = lastShift.data?.shift;
  const handoverBy = prevShift && !prevShift.is_own ? prevShift.closed_by : null;
  const carryNote = lastShift.data
    ? handoverBy
      ? `Terkunci ke saldo akhir shift ${handoverBy}.`
      : "Terkunci ke saldo akhir shift sebelumnya."
    : "Isi manual hanya untuk shift pertama kali.";

  // Cermin dari assert_opening_continuity(): akun yang punya saldo akhir di
  // shift sebelumnya wajib dibuka dengan angka yang sama. Database tetap yang
  // menolak -- ini cuma supaya kasir tahu sebelum menekan tombol, bukan lewat
  // toast merah sesudahnya. Menunggu `hydrated` agar form yang masih kosong
  // tidak dibaca sebagai selisih.
  const carriedBank = new Map(
    (lastShift.data?.banks ?? []).map((b) => [b.bank_name, num(b.final_amount)]),
  );
  const carriedPpob = new Map(
    (lastShift.data?.ppob ?? []).map((p) => [p.provider_name, num(p.final_amount)]),
  );
  const lockedMismatch = !hydrated
    ? []
    : [
        ...BANKS.filter((b) => carriedBank.has(b) && num(banks[b]) !== carriedBank.get(b)).map(
          (b) => `${b} harus ${rupiah(carriedBank.get(b))}`,
        ),
        ...PPOB_PROVIDERS.filter(
          (p) => carriedPpob.has(p) && num(ppob[p]) !== carriedPpob.get(p),
        ).map((p) => `${p} harus ${rupiah(carriedPpob.get(p))}`),
      ];

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
            <p className="mt-1 text-xs text-muted-foreground">{carryNote}</p>
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
            <p className="mt-1 text-xs text-muted-foreground">{carryNote}</p>
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

          {lockedMismatch.length > 0 && (
            <div className="flex gap-2.5 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="text-xs">
                <p className="font-semibold text-destructive">
                  Saldo awal tidak cocok dengan penutupan shift sebelumnya
                </p>
                <p className="mt-1 text-muted-foreground">{lockedMismatch.join(", ")}.</p>
                <p className="mt-1 text-muted-foreground">
                  Kalau angka penutupan itu yang keliru, minta owner mengauditnya lebih dulu — shift
                  tidak bisa dibuka dengan angka yang berbeda.
                </p>
              </div>
            </div>
          )}

          <div className="space-y-2 rounded-xl border border-primary/25 bg-primary/10 px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Saldo Awal (Kas fisik + Bank)</span>
              <span className="num text-sm font-semibold">{rupiah(fisikBankTotal)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Saldo PPOB (Berdiri sendiri)</span>
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
              Snapshot penutupan terakhir di cabang ini
              {handoverBy ? ` oleh ${handoverBy}` : ""}. Terisi otomatis ke form di samping.
            </p>
          </div>
        </div>
        {lastShift.isError ? (
          <QueryError onRetry={() => lastShift.refetch()} />
        ) : lastShift.isPending ? (
          <div className="mt-6 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Memuat…
          </div>
        ) : !lastShift.data ? (
          <p className="mt-6 rounded-xl border border-border/60 bg-secondary/30 px-4 py-3 text-sm text-muted-foreground">
            Belum ada shift tertutup di cabang ini. Snapshot tersedia setelah shift pertama ditutup.
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
      if (Number(initial || 0) < 0) {
        throw new Error("Saldo Tunai Awal Buka Kasir tidak boleh negatif");
      }
      for (const b of BANKS) {
        if (Number(banks[b] || 0) < 0) {
          throw new Error(`Saldo awal ${b} tidak boleh negatif`);
        }
      }
      for (const p of PPOB_PROVIDERS) {
        if (Number(ppob[p] || 0) < 0) {
          throw new Error(`Saldo awal ${p} tidak boleh negatif`);
        }
      }

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
          {!shift.rejected_at && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCancel(true)}
              className="border-destructive/40 text-destructive hover:bg-destructive/10"
            >
              <XCircle className="mr-1.5 size-4" /> Batalkan shift
            </Button>
          )}
          <Button asChild size="sm">
            <Link to="/close-shift">
              Tutup shift <ArrowRight className="ml-1 size-4" />
            </Link>
          </Button>
        </div>
      </div>

      {/* Laporan yang dikembalikan owner. Alasannya menempel di baris shift --
          bukan di shift_amendments, yang RLS-nya hanya membuka baris milik
          penulisnya sendiri, yaitu owner. */}
      {shift.rejected_at && (
        <div className="flex flex-wrap items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 backdrop-blur-sm">
          <Undo2 className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-[16rem] flex-1 text-xs">
            <p className="font-semibold text-destructive">
              Laporan penutupan shift ini ditolak owner —{" "}
              {new Date(shift.rejected_at).toLocaleString("id-ID")}
            </p>
            {shift.rejection_reason && (
              <p className="mt-1 italic text-muted-foreground">“{shift.rejection_reason}”</p>
            )}
            <p className="mt-1 text-muted-foreground">
              Shift terbuka lagi dengan modal awal yang sama. Perbaiki angka penutupannya di Tutup
              Shift — isian lama Anda sudah dimuat di sana.
            </p>
          </div>
          <Button
            asChild
            size="sm"
            variant="outline"
            className="border-destructive/40 text-destructive hover:bg-destructive/10"
          >
            <Link to="/close-shift">Perbaiki laporan</Link>
          </Button>
        </div>
      )}

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

      <TransactionPanel shiftId={shiftId} />
      <ReceivablesPanel userId={shift.user_id} />

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

type TxnType = "tarik_tunai" | "setor_tunai" | "transfer" | "ppob";

const TYPE_LABEL: Record<TxnType, string> = {
  tarik_tunai: "Tarik Tunai",
  setor_tunai: "Setor Tunai",
  transfer: "Transfer",
  ppob: "PPOB",
};

/** Preset pergerakan akun per jenis — contoh README: Tarik Tunai = digital → kas fisik. */
const TYPE_PRESET: Record<TxnType, { source: string; dest: string }> = {
  tarik_tunai: { source: "BRI D", dest: "kas_fisik" },
  setor_tunai: { source: "kas_fisik", dest: "BRI D" },
  transfer: { source: "BRI D", dest: "Link" },
  ppob: { source: "Digipost", dest: "kas_fisik" },
};

const ACCOUNT_GROUPS: { label: string; options: { value: string; label: string }[] }[] = [
  { label: "Kas", options: [{ value: "kas_fisik", label: "Kas Fisik" }] },
  { label: "Bank", options: BANKS.map((b) => ({ value: b, label: b })) },
  { label: "PPOB", options: PPOB_PROVIDERS.map((p) => ({ value: p, label: p })) },
];

const accountLabel = (a: string) => (a === "kas_fisik" ? "Kas Fisik" : a);

const txnSelectCls =
  "h-10 w-full rounded-lg border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30";

function TransactionPanel({ shiftId }: { shiftId: string }) {
  const queryClient = useQueryClient();
  const txns = useQuery(txnsQuery(shiftId));
  const [type, setType] = useState<TxnType>("tarik_tunai");
  const [source, setSource] = useState<string>(TYPE_PRESET.tarik_tunai.source);
  const [dest, setDest] = useState<string>(TYPE_PRESET.tarik_tunai.dest);
  const [principal, setPrincipal] = useState("");
  const [fee, setFee] = useState("");
  const [cost, setCost] = useState("");
  const [note, setNote] = useState("");
  const [isDebt, setIsDebt] = useState(false);
  const [debtor, setDebtor] = useState("");
  const [debtAmount, setDebtAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  // Idempotency: satu client_ref per entri, dibuat ulang setelah tersimpan —
  // klik ganda/retry tidak menduplikasi baris (unique index shift_id+client_ref).
  const clientRef = useRef(crypto.randomUUID());

  const summary = useMemo(() => summarize(txns.data ?? []), [txns.data]);

  const changeType = (t: TxnType) => {
    setType(t);
    setSource(TYPE_PRESET[t].source);
    setDest(TYPE_PRESET[t].dest);
  };

  const resetInputs = () => {
    setPrincipal("");
    setFee("");
    setCost("");
    setNote("");
    setIsDebt(false);
    setDebtor("");
    setDebtAmount("");
    setDueDate("");
  };

  const add = useMutation({
    mutationFn: async () => {
      if (source === dest) throw new Error("Akun sumber dan tujuan tidak boleh sama");
      if (num(principal) <= 0) throw new Error("Nominal pokok wajib diisi");
      if (num(fee) < 0 || num(cost) < 0) throw new Error("Fee dan biaya tidak boleh negatif");
      if (isDebt && !debtor.trim()) throw new Error("Nama customer piutang wajib diisi");
      const { data, error } = await supabase
        .from("transactions")
        .insert({
          shift_id: shiftId,
          transaction_type: type,
          source_account: source,
          destination_account: dest,
          principal_amount: num(principal),
          customer_fee: num(fee),
          provider_cost: num(cost),
          note: note.trim() || null,
          client_ref: clientRef.current,
        })
        .select("id")
        .single();
      if (error) {
        // Idempotency: baris dengan client_ref sama sudah ada — bukan error bagi kasir.
        if ((error as { code?: string }).code === "23505") return { duplicate: true as const };
        throw error;
      }
      if (isDebt) {
        const { error: recvErr } = await supabase.from("receivables").insert({
          transaction_id: data.id,
          shift_id: shiftId,
          customer_name: debtor.trim(),
          debt_amount: num(debtAmount) > 0 ? num(debtAmount) : num(principal),
          due_date: dueDate || null,
        });
        if (recvErr)
          throw new Error(
            `Transaksi tersimpan, tapi piutang gagal dicatat: ${recvErr.message}. Lapor ke owner untuk dicatat manual.`,
          );
      }
      return { duplicate: false as const };
    },
    onSuccess: (res) => {
      toast.success(
        res.duplicate ? "Transaksi ini sudah tersimpan — tidak diduplikasi" : "Transaksi tercatat",
      );
      resetInputs();
      clientRef.current = crypto.randomUUID();
      queryClient.invalidateQueries({ queryKey: ["txns", shiftId] });
      queryClient.invalidateQueries({ queryKey: ["pending-receivables"] });
      queryClient.invalidateQueries({ queryKey: ["owner-overview"] });
      queryClient.invalidateQueries({ queryKey: ["shift-reports"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("transactions")
        .delete()
        .eq("id", id)
        .eq("shift_id", shiftId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Transaksi dihapus");
      queryClient.invalidateQueries({ queryKey: ["txns", shiftId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="glass-card space-y-5 p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 shadow-[0_0_15px_-3px] shadow-primary/20">
          <Receipt className="size-4 text-primary" />
        </div>
        <div>
          <h2 className="text-base font-bold">Catat Transaksi</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Tarik/setor tunai, transfer, dan PPOB — pergerakan dua kantong uang per transaksi.
          </p>
        </div>
      </div>

      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Jenis transaksi</Label>
            <select
              value={type}
              onChange={(e) => changeType(e.target.value as TxnType)}
              className={txnSelectCls}
            >
              {(Object.keys(TYPE_LABEL) as TxnType[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Catatan (opsional)</Label>
            <Input
              value={note}
              maxLength={200}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Contoh: A/N Budi, token 100rb"
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Akun sumber</Label>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className={txnSelectCls}
            >
              {ACCOUNT_GROUPS.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">Akun tujuan</Label>
            <select value={dest} onChange={(e) => setDest(e.target.value)} className={txnSelectCls}>
              {ACCOUNT_GROUPS.map((g) => (
                <optgroup key={g.label} label={g.label}>
                  {g.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <MoneyInput
            id="txn-principal"
            label="Nominal pokok"
            value={principal}
            onChange={setPrincipal}
            required
          />
          <MoneyInput id="txn-fee" label="Fee admin pelanggan" value={fee} onChange={setFee} />
          <MoneyInput id="txn-cost" label="Biaya provider" value={cost} onChange={setCost} />
        </div>

        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={isDebt}
            onChange={(e) => setIsDebt(e.target.checked)}
            className="accent-primary size-4"
          />
          Buat piutang (customer bayar nanti)
        </label>

        {isDebt && (
          <div className="grid gap-3 rounded-xl border border-warning/30 bg-warning/10 p-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Nama customer</Label>
              <Input
                value={debtor}
                maxLength={100}
                onChange={(e) => setDebtor(e.target.value)}
                placeholder="Nama pembeli"
              />
            </div>
            <MoneyInput
              id="debt-amount"
              label="Nominal piutang"
              value={debtAmount}
              onChange={setDebtAmount}
              hint="Kosong = sama dengan nominal pokok"
            />
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground">Janji bayar</Label>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
          </div>
        )}

        <Button type="submit" size="sm" disabled={add.isPending}>
          {add.isPending ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <Plus className="mr-1.5 size-4" />
          )}
          Simpan transaksi
        </Button>
      </form>

      <div className="border-t border-border/40 pt-4">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs">
          <span className="text-muted-foreground">
            Transaksi: <b className="num text-foreground">{summary.count}</b>
          </span>
          <span className="text-muted-foreground">
            Kas masuk: <b className="num text-success">{rupiah(summary.cashIn)}</b>
          </span>
          <span className="text-muted-foreground">
            Kas keluar: <b className="num text-destructive">{rupiah(summary.cashOut)}</b>
          </span>
          <span className="text-muted-foreground">
            Net kas: <b className="num text-foreground">{rupiah(summary.cashNet)}</b>
          </span>
          <span className="text-muted-foreground">
            Laba bersih: <b className="num text-success">{rupiah(summary.profit)}</b>
          </span>
        </div>

        {txns.isError ? (
          <div className="mt-3">
            <QueryError onRetry={() => txns.refetch()} />
          </div>
        ) : txns.isPending ? (
          <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Memuat…
          </p>
        ) : (txns.data ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">Belum ada transaksi di shift ini.</p>
        ) : (
          <div className="mt-3 overflow-x-auto hide-scrollbar">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border/60 text-left text-[10px] font-bold tracking-widest text-muted-foreground uppercase">
                  <th className="pb-2">Waktu</th>
                  <th className="pb-2">Jenis</th>
                  <th className="pb-2">Pergerakan</th>
                  <th className="pb-2 text-right">Pokok</th>
                  <th className="pb-2 text-right">Fee</th>
                  <th className="pb-2 text-right">Biaya</th>
                  <th className="pb-2 text-right">Laba</th>
                  <th className="pb-2" />
                </tr>
              </thead>
              <tbody className="num">
                {(txns.data ?? []).map((t) => (
                  <tr key={t.id} className="border-b border-border/30 hover:bg-secondary/30">
                    <td className="py-2 text-xs">
                      {new Date(t.created_at).toLocaleTimeString("id-ID", {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="py-2 text-xs font-semibold">
                      {TYPE_LABEL[t.transaction_type as TxnType] ?? t.transaction_type}
                    </td>
                    <td className="py-2 text-xs text-muted-foreground">
                      {accountLabel(t.source_account)} → {accountLabel(t.destination_account)}
                      {t.note ? ` · ${t.note}` : ""}
                    </td>
                    <td className="py-2 text-right">{rupiah(t.principal_amount)}</td>
                    <td className="py-2 text-right text-success">{rupiah(t.customer_fee)}</td>
                    <td className="py-2 text-right text-destructive">{rupiah(t.provider_cost)}</td>
                    <td className="py-2 text-right font-semibold">{rupiah(num(t.profit_net))}</td>
                    <td className="py-2 text-right">
                      <button
                        onClick={() => remove.mutate(t.id)}
                        disabled={remove.isPending}
                        title="Hapus (salah input) — hanya selama shift terbuka"
                        className="inline-flex items-center rounded-lg border border-destructive/30 px-1.5 py-1 text-destructive transition-colors hover:bg-destructive/10"
                      >
                        <Trash2 className="size-3" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * Piutang belum lunas milik kasir — lintas shift: pelunasan sah kapan pun
 * (RLS recv_update memakai shift_is_readable), tapi nominal terkunci setelah
 * shift pembukanya ditutup.
 */
function ReceivablesPanel({ userId }: { userId: string }) {
  const queryClient = useQueryClient();
  const pend = useQuery(pendingReceivablesQuery(userId));

  const markPaid = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("receivables")
        .update({ status: "paid" })
        .eq("id", id)
        .eq("status", "pending");
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Piutang ditandai lunas");
      queryClient.invalidateQueries({ queryKey: ["pending-receivables"] });
      queryClient.invalidateQueries({ queryKey: ["shift-reports"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = pend.data ?? [];
  const total = rows.reduce((s, r) => s + num(r.debt_amount), 0);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <section className="glass-card p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-warning/15">
          <HandCoins className="size-4 text-warning" />
        </div>
        <div>
          <h2 className="text-base font-bold">Piutang Belum Lunas</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Modal kerja yang tertahan di pelanggan — tandai lunas saat uangnya diterima.
          </p>
        </div>
      </div>

      {pend.isError ? (
        <div className="mt-4">
          <QueryError onRetry={() => pend.refetch()} />
        </div>
      ) : pend.isPending ? (
        <p className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Memuat…
        </p>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground">Tidak ada piutang menunggu.</p>
      ) : (
        <>
          <p className="num mt-4 text-lg font-bold text-warning">
            Total: {rupiah(total)} · {rows.length} piutang
          </p>
          <ul className="mt-3 space-y-2">
            {rows.map((r) => {
              const overdue = !!r.due_date && r.due_date < today;
              return (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border/40 bg-secondary/20 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-semibold">
                      {r.customer_name}
                      {overdue && (
                        <span className="ml-2 inline-flex items-center rounded-full border border-destructive/30 bg-destructive/15 px-1.5 py-0.5 text-[9px] font-bold text-destructive">
                          lewat tempo
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {r.due_date
                        ? `Janji bayar ${new Date(r.due_date).toLocaleDateString("id-ID")}`
                        : "Tanpa tanggal janji"}
                      {r.shift_start_time
                        ? ` · shift ${new Date(r.shift_start_time).toLocaleDateString("id-ID")}`
                        : ""}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="num text-sm font-bold">{rupiah(r.debt_amount)}</span>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={markPaid.isPending}
                      onClick={() => markPaid.mutate(r.id)}
                    >
                      Tandai lunas
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
