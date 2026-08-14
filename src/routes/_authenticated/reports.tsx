import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import {
  Loader2,
  ShieldCheck,
  TrendingUp,
  Wallet,
  BarChart3,
  Calendar,
  Building2,
  Receipt,
  Clock,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { num, rupiah } from "@/lib/ledger";
import { cn } from "@/lib/utils";
import { QueryError } from "@/components/QueryError";

export const Route = createFileRoute("/_authenticated/reports")({
  head: () => ({
    meta: [
      { title: "Laporan Shift — Kasir BRILink" },
      {
        name: "description",
        content:
          "Audit trail shift: modal awal, kas akhir, selisih, pengeluaran, setoran kasir, dan laba bersih per shift.",
      },
      { property: "og:title", content: "Laporan Shift — Kasir BRILink" },
      { property: "og:description", content: "Rekap dan audit lintas shift untuk owner." },
    ],
  }),
  component: Reports,
});

type Period = "today" | "week" | "month" | "all";

function filterByPeriod(start: string, period: Period): boolean {
  if (period === "all") return true;
  const d = new Date(start);
  const now = new Date();
  if (period === "today") {
    return d.toDateString() === now.toDateString();
  }
  if (period === "week") {
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    return d >= weekAgo;
  }
  if (period === "month") {
    return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
  }
  return true;
}

function Reports() {
  const { role, user, loading } = useAuth();
  const isOwner = role === "owner";
  const [branchFilter, setBranchFilter] = useState<string>("all");
  const [periodFilter, setPeriodFilter] = useState<Period>("all");

  const branches = useQuery({
    queryKey: ["branches"],
    enabled: isOwner,
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

  const shifts = useQuery({
    queryKey: ["shift-reports", role, user?.id, branchFilter, periodFilter],
    enabled: !!user?.id && !loading,

    queryFn: async () => {
      let query = supabase
        .from("shifts")
        .select(
          "id, user_id, start_time, modal_awal, modal_akhir, total_expenses, expense_notes, final_physical_balance, deposit_amount, deposit_confirmed, topup_request, status, branch_id",
        )
        .order("start_time", { ascending: false })
        .limit(60);
      if (!isOwner && user?.id) {
        query = query.eq("user_id", user.id);
      } else if (isOwner && branchFilter !== "all") {
        query = query.eq("branch_id", branchFilter);
      }
      const { data: shiftRows, error } = await query;
      if (error) throw error;
      const ids = (shiftRows ?? []).map((s) => s.id);
      if (ids.length === 0) return [];
      const [{ data: txns }, { data: profiles }, { data: allBranches }] = await Promise.all([
        supabase.from("transactions").select("shift_id").in("shift_id", ids),
        supabase.from("profiles").select("id, username, branch_id"),
        supabase.from("branches").select("id, name"),
      ]);
      const branchNameOf = new Map<string, string>();
      (allBranches ?? []).forEach((b) => branchNameOf.set(b.id, b.name));
      const txnCountByShift = new Map<string, number>();
      (txns ?? []).forEach((t) => {
        txnCountByShift.set(t.shift_id, (txnCountByShift.get(t.shift_id) ?? 0) + 1);
      });
      return (shiftRows ?? [])
        .filter((s) => filterByPeriod(s.start_time, periodFilter))
        .map((s) => ({
          shift: s,
          txnCount: txnCountByShift.get(s.id) ?? 0,
          cashier: (profiles ?? []).find((p) => p.id === s.user_id)?.username ?? "—",
          branchName: (s.branch_id && branchNameOf.get(s.branch_id)) || "—",
        }));
    },
  });

  const rows = useMemo(() => shifts.data ?? [], [shifts.data]);
  const totalProfit = rows.reduce((s, r) => s + num(r.shift.modal_akhir), 0);
  const totalDeposit = rows.reduce((s, r) => s + num(r.shift.deposit_amount), 0);

  const periodStats = useMemo(() => {
    return {
      count: rows.length,
      profit: rows.reduce((s, r) => s + num(r.shift.modal_akhir), 0),
      txn: rows.reduce((s, r) => s + r.txnCount, 0),
      deposit: rows.reduce((s, r) => s + num(r.shift.deposit_amount), 0),
      open: rows.filter((r) => r.shift.status === "open").length,
    };
  }, [rows]);

  const periodLabel =
    periodFilter === "today"
      ? "Hari Ini"
      : periodFilter === "week"
        ? "7 Hari Terakhir"
        : periodFilter === "month"
          ? "Bulan Ini"
          : "Semua Waktu";

  // Data points for SVG chart (chronological order)
  const chartPoints = useMemo(() => {
    const sorted = [...rows]
      .filter((r) => r.shift.modal_akhir !== null)
      .reverse()
      .slice(-12);
    const maxVal = Math.max(...sorted.map((r) => num(r.shift.modal_akhir)), 10000);
    return sorted.map((r) => {
      const height = Math.max(15, Math.round((num(r.shift.modal_akhir) / maxVal) * 100));
      return {
        id: r.shift.id,
        height,
        profit: num(r.shift.modal_akhir),
        date: new Date(r.shift.start_time).toLocaleDateString("id-ID", {
          day: "numeric",
          month: "short",
        }),
      };
    });
  }, [rows]);

  const periods: { id: Period; label: string }[] = [
    { id: "all", label: "Semua Waktu" },
    { id: "today", label: "Hari Ini" },
    { id: "week", label: "7 Hari Terakhir" },
    { id: "month", label: "Bulan Ini" },
  ];

  return (
    <div className="space-y-6 sm:space-y-7">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-bold sm:text-2xl">
            <div className="flex size-9 items-center justify-center rounded-xl bg-primary/15 shadow-[0_0_15px_-3px] shadow-primary/20">
              <BarChart3 className="size-5 text-primary" />
            </div>
            Laporan & Audit Shift
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {loading
              ? "Memuat hak akses…"
              : isOwner
                ? "Semua shift dari seluruh kasir outlet."
                : "Hanya shift milik akun Anda."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary">
            <ShieldCheck className="size-3.5" />
            {loading ? "…" : isOwner ? "Owner Mode" : "Kasir Mode"}
          </span>
          {isOwner && branches.data && branches.data.length > 0 && (
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
        </div>
      </div>

      {/* Segmented Period Filter Chips */}
      <div className="flex items-center gap-1.5 overflow-x-auto rounded-2xl border border-border/60 bg-secondary/30 p-1.5 backdrop-blur-sm hide-scrollbar">
        <Calendar className="ml-2 size-4 text-muted-foreground shrink-0" />
        {periods.map((p) => (
          <button
            key={p.id}
            onClick={() => setPeriodFilter(p.id)}
            className={cn(
              "rounded-xl px-3.5 py-1.5 text-xs font-semibold whitespace-nowrap transition-all duration-200 cursor-pointer",
              periodFilter === p.id
                ? "bg-primary text-primary-foreground shadow-md shadow-primary/25"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Stats Summary Cards */}
      <div className="responsive-grid-3">
        <Stat
          label="Total modal akhir"
          value={rupiah(totalProfit)}
          icon={<TrendingUp className="size-5" />}
          gradient="gradient-text-emerald"
          iconBg="bg-[oklch(0.72_0.17_155_/_0.15)] text-success"
        />
        <Stat
          label="Total setoran kasir"
          value={rupiah(totalDeposit)}
          icon={<Wallet className="size-5" />}
          gradient="gradient-text-gold"
          iconBg="bg-[oklch(0.82_0.16_82_/_0.15)] text-cash"
        />
        <Stat
          label="Total transaksi"
          value={String(periodStats.txn)}
          icon={<Receipt className="size-5" />}
          gradient="gradient-text-cyan"
          iconBg="bg-[oklch(0.72_0.13_205_/_0.15)] text-digital"
        />
      </div>

      {/* Interactive Profit Trend Chart (SVG) */}
      {chartPoints.length > 0 && (
        <section className="glass-card p-5 sm:p-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold">Grafik Modal Akhir Shift</h2>
              <p className="text-xs text-muted-foreground">
                Tren performa {chartPoints.length} shift terakhir
              </p>
            </div>
            <span className="num text-xs font-bold text-success bg-success/15 border border-success/25 px-2.5 py-1 rounded-lg">
              Rekap {periodLabel}
            </span>
          </div>

          <div className="mt-6 flex h-36 items-end justify-between gap-2 pt-4 px-2 border-b border-border/40">
            {chartPoints.map((pt) => (
              <div
                key={pt.id}
                className="group relative flex flex-1 flex-col items-center gap-1.5 h-full justify-end"
              >
                {/* Tooltip on hover */}
                <div className="absolute -top-10 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10 rounded-lg bg-card border border-border px-2 py-1 text-[10px] num font-bold shadow-lg whitespace-nowrap">
                  {rupiah(pt.profit)}
                </div>
                {/* Bar */}
                <div
                  style={{ height: `${pt.height}%` }}
                  className="w-full max-w-[28px] rounded-t-lg bg-gradient-to-t from-[oklch(0.72_0.17_155_/_0.4)] to-[oklch(0.72_0.17_155)] group-hover:brightness-125 transition-all shadow-[0_0_10px_-2px] shadow-success/30"
                />
                <span className="text-[10px] text-muted-foreground num truncate w-full text-center">
                  {pt.date}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Audit Table */}
      <section className="glass-card overflow-hidden p-5 sm:p-6">
        <h2 className="text-base font-bold mb-4">Audit Trail Shift</h2>

        {shifts.isError ? (
          <QueryError onRetry={() => shifts.refetch()} />
        ) : shifts.isLoading ? (
          <div className="flex min-h-[200px] flex-col items-center justify-center gap-3">
            <Loader2 className="size-6 animate-spin text-primary" />
            <p className="text-sm font-medium text-muted-foreground">Memuat audit trail…</p>
          </div>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Belum ada shift tercatat untuk periode ini.
          </p>
        ) : (
          <div className="overflow-x-auto hide-scrollbar">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-border/60 text-left text-[10px] font-bold tracking-widest text-muted-foreground uppercase">
                  <th className="pb-3">Shift & Mulai</th>
                  <th className="pb-3">Kasir</th>
                  <th className="pb-3">Cabang</th>
                  <th className="pb-3 text-right">Modal Awal</th>
                  <th className="pb-3 text-right">Saldo Fisik</th>
                  <th className="pb-3 text-right">Pengeluaran</th>
                  <th className="pb-3 text-right">Setoran</th>
                  <th className="pb-3 text-right">Modal Akhir</th>
                  <th className="pb-3 text-center">Status</th>
                </tr>
              </thead>
              <tbody className="num">
                {rows.map((r) => (
                  <tr
                    key={r.shift.id}
                    className="border-b border-border/30 transition-colors hover:bg-secondary/30"
                  >
                    <td className="py-3.5 font-medium">
                      <div className="flex items-center gap-1.5 text-xs">
                        <Clock className="size-3.5 text-muted-foreground" />
                        <span>
                          {new Date(r.shift.start_time).toLocaleString("id-ID", {
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </div>
                    </td>
                    <td className="py-3.5 font-medium">{r.cashier}</td>
                    <td className="py-3.5 text-muted-foreground text-xs">{r.branchName}</td>
                    <td className="py-3.5 text-right font-medium text-cash">
                      {rupiah(r.shift.modal_awal)}
                    </td>
                    <td className="py-3.5 text-right font-medium">
                      {r.shift.final_physical_balance !== null
                        ? rupiah(r.shift.final_physical_balance)
                        : "—"}
                    </td>
                    <td className="py-3.5 text-right text-destructive">
                      {rupiah(r.shift.total_expenses)}
                    </td>
                    <td className="py-3.5 text-right font-medium">
                      <span className={r.shift.deposit_confirmed ? "text-success" : "text-cash"}>
                        {rupiah(r.shift.deposit_amount)}
                      </span>
                      {r.shift.deposit_confirmed && (
                        <span className="ml-1 inline-flex items-center rounded-full bg-success/15 px-1.5 py-0.5 text-[9px] font-bold text-success">
                          OK
                        </span>
                      )}
                    </td>
                    <td className="py-3.5 text-right font-bold text-success">
                      {r.shift.modal_akhir !== null ? rupiah(r.shift.modal_akhir) : "—"}
                    </td>
                    <td className="py-3.5 text-center">
                      <span
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-bold ${
                          r.shift.status === "open"
                            ? "bg-success/15 text-success border border-success/25"
                            : "bg-secondary text-muted-foreground"
                        }`}
                      >
                        {r.shift.status === "open" ? "Aktif" : "Ditutup"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  icon,
  gradient,
  iconBg,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  gradient: string;
  iconBg: string;
}) {
  return (
    <div className="ledger-card glass-card-hover p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <div className={`flex size-9 shrink-0 items-center justify-center rounded-xl ${iconBg}`}>
          {icon}
        </div>
      </div>
      <p className={`num mt-3 text-xl font-bold sm:text-2xl ${gradient}`}>{value}</p>
    </div>
  );
}
