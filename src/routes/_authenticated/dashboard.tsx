import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  PlayCircle,
  Loader2,
  ArrowRight,
  Wallet,
  TrendingUp,
  Receipt,
  Banknote,
  ArrowDownLeft,
  ArrowUpRight,
  CreditCard,
  TriangleAlert,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { MoneyInput } from "@/components/MoneyInput";
import { OwnerOverview } from "@/components/OwnerOverview";
import { expectedCash, num, rupiah, summarize } from "@/lib/ledger";
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

  const shiftQuery = useQuery({
    queryKey: ["open-shift", userId],
    enabled: !!userId && !loading && !isOwner,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shifts")
        .select("id, user_id, start_time, initial_physical_balance, total_expenses, status")
        .eq("user_id", userId!)
        .eq("status", "open")
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

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

  const lastShift = useQuery({
    queryKey: ["last-closed-shift", userId],
    enabled: !!userId,
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
    onError: (e: Error & { code?: string }) =>
      toast.error(
        e.code === "23505" || e.message.includes("duplicate")
          ? "Masih ada shift aktif di akun ini. Tutup dulu shift tersebut."
          : e.message,
      ),
  });

  const digitalCarry =
    (lastShift.data?.banks.reduce((s, b) => s + num(b.final_amount), 0) ?? 0) +
    (lastShift.data?.ppob.reduce((s, p) => s + num(p.final_amount), 0) ?? 0);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
      {/* Open Shift Card */}
      <section className="glass-card glass-card-hover p-6 sm:p-8">
        <div className="flex items-start gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 shadow-[0_0_15px_-3px] shadow-primary/20">
            <PlayCircle className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-xl font-bold sm:text-2xl">Buka Shift</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Tidak ada shift aktif. Isi modal kas fisik di laci untuk memulai.
            </p>
          </div>
        </div>
        <form
          className="mt-6 space-y-5"
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
          <Button type="submit" className="w-full" size="lg" disabled={openShift.isPending}>
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
              Dari snapshot penutupan terakhir.
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
        .select(
          "id, transaction_type, source_account, destination_account, principal_amount, customer_fee, provider_cost, profit_net, created_at",
        )
        .eq("shift_id", shiftId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const pendingReceivables = useQuery({
    queryKey: ["pending-receivables", shiftId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("receivables")
        .select("debt_amount")
        .eq("shift_id", shiftId)
        .eq("status", "pending");
      if (error) throw error;
      return (data ?? []).reduce((sum, r) => sum + num(r.debt_amount), 0);
    },
  });

  const summary = summarize(txns.data ?? []);

  const expected = expectedCash({
    initial: num(shift.initial_physical_balance),
    cashNet: summary.cashNet,
    pendingReceivables: pendingReceivables.data ?? 0,
    expenses: num(shift.total_expenses),
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
          <div className="mt-1.5 inline-flex items-center gap-2 rounded-lg border border-border/50 bg-secondary/40 px-3 py-1 text-xs text-muted-foreground backdrop-blur-sm">
            <span className="num">Dibuka {new Date(shift.start_time).toLocaleString("id-ID")}</span>
            <span className="text-border">·</span>
            <span className="num font-semibold text-cash">
              Modal {rupiah(shift.initial_physical_balance)}
            </span>
          </div>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/close-shift">
            Tutup shift <ArrowRight className="ml-1 size-4" />
          </Link>
        </Button>
      </div>

      {/* Data Load Errors */}
      {(txns.isError || pendingReceivables.isError) && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm backdrop-blur-sm">
          <TriangleAlert className="size-5 shrink-0 text-destructive" />
          <span className="text-muted-foreground">
            Gagal memuat sebagian data shift. Angka di bawah mungkin tidak akurat.
          </span>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => {
              txns.refetch();
              pendingReceivables.refetch();
            }}
          >
            Coba lagi
          </Button>
        </div>
      )}

      {/* KPI Cards */}
      <div className="responsive-grid-3">
        <Kpi
          label="Ekspektasi kas fisik"
          value={rupiah(expected)}
          tone="cash"
          icon={<Wallet className="size-5" />}
        />
        <Kpi
          label="Laba bersih shift"
          value={rupiah(summary.profit)}
          tone="success"
          icon={<TrendingUp className="size-5" />}
        />
        <Kpi
          label="Total transaksi"
          value={String(summary.count)}
          tone="digital"
          icon={<Receipt className="size-5" />}
        />
      </div>

      {/* Mutation Detail */}
      <section className="glass-card p-5 sm:p-6">
        <h2 className="text-lg font-bold">Mutasi shift ini</h2>
        <div className="mt-4 grid gap-2 sm:grid-cols-2 sm:gap-3">
          <MutRow
            label="Total pokok"
            value={rupiah(summary.principal)}
            icon={<Banknote className="size-3.5 text-cash" />}
          />
          <MutRow
            label="Fee pelanggan"
            value={rupiah(summary.fees)}
            icon={<Receipt className="size-3.5 text-primary" />}
          />
          <MutRow
            label="Biaya provider"
            value={rupiah(summary.providerCost)}
            icon={<CreditCard className="size-3.5 text-destructive" />}
          />
          <MutRow
            label="Kas masuk"
            value={rupiah(summary.cashIn)}
            icon={<ArrowDownLeft className="size-3.5 text-success" />}
          />
          <MutRow
            label="Kas keluar"
            value={rupiah(summary.cashOut)}
            icon={<ArrowUpRight className="size-3.5 text-warning" />}
          />
          <MutRow
            label="Pengeluaran"
            value={rupiah(shift.total_expenses)}
            icon={<Wallet className="size-3.5 text-destructive" />}
          />
        </div>
      </section>
    </div>
  );
}

function MutRow({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-border/40 bg-secondary/20 px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        {icon}
        <dt className="text-xs text-muted-foreground sm:text-sm">{label}</dt>
      </div>
      <dd className="num text-xs font-semibold sm:text-sm">{value}</dd>
    </div>
  );
}

function Kpi({
  label,
  value,
  tone,
  icon,
}: {
  label: string;
  value: string;
  tone?: "cash" | "success" | "warning" | "digital";
  icon?: React.ReactNode;
}) {
  const toneMap = {
    cash: {
      gradient: "gradient-text-gold",
      iconBg: "bg-[oklch(0.82_0.16_82_/_0.15)]",
      iconColor: "text-cash",
    },
    success: {
      gradient: "gradient-text-emerald",
      iconBg: "bg-[oklch(0.72_0.17_155_/_0.15)]",
      iconColor: "text-success",
    },
    warning: {
      gradient: "text-warning",
      iconBg: "bg-[oklch(0.82_0.16_75_/_0.15)]",
      iconColor: "text-warning",
    },
    digital: {
      gradient: "gradient-text-cyan",
      iconBg: "bg-[oklch(0.72_0.13_205_/_0.15)]",
      iconColor: "text-digital",
    },
  };
  const t = tone ? toneMap[tone] : null;

  return (
    <div className="ledger-card glass-card-hover p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        {icon && t && (
          <div
            className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${t.iconBg}`}
          >
            <span className={t.iconColor}>{icon}</span>
          </div>
        )}
      </div>
      <p className={`num mt-3 text-xl font-bold sm:text-2xl ${t?.gradient ?? "text-foreground"}`}>
        {value}
      </p>
    </div>
  );
}
