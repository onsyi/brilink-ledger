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
  TriangleAlert,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { labaFee, num, rupiah } from "@/lib/ledger";
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

const SHIFT_LIMIT = 200;

/**
 * Half-open [from, to) window for a period, in local time.
 *
 * This used to be a client-side filter applied *after* `.limit(60)`, so any
 * period holding more than 60 shifts silently lost the rest and every total on
 * the page under-reported. The window is now pushed into the query.
 */
function periodRange(period: Period): { from: Date; to?: Date } | null {
  if (period === "all") return null;
  const now = new Date();
  if (period === "today") {
    const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return { from, to };
  }
  if (period === "week") {
    const from = new Date(now);
    from.setDate(from.getDate() - 7);
    return { from };
  }
  return {
    from: new Date(now.getFullYear(), now.getMonth(), 1),
    to: new Date(now.getFullYear(), now.getMonth() + 1, 1),
  };
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
          "id, user_id, start_time, initial_physical_balance, final_physical_balance, modal_awal, modal_akhir, additional_capital, settlement_amount, total_expenses, expense_notes, deposit_amount, deposit_confirmed, topup_request, status, branch_id",
          { count: "exact" },
        )
        .order("start_time", { ascending: false })
        .limit(SHIFT_LIMIT);
      if (!isOwner && user?.id) {
        query = query.eq("user_id", user.id);
      } else if (isOwner && branchFilter !== "all") {
        query = query.eq("branch_id", branchFilter);
      }
      const range = periodRange(periodFilter);
      if (range) {
        query = query.gte("start_time", range.from.toISOString());
        if (range.to) query = query.lt("start_time", range.to.toISOString());
      }
      const { data: shiftRows, error, count } = await query;
      if (error) throw error;
      const matched = count ?? (shiftRows ?? []).length;
      const ids = (shiftRows ?? []).map((s) => s.id);
      if (ids.length === 0) return { rows: [], matched, truncated: false };
      const [
        { data: txns },
        { data: profiles },
        { data: allBranches },
        { data: ppobRows },
        { data: bankRows },
      ] = await Promise.all([
        supabase.from("transactions").select("shift_id").in("shift_id", ids),
        supabase.from("profiles").select("id, username, branch_id"),
        supabase.from("branches").select("id, name"),
        supabase
          .from("ppob_balances")
          .select("shift_id, initial_amount, topup_amount, final_amount")
          .in("shift_id", ids),
        supabase
          .from("bank_balances")
          .select("shift_id, initial_amount, final_amount")
          .in("shift_id", ids),
      ]);
      const branchNameOf = new Map<string, string>();
      (allBranches ?? []).forEach((b) => branchNameOf.set(b.id, b.name));
      const txnCountByShift = new Map<string, number>();
      (txns ?? []).forEach((t) => {
        txnCountByShift.set(t.shift_id, (txnCountByShift.get(t.shift_id) ?? 0) + 1);
      });
      const ppobUsedByShift = new Map<string, number>();
      (ppobRows ?? []).forEach((p) => {
        const used = num(p.initial_amount) + num(p.topup_amount) - num(p.final_amount);
        ppobUsedByShift.set(p.shift_id, (ppobUsedByShift.get(p.shift_id) ?? 0) + used);
      });
      const bankInitialsByShift = new Map<string, number>();
      const bankFinalsByShift = new Map<string, number>();
      (bankRows ?? []).forEach((b) => {
        bankInitialsByShift.set(
          b.shift_id,
          (bankInitialsByShift.get(b.shift_id) ?? 0) + num(b.initial_amount),
        );
        bankFinalsByShift.set(
          b.shift_id,
          (bankFinalsByShift.get(b.shift_id) ?? 0) + num(b.final_amount),
        );
      });
      const rows = (shiftRows ?? []).map((s) => ({
        shift: s,
        txnCount: txnCountByShift.get(s.id) ?? 0,
        ppobUsed: ppobUsedByShift.get(s.id) ?? 0,
        laba:
          s.modal_akhir === null
            ? null
            : labaFee({
                initialPhysical: num(s.initial_physical_balance),
                finalPhysical: num(s.final_physical_balance),
                bankInitials: [bankInitialsByShift.get(s.id) ?? 0],
                bankFinals: [bankFinalsByShift.get(s.id) ?? 0],
                expenses: num(s.total_expenses),
                settlement: num(s.settlement_amount),
                topup: num(s.topup_request),
              }),
        cashier: (profiles ?? []).find((p) => p.id === s.user_id)?.username ?? "—",
        branchName: (s.branch_id && branchNameOf.get(s.branch_id)) || "—",
      }));
      return { rows, matched, truncated: matched > rows.length };
    },
  });

  const rows = useMemo(() => shifts.data?.rows ?? [], [shifts.data]);
  const truncated = shifts.data?.truncated ?? false;
  const totalLaba = rows.reduce((s, r) => s + (r.laba ?? 0), 0);
  const totalDeposit = rows.reduce((s, r) => s + num(r.shift.deposit_amount), 0);

  const periodStats = useMemo(() => {
    return {
      count: rows.length,
      laba: rows.reduce((s, r) => s + (r.laba ?? 0), 0),
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

  // Bar chart data, chronological. Scaled on magnitude so a loss is drawn as a
  // tall red bar; the previous version divided by the max profit and clamped the
  // result to a 15% floor, which rendered every loss as a small green bar and
  // made a period of pure losses look like a flat run of small profits.
  const chartPoints = useMemo(() => {
    const sorted = [...rows]
      .filter((r) => r.laba !== null)
      .reverse()
      .slice(-12);
    const maxAbs = Math.max(...sorted.map((r) => Math.abs(r.laba ?? 0)), 10000);
    return sorted.map((r) => {
      const profit = r.laba ?? 0;
      return {
        id: r.shift.id,
        height: Math.max(4, Math.round((Math.abs(profit) / maxAbs) * 100)),
        negative: profit < 0,
        profit,
        date: new Date(r.shift.start_time).toLocaleDateString("id-ID", {
          day: "numeric",
          month: "short",
        }),
      };
    });
  }, [rows]);

  const lossCount = chartPoints.filter((p) => p.negative).length;

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

      {/* Truncation notice — totals below cover only the rows actually loaded */}
      {truncated && (
        <div className="flex flex-wrap items-center gap-2.5 rounded-xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm backdrop-blur-sm">
          <TriangleAlert className="size-4 shrink-0 text-warning" />
          <span className="text-muted-foreground">
            Periode ini punya{" "}
            <span className="num font-semibold text-foreground">{shifts.data?.matched}</span> shift,
            tetapi hanya <span className="num font-semibold text-foreground">{rows.length}</span>{" "}
            terbaru yang dimuat. Angka total di bawah belum mencakup seluruh periode — persempit
            filter cabang atau periode untuk rekap yang akurat.
          </span>
        </div>
      )}

      {/* Stats Summary Cards */}
      <div className="responsive-grid-3">
        <Stat
          label="Total laba fee"
          value={rupiah(totalLaba)}
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
              <h2 className="text-base font-bold">Grafik Laba Fee Shift</h2>
              <p className="text-xs text-muted-foreground">
                Tren performa {chartPoints.length} shift terakhir
                {lossCount > 0 && (
                  <>
                    {" — "}
                    <span className="font-semibold text-destructive">{lossCount} rugi</span>
                  </>
                )}
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
                <div
                  className={cn(
                    "absolute -top-10 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-10 rounded-lg bg-card border border-border px-2 py-1 text-[10px] num font-bold shadow-lg whitespace-nowrap",
                    pt.negative && "text-destructive",
                  )}
                >
                  {rupiah(pt.profit)}
                </div>
                {/* Bar */}
                <div
                  style={{ height: `${pt.height}%` }}
                  className={cn(
                    "w-full max-w-[28px] rounded-t-lg bg-gradient-to-t group-hover:brightness-125 transition-all shadow-[0_0_10px_-2px]",
                    pt.negative
                      ? "from-destructive/40 to-destructive shadow-destructive/30"
                      : "from-[oklch(0.72_0.17_155_/_0.4)] to-[oklch(0.72_0.17_155)] shadow-success/30",
                  )}
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
                  <th className="pb-3 text-right">Modal Tambahan</th>
                  <th className="pb-3 text-right">Settlement</th>
                  <th className="pb-3 text-right">PPOB Terpakai</th>
                  <th className="pb-3 text-right">Modal Akhir</th>
                  <th className="pb-3 text-right">Laba Fee</th>
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
                    <td className="py-3.5 text-right">{rupiah(r.shift.additional_capital)}</td>
                    <td className="py-3.5 text-right">{rupiah(r.shift.settlement_amount)}</td>
                    <td className="py-3.5 text-right font-medium text-accent">
                      {rupiah(r.ppobUsed)}
                    </td>
                    <td className="py-3.5 text-right font-bold text-success">
                      {r.shift.modal_akhir !== null ? rupiah(r.shift.modal_akhir) : "—"}
                    </td>
                    <td className="py-3.5 text-right font-bold text-success">
                      {r.laba !== null ? rupiah(r.laba) : "—"}
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
