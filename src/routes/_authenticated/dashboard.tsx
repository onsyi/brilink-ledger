import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { PlayCircle, Loader2, ArrowRight, WifiOff } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/MoneyInput";
import { OwnerOverview } from "@/components/OwnerOverview";
import { expectedCash, num, rupiah, summarize } from "@/lib/ledger";
import { isOnline } from "@/lib/offline-db";

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

  const shiftQuery = useQuery({
    queryKey: ["open-shift", userId],
    enabled: !!userId && !loading && !isOwner,
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

  if (loading) return <LoadingBlock />;
  if (isOwner) return <OwnerOverview username={username} />;
  if (shiftQuery.isLoading) return <LoadingBlock />;
  if (!shiftQuery.data) return <OpenShiftPanel userId={userId} branchId={branchId} />;
  return <ActiveShiftPanel shiftId={shiftQuery.data.id} shift={shiftQuery.data} />;
}

function LoadingBlock() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> Memuat data shift…
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

  const lastShift = useQuery({
    queryKey: ["last-closed-shift", userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data: shift } = await supabase
        .from("shifts")
        .select("id, end_time, final_physical_balance")
        .eq("user_id", userId!)
        .eq("status", "closed")
        .order("end_time", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!shift) return null;
      const [{ data: banks }, { data: ppob }] = await Promise.all([
        supabase.from("bank_balances").select("bank_name, final_amount").eq("shift_id", shift.id),
        supabase
          .from("ppob_balances")
          .select("provider_name, final_amount")
          .eq("shift_id", shift.id),
      ]);
      return { shift, banks: banks ?? [], ppob: ppob ?? [] };
    },
  });

  const openShift = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("shifts").insert({
        user_id: userId!,
        initial_physical_balance: Number(initial || 0),
        status: "open",
        branch_id: branchId ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Shift dibuka");
      queryClient.invalidateQueries({ queryKey: ["open-shift", userId] });
    },
    onError: (e: Error) =>
      toast.error(
        e.message.includes("duplicate")
          ? "Masih ada shift aktif di akun ini. Tutup dulu shift tersebut."
          : e.message,
      ),
  });

  const digitalCarry =
    (lastShift.data?.banks.reduce((s, b) => s + num(b.final_amount), 0) ?? 0) +
    (lastShift.data?.ppob.reduce((s, p) => s + num(p.final_amount), 0) ?? 0);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
      <section className="ledger-card p-5 sm:p-6">
        <h1 className="text-lg font-semibold sm:text-xl">Buka Shift</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Tidak ada shift aktif. Isi modal kas fisik di laci untuk memulai shift baru.
        </p>
        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            openShift.mutate();
          }}
        >
          <MoneyInput
            id="initial"
            label="Saldo Fisik Awal (kas di laci)"
            value={initial}
            onChange={setInitial}
            required
          />
          <Button type="submit" className="w-full" disabled={openShift.isPending}>
            {openShift.isPending ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <PlayCircle className="mr-2 size-4" />
            )}
            Mulai shift
          </Button>
        </form>
      </section>

      <section className="ledger-card p-5 sm:p-6">
        <h2 className="text-base font-semibold">Saldo digital dari shift sebelumnya</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Ditarik otomatis dari snapshot penutupan terakhir agar kontinuitas data terjaga.
        </p>
        {lastShift.isLoading ? (
          <p className="mt-4 text-sm text-muted-foreground">Memuat…</p>
        ) : !lastShift.data ? (
          <p className="mt-4 text-sm text-muted-foreground">
            Belum ada shift tertutup. Snapshot akan tersedia setelah shift pertama ditutup.
          </p>
        ) : (
          <>
            <p className="num mt-4 text-xl font-semibold text-primary sm:text-2xl">
              {rupiah(digitalCarry)}
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <BalanceList title="Bank" rows={lastShift.data.banks} nameKey="bank_name" />
              <BalanceList title="PPOB" rows={lastShift.data.ppob} nameKey="provider_name" />
            </div>
            <p className="num mt-4 text-xs text-muted-foreground">
              Kas fisik akhir shift lalu: {rupiah(lastShift.data.shift.final_physical_balance)}
            </p>
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
    <div>
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      <ul className="mt-2 space-y-1 text-sm">
        {rows.length === 0 && <li className="text-muted-foreground">—</li>}
        {rows.map((r) => (
          <li key={String(r[nameKey])} className="flex justify-between gap-3">
            <span className="text-muted-foreground">{String(r[nameKey])}</span>
            <span className="num">{rupiah(r["final_amount"] as number)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type ShiftRow = {
  id: string;
  initial_physical_balance: number | string;
  total_expenses: number | string;
  start_time: string;
};

function ActiveShiftPanel({ shiftId, shift }: { shiftId: string; shift: ShiftRow }) {
  const txns = useQuery({
    queryKey: ["txns", shiftId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("transactions")
        .select("*")
        .eq("shift_id", shiftId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const summary = summarize(txns.data ?? []);

  const expected = expectedCash({
    initial: num(shift.initial_physical_balance),
    cashNet: summary.cashNet,
    pendingReceivables: 0,
    expenses: num(shift.total_expenses),
  });

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold sm:text-xl">Shift aktif</h1>
          <p className="num text-xs text-muted-foreground sm:text-sm">
            Dibuka {new Date(shift.start_time).toLocaleString("id-ID")} · modal{" "}
            {rupiah(shift.initial_physical_balance)}
          </p>
        </div>
        <Button asChild variant="secondary" size="sm">
          <Link to="/close-shift">
            Tutup shift <ArrowRight className="ml-1 size-4" />
          </Link>
        </Button>
      </div>

      {!isOnline() && (
        <p className="flex items-center gap-2 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2.5 text-xs sm:text-sm">
          <WifiOff className="size-4 shrink-0 text-warning" />
          Mode offline — transaksi akan disinkron otomatis saat koneksi pulih.
        </p>
      )}

      <div className="responsive-grid-3">
        <Kpi label="Ekspektasi kas fisik" value={rupiah(expected)} tone="cash" />
        <Kpi label="Laba bersih shift" value={rupiah(summary.profit)} tone="success" />
        <Kpi label="Total transaksi" value={String(summary.count)} />
      </div>

      <section className="ledger-card p-4 sm:p-5">
        <h2 className="text-base font-semibold">Mutasi shift ini</h2>
        <dl className="num mt-4 grid grid-cols-2 gap-2 text-xs sm:gap-3 sm:text-sm">
          <Row label="Total pokok" value={rupiah(summary.principal)} />
          <Row label="Fee pelanggan" value={rupiah(summary.fees)} />
          <Row label="Biaya provider" value={rupiah(summary.providerCost)} />
          <Row label="Kas masuk" value={rupiah(summary.cashIn)} />
          <Row label="Kas keluar" value={rupiah(summary.cashOut)} />
          <Row label="Pengeluaran" value={rupiah(shift.total_expenses)} />
        </dl>
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "cash" | "success" | "warning";
}) {
  const toneClass =
    tone === "cash"
      ? "text-cash"
      : tone === "success"
        ? "text-success"
        : tone === "warning"
          ? "text-warning"
          : "text-foreground";
  return (
    <div className="ledger-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`num mt-2 text-lg font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}
