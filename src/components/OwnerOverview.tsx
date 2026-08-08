import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  Loader2,
  ShieldCheck,
  Users,
  BarChart3,
  Building2,
  TrendingUp,
  Clock,
  UserCheck,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { num, rupiah, summarize } from "@/lib/ledger";
import { QueryError } from "@/components/QueryError";

export function OwnerOverview({ username }: { username?: string | null }) {
  const [branchFilter, setBranchFilter] = useState<string>("all");

  const branches = useQuery({
    queryKey: ["branches"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("branches")
        .select("id, name")
        .eq("is_active", true)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const overview = useQuery({
    queryKey: ["owner-overview", branchFilter],
    queryFn: async () => {
      let query = supabase
        .from("shifts")
        .select("id, user_id, start_time, initial_physical_balance, status, branch_id")
        .order("start_time", { ascending: false })
        .limit(60);
      if (branchFilter !== "all") {
        query = query.eq("branch_id", branchFilter);
      }
      const { data: shifts, error } = await query;
      if (error) throw error;
      const ids = (shifts ?? []).map((s) => s.id);
      const [{ data: txns }, { data: profiles }] = await Promise.all([
        ids.length
          ? supabase
              .from("transactions")
              .select(
                "shift_id, transaction_type, source_account, destination_account, principal_amount, customer_fee, provider_cost, profit_net",
              )
              .in("shift_id", ids)
          : Promise.resolve({ data: [] as never[] }),
        supabase.from("profiles").select("id, username"),
      ]);
      const nameOf = (id: string) => (profiles ?? []).find((p) => p.id === id)?.username ?? "kasir";
      const txnsByShift = new Map<string, typeof txns>();
      (txns ?? []).forEach((t) => {
        const arr = txnsByShift.get(t.shift_id) ?? [];
        arr.push(t);
        txnsByShift.set(t.shift_id, arr);
      });
      const rows = (shifts ?? []).map((s) => {
        const own = txnsByShift.get(s.id) ?? [];
        return { shift: s, summary: summarize(own), cashier: nameOf(s.user_id) };
      });
      const today = new Date().toLocaleDateString("id-ID");
      return {
        rows,
        open: rows.filter((r) => r.shift.status === "open"),
        profitToday: rows
          .filter((r) => new Date(r.shift.start_time).toLocaleDateString("id-ID") === today)
          .reduce((s, r) => s + r.summary.profit, 0),
        cashiers: new Set(rows.map((r) => r.shift.user_id)).size,
      };
    },
  });

  if (overview.isError)
    return (
      <div className="flex min-h-[40vh] items-center justify-center">
        <QueryError onRetry={() => overview.refetch()} />
      </div>
    );

  if (overview.isLoading)
    return (
      <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4">
        <div className="relative">
          <div className="absolute inset-0 rounded-full bg-primary/20 blur-xl" />
          <div className="relative flex size-14 items-center justify-center rounded-full border border-primary/20 bg-primary/10">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        </div>
        <p className="text-sm font-medium text-muted-foreground">Memuat ringkasan owner…</p>
      </div>
    );

  const d = overview.data;

  return (
    <div className="space-y-5 sm:space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold sm:text-3xl">Dashboard Owner</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Halo {username ?? "owner"} — pantau shift kasir dan laba.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {branches.data && branches.data.length > 0 && (
            <div className="relative">
              <Building2 className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <select
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value)}
                className="h-8 appearance-none rounded-xl border border-border/60 bg-secondary/60 py-1 pl-8 pr-3 text-xs font-medium backdrop-blur-sm transition-colors hover:border-primary/30 focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="all">Semua Cabang</option>
                {branches.data.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary shadow-[0_0_10px_-3px] shadow-primary/20">
            <ShieldCheck className="size-3.5" /> Mode audit
          </span>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="responsive-grid-3">
        <Kpi
          label="Shift aktif sekarang"
          value={String(d?.open.length ?? 0)}
          icon={<Clock className="size-5" />}
          iconBg="bg-[oklch(0.82_0.16_82_/_0.15)]"
          iconColor="text-cash"
          gradient="gradient-text-gold"
        />
        <Kpi
          label="Laba hari ini"
          value={rupiah(d?.profitToday ?? 0)}
          icon={<TrendingUp className="size-5" />}
          iconBg="bg-[oklch(0.72_0.17_155_/_0.15)]"
          iconColor="text-success"
          gradient="gradient-text-emerald"
        />
        <Kpi
          label="Total kasir"
          value={String(d?.cashiers ?? 0)}
          icon={<UserCheck className="size-5" />}
          iconBg="bg-[oklch(0.72_0.13_205_/_0.15)]"
          iconColor="text-digital"
          gradient="gradient-text-cyan"
        />
      </div>

      {/* Active Shifts */}
      <section className="glass-card p-5 sm:p-6">
        <h2 className="flex items-center gap-2.5 text-lg font-bold">
          <div className="flex size-8 items-center justify-center rounded-lg bg-primary/12">
            <Users className="size-4 text-primary" />
          </div>
          Shift kasir yang sedang berjalan
        </h2>
        {(d?.open.length ?? 0) === 0 ? (
          <p className="mt-4 rounded-xl border border-border/40 bg-secondary/20 px-4 py-3 text-sm text-muted-foreground">
            Tidak ada shift aktif. Kasir dapat membuka shift dari akun masing-masing.
          </p>
        ) : (
          <ul className="mt-4 space-y-2.5">
            {d?.open.map((r) => (
              <li
                key={r.shift.id}
                className="rounded-xl border border-border/50 bg-secondary/30 px-4 py-3 transition-all hover:border-primary/20 hover:bg-secondary/40"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="relative flex size-2">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-success opacity-75" />
                      <span className="relative inline-flex size-2 rounded-full bg-success" />
                    </span>
                    <span className="font-semibold">{r.cashier}</span>
                  </div>
                  <span className="num inline-flex items-center gap-1.5 rounded-lg bg-secondary/50 px-2 py-0.5 text-[11px] text-muted-foreground">
                    <Clock className="size-3" />
                    {new Date(r.shift.start_time).toLocaleString("id-ID")}
                  </span>
                </div>
                <div className="num mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  <span className="text-muted-foreground">
                    Modal{" "}
                    <span className="font-semibold text-cash">
                      {rupiah(r.shift.initial_physical_balance)}
                    </span>
                  </span>
                  <span className="text-muted-foreground">{r.summary.count} transaksi</span>
                  <span className="font-semibold text-success">
                    Laba {rupiah(r.summary.profit)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Shift History Table */}
      <section className="glass-card p-5 sm:p-6">
        <h2 className="text-lg font-bold">Riwayat shift terakhir</h2>
        <div className="mt-4 overflow-x-auto hide-scrollbar">
          <table className="w-full min-w-[500px] text-sm">
            <thead>
              <tr className="border-b border-border/60">
                <th className="pb-3 text-left text-[10px] font-bold tracking-widest text-muted-foreground uppercase">
                  Kasir
                </th>
                <th className="pb-3 text-left text-[10px] font-bold tracking-widest text-muted-foreground uppercase">
                  Mulai
                </th>
                <th className="pb-3 text-right text-[10px] font-bold tracking-widest text-muted-foreground uppercase">
                  Transaksi
                </th>
                <th className="pb-3 text-right text-[10px] font-bold tracking-widest text-muted-foreground uppercase">
                  Laba
                </th>
                <th className="pb-3 text-right text-[10px] font-bold tracking-widest text-muted-foreground uppercase">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="num">
              {(d?.rows ?? []).slice(0, 10).map((r) => (
                <tr
                  key={r.shift.id}
                  className="border-b border-border/30 transition-colors hover:bg-secondary/20"
                >
                  <td className="py-3 text-left font-medium">{r.cashier}</td>
                  <td className="py-3 text-left text-muted-foreground">
                    {new Date(r.shift.start_time).toLocaleDateString("id-ID")}
                  </td>
                  <td className="py-3 text-right">{r.summary.count}</td>
                  <td className="py-3 text-right font-semibold text-success">
                    {rupiah(r.summary.profit)}
                  </td>
                  <td className="py-3 text-right">
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        r.shift.status === "open"
                          ? "bg-success/15 text-success"
                          : "bg-muted/60 text-muted-foreground"
                      }`}
                    >
                      {r.shift.status === "open" ? "Berjalan" : "Ditutup"}
                    </span>
                  </td>
                </tr>
              ))}
              {(d?.rows ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-muted-foreground">
                    Belum ada shift tercatat.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button asChild variant="outline" size="sm">
            <Link to="/reports">
              <BarChart3 className="mr-1.5 size-4" /> Laporan & audit
            </Link>
          </Button>
        </div>
      </section>
    </div>
  );
}

function Kpi({
  label,
  value,
  icon,
  iconBg,
  iconColor,
  gradient,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
  gradient: string;
}) {
  return (
    <div className="ledger-card glass-card-hover p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <div className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${iconBg}`}>
          <span className={iconColor}>{icon}</span>
        </div>
      </div>
      <p className={`num mt-3 text-xl font-bold sm:text-2xl ${gradient}`}>{value}</p>
    </div>
  );
}
