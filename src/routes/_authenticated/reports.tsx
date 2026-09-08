import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
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
  PencilLine,
  ScanLine,
  Undo2,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import {
  BANKS,
  fbi,
  fsSetoran,
  hitungLaba,
  labaFee,
  num,
  PPOB_PROVIDERS,
  ppobTerpakai,
  rupiah,
  saldoAkhir,
  saldoAwal,
} from "@/lib/ledger";
import { cn } from "@/lib/utils";
import { QueryError } from "@/components/QueryError";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/MoneyInput";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

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
  const [auditShift, setAuditShift] = useState<{
    id: string;
    cashier: string;
    startedAt: string;
  } | null>(null);
  const [rejectShift, setRejectShift] = useState<{
    id: string;
    cashier: string;
    startedAt: string;
    modalAkhir: number;
    deposit: number;
    depositConfirmed: boolean;
  } | null>(null);

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
          "id, user_id, start_time, initial_physical_balance, final_physical_balance, modal_awal, modal_akhir, additional_capital, settlement_amount, total_expenses, expense_notes, deposit_amount, deposit_confirmed, topup_request, owner_withdrawal, status, branch_id, rejected_at, rejection_reason",
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
          .select("shift_id, initial_amount, final_amount")
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
      // PPOB dibukukan terpisah dari BRILink. Penambahan saldo adalah satu angka
      // di level shift (shifts.topup_request) dan ikut masuk ke ppobTerpakai()
      // di bawah; kolom per-provider ppob_balances.topup_amount tidak lagi diisi
      // form penutupan (selalu 0) dan tidak dipakai di sini.
      const ppobInitialsByShift = new Map<string, number[]>();
      const ppobFinalsByShift = new Map<string, number[]>();
      (ppobRows ?? []).forEach((p) => {
        ppobInitialsByShift.set(p.shift_id, [
          ...(ppobInitialsByShift.get(p.shift_id) ?? []),
          num(p.initial_amount),
        ]);
        ppobFinalsByShift.set(p.shift_id, [
          ...(ppobFinalsByShift.get(p.shift_id) ?? []),
          num(p.final_amount),
        ]);
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
      const rows = (shiftRows ?? []).map((s) => {
        const ppobInitials = ppobInitialsByShift.get(s.id) ?? [];
        const ppobFinals = ppobFinalsByShift.get(s.id) ?? [];
        // Shift yang masih terbuka — termasuk yang laporannya ditolak owner —
        // punya final_amount = 0 di semua baris ppob_balances dan topup_request
        // = 0, jadi angka apa pun yang dihitung di sini omong kosong. Digate
        // sama seperti Laba & Saldo Akhir: modal_akhir NULL ⇒ tampilkan "—".
        const closed = s.modal_akhir !== null;
        const ppobUsed = closed
          ? ppobTerpakai({ ppobInitials, ppobFinals, topup: num(s.topup_request) })
          : null;

        const bankInitialTotal = bankInitialsByShift.get(s.id) ?? 0;
        const bankFinalTotal = bankFinalsByShift.get(s.id) ?? 0;

        // Rumus Saldo Awal: Saldo semua rekening shift sebelumnya (Bank) + Saldo Awal Buka Kasir + Penambahan Modal
        // (PPOB tidak digabung karena berdiri sendiri)
        const rowSaldoAwal = saldoAwal({
          initialPhysical: num(s.initial_physical_balance),
          bankInitials: [bankInitialTotal],
          additionalCapital: num(s.additional_capital),
        });

        // Rumus Saldo Akhir: Saldo uang Fisik tutup kasir + Saldo rekening Bank tutup kasir + settlement + Pengeluaran + Penarikan Owner
        // (PPOB tidak digabung karena berdiri sendiri)
        const rowSaldoAkhir = closed
          ? saldoAkhir({
              finalPhysical: num(s.final_physical_balance),
              bankFinals: [bankFinalTotal],
              settlement: num(s.settlement_amount),
              expenses: num(s.total_expenses),
              ownerWithdrawal: num(s.owner_withdrawal),
            })
          : null;

        // Rumus Laba: Saldo Akhir - Saldo Awal
        const laba =
          closed && rowSaldoAkhir !== null
            ? hitungLaba({ saldoAkhir: rowSaldoAkhir, saldoAwal: rowSaldoAwal })
            : null;

        return {
          shift: s,
          txnCount: txnCountByShift.get(s.id) ?? 0,
          ppobUsed,
          // Rincian untuk tooltip kolom PPOB Terpakai — topup_request tidak
          // dirender di mana pun, jadi tanpa ini angkanya tidak bisa diaudit.
          ppobInitial: ppobInitials.reduce((a, b) => a + b, 0),
          ppobFinal: ppobFinals.reduce((a, b) => a + b, 0),
          bankInitial: bankInitialTotal,
          bankFinal: bankFinalTotal,
          saldoAwal: rowSaldoAwal,
          saldoAkhir: rowSaldoAkhir,
          laba,
          fbi: laba === null || ppobUsed === null ? null : fbi({ laba, ppobUsed }),
          // Rumus FS = Setoran x 15% (hanya untuk shift closed, jika shift open = null agar tampil "—")
          fs: s.status === "open" ? null : fsSetoran(num(s.deposit_amount)),
          cashier: (profiles ?? []).find((p) => p.id === s.user_id)?.username ?? "—",
          branchName: (s.branch_id && branchNameOf.get(s.branch_id)) || "—",
        };
      });
      return { rows, matched, truncated: matched > rows.length };
    },
  });

  // Amendments and cancellations of open shifts. A cancelled shift leaves no
  // row in `shifts`, so the audit table below cannot show it — only this can.
  const amendments = useQuery({
    queryKey: ["shift-amendments", user?.id, role],
    enabled: !!user?.id && !loading,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shift_amendments")
        .select("id, shift_id, user_id, action, before_data, after_data, created_at")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      const entries = data ?? [];
      if (entries.length === 0) return [];
      const { data: profiles } = await supabase
        .from("profiles")
        .select("id, username")
        .in("id", [...new Set(entries.map((a) => a.user_id))]);
      const nameOf = new Map((profiles ?? []).map((p) => [p.id, p.username]));
      type Payload = {
        modal_awal?: number | string | null;
        modal_akhir?: number | string | null;
        deposit_amount?: number | string | null;
        kind?: string;
        name?: string;
        field?: string;
        value?: number | string;
        reason?: string;
      } | null;
      return entries.map((a) => {
        const before = a.before_data as Payload;
        const after = a.after_data as Payload;
        return {
          id: a.id,
          shiftId: a.shift_id,
          action: a.action,
          at: a.created_at,
          actor: nameOf.get(a.user_id) ?? "—",
          before: num(before?.modal_awal),
          after: after ? num(after.modal_awal) : null,
          detail:
            a.action === "audit" && before?.name
              ? `${before.name} · saldo ${before.field === "initial" ? "awal" : "akhir"} · ` +
                `${rupiah(before.value)} → ${rupiah(after?.value)}`
              : a.action === "reject"
                ? `Modal akhir ${rupiah(before?.modal_akhir)} · setoran ` +
                  `${rupiah(before?.deposit_amount)} dikembalikan ke kasir untuk diperbaiki`
                : null,
          reason: after?.reason ?? before?.reason ?? null,
        };
      });
    },
  });

  const amendedShiftIds = useMemo(
    () =>
      new Set((amendments.data ?? []).filter((a) => a.action === "amend").map((a) => a.shiftId)),
    [amendments.data],
  );

  const rows = useMemo(() => shifts.data?.rows ?? [], [shifts.data]);
  const truncated = shifts.data?.truncated ?? false;
  const totalLaba = rows.reduce((s, r) => s + (r.laba ?? 0), 0);
  const totalDeposit = rows.reduce((s, r) => s + num(r.shift.deposit_amount), 0);
  // Dijumlah sendiri-sendiri, bukan totalLaba - totalPpobUsed: keduanya memang
  // sama karena digate baris yang persis sama, tapi reduce terpisah tetap benar
  // kalau gate-nya nanti berbeda.
  const totalPpobUsed = rows.reduce((s, r) => s + (r.ppobUsed ?? 0), 0);
  const totalFbi = rows.reduce((s, r) => s + (r.fbi ?? 0), 0);
  const totalFs = rows.reduce((s, r) => s + (r.fs ?? 0), 0);
  const totalWithdrawal = rows.reduce((s, r) => s + num(r.shift.owner_withdrawal), 0);

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
            <table className="w-full min-w-[1260px] text-sm">
              <thead>
                <tr className="border-b border-border/60 text-left text-[10px] font-bold tracking-widest text-muted-foreground uppercase">
                  <th className="pb-3">Shift & Mulai</th>
                  <th className="pb-3">Kasir</th>
                  <th className="pb-3">Cabang</th>
                  <th className="pb-3 text-right">Saldo Awal</th>
                  <th className="pb-3 text-right">Saldo Fisik</th>
                  <th className="pb-3 text-right">Pengeluaran</th>
                  <th className="pb-3">Keterangan</th>
                  <th className="pb-3 text-right">Setoran</th>
                  <th className="pb-3 text-right">Modal Tambahan</th>
                  <th className="pb-3 text-right">Settlement</th>
                  <th
                    className="pb-3 text-right"
                    title="Uang yang ditarik owner dari outlet selama shift"
                  >
                    Tarik Owner
                  </th>
                  <th className="pb-3 text-right">PPOB Terpakai</th>
                  <th className="pb-3 text-right">Saldo Akhir</th>
                  <th className="pb-3 text-right">Laba</th>
                  <th className="pb-3 text-right" title="Laba − PPOB Terpakai">
                    FBI
                  </th>
                  <th
                    className="pb-3 text-right"
                    title="Rumus FS = Setoran Kasir × 15% (0 jika tidak ada setoran)"
                  >
                    FS
                  </th>
                  <th className="pb-3 text-center">Status</th>
                  {isOwner && <th className="pb-3 text-center">Tindakan</th>}
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
                        {amendedShiftIds.has(r.shift.id) && (
                          <span
                            title="Modal awal shift ini pernah diperbaiki kasir"
                            className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/15 px-1.5 py-0.5 text-[9px] font-bold text-warning"
                          >
                            <PencilLine className="size-2.5" /> diperbaiki
                          </span>
                        )}
                        {r.shift.rejected_at && (
                          <span
                            title={`Laporan penutupan pernah ditolak owner — alasan: ${
                              r.shift.rejection_reason ?? "—"
                            }`}
                            className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/15 px-1.5 py-0.5 text-[9px] font-bold text-destructive"
                          >
                            <Undo2 className="size-2.5" /> ditolak
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-3.5 font-medium">{r.cashier}</td>
                    <td className="py-3.5 text-muted-foreground text-xs">{r.branchName}</td>
                    <td
                      className="py-3.5 text-right font-medium text-cash"
                      title={`Rumus Saldo Awal: Bank (${rupiah(r.bankInitial)}) + Kas Awal (${rupiah(r.shift.initial_physical_balance)}) + Modal Tambahan (${rupiah(r.shift.additional_capital)})`}
                    >
                      {rupiah(r.saldoAwal)}
                    </td>
                    <td className="py-3.5 text-right font-medium">
                      {r.shift.final_physical_balance !== null
                        ? rupiah(r.shift.final_physical_balance)
                        : "—"}
                    </td>
                    <td className="py-3.5 text-right text-destructive">
                      {rupiah(r.shift.total_expenses)}
                    </td>
                    <td className="max-w-[220px] py-3.5 align-middle">
                      {r.shift.expense_notes ? (
                        <span
                          title={r.shift.expense_notes}
                          className="block truncate text-xs italic text-muted-foreground"
                        >
                          {r.shift.expense_notes}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
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
                    <td className="py-3.5 text-right text-cash">
                      {rupiah(r.shift.owner_withdrawal)}
                    </td>
                    <td
                      className="py-3.5 text-right font-medium text-accent"
                      title={
                        r.ppobUsed !== null
                          ? `Saldo awal ${rupiah(r.ppobInitial)} + penambahan ` +
                            `${rupiah(r.shift.topup_request)} − saldo akhir ${rupiah(r.ppobFinal)}`
                          : "Shift belum ditutup"
                      }
                    >
                      {r.ppobUsed !== null ? rupiah(r.ppobUsed) : "—"}
                    </td>
                    <td
                      className="py-3.5 text-right font-bold text-success"
                      title={
                        r.saldoAkhir !== null
                          ? `Rumus Saldo Akhir: Kas Fisik (${rupiah(r.shift.final_physical_balance)}) + Bank (${rupiah(r.bankFinal)}) + Settlement (${rupiah(r.shift.settlement_amount)}) + Pengeluaran (${rupiah(r.shift.total_expenses)}) + Tarik Owner (${rupiah(r.shift.owner_withdrawal)})`
                          : "Shift belum ditutup"
                      }
                    >
                      {r.saldoAkhir !== null ? rupiah(r.saldoAkhir) : "—"}
                    </td>
                    <td
                      className={cn(
                        "py-3.5 text-right font-bold",
                        r.laba !== null && r.laba < 0 ? "text-destructive" : "text-success",
                      )}
                      title={
                        r.laba !== null && r.saldoAkhir !== null
                          ? `Rumus Laba: Saldo Akhir (${rupiah(r.saldoAkhir)}) − Saldo Awal (${rupiah(r.saldoAwal)})`
                          : "Shift belum ditutup"
                      }
                    >
                      {r.laba !== null ? rupiah(r.laba) : "—"}
                    </td>
                    {/* FBI memang bisa negatif kalau pemakaian saldo PPOB
                        melebihi laba — itu justru inti kolom ini. */}
                    <td
                      className="py-3.5 text-right font-bold"
                      title={
                        r.fbi !== null
                          ? `Rumus FBI: Laba (${rupiah(r.laba)}) − PPOB Terpakai (${rupiah(r.ppobUsed)})`
                          : "Shift belum ditutup"
                      }
                    >
                      {r.fbi !== null ? (
                        <span className={r.fbi < 0 ? "text-destructive" : "text-success"}>
                          {rupiah(r.fbi)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td
                      className="py-3.5 text-right font-medium text-cash"
                      title={
                        r.fs !== null
                          ? `Rumus FS: Setoran (${rupiah(r.shift.deposit_amount)}) × 15%`
                          : "Shift belum ditutup"
                      }
                    >
                      {r.fs !== null ? rupiah(r.fs) : "—"}
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
                    {isOwner && (
                      <td className="py-3.5 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            onClick={() =>
                              setAuditShift({
                                id: r.shift.id,
                                cashier: r.cashier,
                                startedAt: r.shift.start_time,
                              })
                            }
                            title="Koreksi saldo bank / PPOB shift ini"
                            className="inline-flex items-center gap-1 rounded-lg border border-border/60 px-2 py-1 text-[10px] font-semibold text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                          >
                            <ScanLine className="size-3" /> Audit
                          </button>
                          {/* Hanya shift tertutup yang punya laporan untuk ditolak. */}
                          {r.shift.status === "closed" && (
                            <button
                              onClick={() =>
                                setRejectShift({
                                  id: r.shift.id,
                                  cashier: r.cashier,
                                  startedAt: r.shift.start_time,
                                  modalAkhir: num(r.shift.modal_akhir),
                                  deposit: num(r.shift.deposit_amount),
                                  depositConfirmed: !!r.shift.deposit_confirmed,
                                })
                              }
                              title="Kembalikan laporan ini ke kasir untuk diperbaiki"
                              className="inline-flex items-center gap-1 rounded-lg border border-destructive/30 px-2 py-1 text-[10px] font-semibold text-destructive transition-colors hover:border-destructive/60 hover:bg-destructive/10"
                            >
                              <Undo2 className="size-3" /> Tolak
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              {/* Total periode. Menjumlah baris yang termuat saja — lihat
                  peringatan truncation di atas. Shift terbuka menyumbang 0
                  karena angkanya "—". `num` ada di <tbody>, tidak diwariskan ke
                  <tfoot>, jadi harus diulang agar digit total sejajar. */}
              <tfoot className="num">
                <tr className="border-t-2 border-border/60 text-sm font-bold">
                  <td
                    className="py-3.5 text-xs font-bold tracking-widest text-muted-foreground uppercase"
                    colSpan={7}
                  >
                    Total {rows.length} shift
                  </td>
                  <td className="py-3.5 text-right text-cash">{rupiah(totalDeposit)}</td>
                  <td colSpan={2} />
                  <td className="py-3.5 text-right text-cash">{rupiah(totalWithdrawal)}</td>
                  <td className="py-3.5 text-right text-accent">{rupiah(totalPpobUsed)}</td>
                  <td />
                  <td
                    className={cn(
                      "py-3.5 text-right",
                      totalLaba < 0 ? "text-destructive" : "text-success",
                    )}
                  >
                    {rupiah(totalLaba)}
                  </td>
                  <td
                    className={cn(
                      "py-3.5 text-right",
                      totalFbi < 0 ? "text-destructive" : "text-success",
                    )}
                  >
                    {rupiah(totalFbi)}
                  </td>
                  <td className="py-3.5 text-right text-cash">{rupiah(totalFs)}</td>
                  <td colSpan={isOwner ? 2 : 1} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {/* Riwayat perbaikan, penolakan & pembatalan shift */}
      <section className="glass-card p-5 sm:p-6">
        <h2 className="text-base font-bold">Riwayat Perbaikan, Penolakan & Pembatalan Shift</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Koreksi modal awal dan pembatalan shift oleh kasir, audit saldo dan penolakan laporan oleh
          owner. Shift yang dibatalkan tidak muncul di tabel di atas karena barisnya sudah terhapus
          — hanya tercatat di sini.
        </p>

        {amendments.isError ? (
          <div className="mt-4">
            <QueryError onRetry={() => amendments.refetch()} />
          </div>
        ) : amendments.isLoading ? (
          <div className="flex min-h-[100px] items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Memuat riwayat…
          </div>
        ) : (amendments.data ?? []).length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Belum ada perbaikan atau pembatalan shift.
          </p>
        ) : (
          <div className="mt-4 overflow-x-auto hide-scrollbar">
            <table className="w-full min-w-[620px] text-sm">
              <thead>
                <tr className="border-b border-border/60 text-left text-[10px] font-bold tracking-widest text-muted-foreground uppercase">
                  <th className="pb-3">Waktu</th>
                  <th className="pb-3">Oleh</th>
                  <th className="pb-3">Tindakan</th>
                  <th className="pb-3">Keterangan</th>
                  <th className="pb-3 text-right">Modal Awal</th>
                </tr>
              </thead>
              <tbody className="num">
                {(amendments.data ?? []).map((a) => (
                  <tr key={a.id} className="border-b border-border/30 hover:bg-secondary/30">
                    <td className="py-3 align-top text-xs">
                      {new Date(a.at).toLocaleString("id-ID", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </td>
                    <td className="py-3 align-top font-medium">{a.actor}</td>
                    <td className="py-3 align-top">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${
                          a.action === "cancel" || a.action === "reject"
                            ? "border border-destructive/25 bg-destructive/15 text-destructive"
                            : a.action === "audit"
                              ? "border border-primary/30 bg-primary/15 text-primary"
                              : "border border-warning/30 bg-warning/15 text-warning"
                        }`}
                      >
                        {a.action === "cancel"
                          ? "Dibatalkan"
                          : a.action === "reject"
                            ? "Laporan ditolak"
                            : a.action === "audit"
                              ? "Audit owner"
                              : "Diperbaiki"}
                      </span>
                    </td>
                    <td className="py-3 align-top text-xs">
                      {a.detail && <div className="font-medium">{a.detail}</div>}
                      {a.reason && (
                        <div className="mt-0.5 max-w-[280px] italic text-muted-foreground">
                          {a.reason}
                        </div>
                      )}
                      {!a.detail && !a.reason && <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="py-3 align-top text-right">
                      {a.after !== null && a.after !== a.before ? (
                        <span>
                          <span className="text-muted-foreground">{rupiah(a.before)}</span> →{" "}
                          {rupiah(a.after)}
                        </span>
                      ) : (
                        rupiah(a.before)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {auditShift && <BalanceAuditDialog shift={auditShift} onClose={() => setAuditShift(null)} />}
      {rejectShift && (
        <RejectReportDialog shift={rejectShift} onClose={() => setRejectShift(null)} />
      )}
    </div>
  );
}

/**
 * Owner-only rejection of a closed shift report.
 *
 * Goes through owner_reject_shift_report(), which needs a reason, returns the
 * shift to 'open' with its closing figures cleared, keeps a copy so the
 * cashier's form can be pre-filled, and records the whole thing in the
 * amendment trail. Everything the server refuses — a newer shift already
 * carrying these balances, or the cashier already running another shift —
 * comes back as a plain-language toast.
 */
function RejectReportDialog({
  shift,
  onClose,
}: {
  shift: {
    id: string;
    cashier: string;
    startedAt: string;
    modalAkhir: number;
    deposit: number;
    depositConfirmed: boolean;
  };
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");

  const reject = useMutation({
    mutationFn: async () => {
      if (reason.trim().length < 5)
        throw new Error("Alasan penolakan wajib diisi (minimal 5 karakter)");
      const { error } = await supabase.rpc("owner_reject_shift_report", {
        _shift_id: shift.id,
        _reason: reason.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success(`Laporan dikembalikan ke ${shift.cashier} untuk diperbaiki`);
      queryClient.invalidateQueries({ queryKey: ["shift-reports"] });
      queryClient.invalidateQueries({ queryKey: ["shift-amendments"] });
      queryClient.invalidateQueries({ queryKey: ["owner-overview"] });
      queryClient.invalidateQueries({ queryKey: ["deposit-shifts"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="glass-card">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display text-xl font-bold">
            <Undo2 className="size-5 text-destructive" /> Tolak Laporan Shift
          </DialogTitle>
          <DialogDescription>
            Shift <span className="font-medium">{shift.cashier}</span> ·{" "}
            {new Date(shift.startedAt).toLocaleString("id-ID")}. Shift kembali terbuka dan kasir
            mengisi ulang form Tutup Shift dengan angka lamanya sebagai awalan.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Modal akhir yang dibatalkan</span>
              <span className="num font-semibold">{rupiah(shift.modalAkhir)}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">Setoran yang dibatalkan</span>
              <span className="num font-semibold">{rupiah(shift.deposit)}</span>
            </div>
            <p className="text-muted-foreground">
              Saldo tunai akhir, saldo bank/PPOB akhir, pengeluaran, setoran, settlement, dan
              penarikan owner dikosongkan.
              {shift.depositConfirmed
                ? " Konfirmasi setoran ikut dibatalkan — setoran perlu dikonfirmasi ulang setelah kasir menutup shift lagi."
                : ""}{" "}
              Modal awal shift tidak berubah.
            </p>
            <p className="text-muted-foreground">
              Hanya shift terakhir di cabang yang bisa ditolak. Kalau saldo penutupannya sudah
              dipakai sebagai modal awal shift berikutnya, pakai tombol Audit.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="reject-reason" className="text-xs text-muted-foreground">
              Alasan penolakan (wajib, dibaca kasir)
            </Label>
            <Input
              id="reject-reason"
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Contoh: Saldo BRI D tidak cocok dengan mutasi rekening, cek ulang"
              className="h-10"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Batal
          </Button>
          <Button variant="destructive" onClick={() => reject.mutate()} disabled={reject.isPending}>
            {reject.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
            Tolak & kembalikan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Owner-only correction of one bank/PPOB balance on a shift, open or closed.
 *
 * Goes through owner_adjust_balance(), which requires a reason, recomputes the
 * stored modal_awal / modal_akhir so the report cannot end up disagreeing with
 * its own per-account rows, and writes the change to the amendment trail.
 */
function BalanceAuditDialog({
  shift,
  onClose,
}: {
  shift: { id: string; cashier: string; startedAt: string };
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<"bank" | "ppob">("bank");
  const [name, setName] = useState<string>(BANKS[0]);
  const [field, setField] = useState<"initial" | "final">("final");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");

  const balances = useQuery({
    queryKey: ["audit-balances", shift.id],
    queryFn: async () => {
      const [bankRes, ppobRes] = await Promise.all([
        supabase
          .from("bank_balances")
          .select("bank_name, initial_amount, final_amount")
          .eq("shift_id", shift.id),
        supabase
          .from("ppob_balances")
          .select("provider_name, initial_amount, final_amount")
          .eq("shift_id", shift.id),
      ]);
      if (bankRes.error) throw bankRes.error;
      if (ppobRes.error) throw ppobRes.error;
      const map = new Map<string, { initial: number; final: number }>();
      (bankRes.data ?? []).forEach((b) =>
        map.set(`bank:${b.bank_name}`, {
          initial: num(b.initial_amount),
          final: num(b.final_amount),
        }),
      );
      (ppobRes.data ?? []).forEach((p) =>
        map.set(`ppob:${p.provider_name}`, {
          initial: num(p.initial_amount),
          final: num(p.final_amount),
        }),
      );
      return map;
    },
  });

  const options = kind === "bank" ? BANKS : PPOB_PROVIDERS;
  const current = balances.data?.get(`${kind}:${name}`);
  const currentValue = field === "initial" ? (current?.initial ?? 0) : (current?.final ?? 0);

  const save = useMutation({
    mutationFn: async () => {
      if (value === "") throw new Error("Nilai baru wajib diisi");
      if (reason.trim().length < 5)
        throw new Error("Alasan audit wajib diisi (minimal 5 karakter)");
      const { error } = await supabase.rpc("owner_adjust_balance", {
        _shift_id: shift.id,
        _kind: kind,
        _name: name,
        _field: field,
        _new_value: Number(value),
        _reason: reason.trim(),
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Saldo dikoreksi dan tercatat di riwayat audit");
      queryClient.invalidateQueries({ queryKey: ["shift-reports"] });
      queryClient.invalidateQueries({ queryKey: ["shift-amendments"] });
      queryClient.invalidateQueries({ queryKey: ["owner-overview"] });
      queryClient.invalidateQueries({ queryKey: ["audit-balances", shift.id] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const selectClass =
    "h-10 w-full rounded-lg border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30";

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="glass-card">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display text-xl font-bold">
            <ScanLine className="size-5 text-primary" /> Audit Saldo Rekening
          </DialogTitle>
          <DialogDescription>
            Shift <span className="font-medium">{shift.cashier}</span> ·{" "}
            {new Date(shift.startedAt).toLocaleString("id-ID")}. Koreksi tercatat permanen beserta
            alasannya, dan modal awal/akhir dihitung ulang otomatis.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="audit-kind" className="text-xs text-muted-foreground">
                Jenis
              </Label>
              <select
                id="audit-kind"
                value={kind}
                className={selectClass}
                onChange={(e) => {
                  const k = e.target.value as "bank" | "ppob";
                  setKind(k);
                  setName(k === "bank" ? BANKS[0] : PPOB_PROVIDERS[0]);
                }}
              >
                <option value="bank">Bank</option>
                <option value="ppob">PPOB</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="audit-name" className="text-xs text-muted-foreground">
                Akun
              </Label>
              <select
                id="audit-name"
                value={name}
                className={selectClass}
                onChange={(e) => setName(e.target.value)}
              >
                {options.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="audit-field" className="text-xs text-muted-foreground">
                Kolom
              </Label>
              <select
                id="audit-field"
                value={field}
                className={selectClass}
                onChange={(e) => setField(e.target.value as "initial" | "final")}
              >
                <option value="initial">Saldo Awal</option>
                <option value="final">Saldo Akhir</option>
              </select>
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-secondary/30 px-3 py-2.5">
            <span className="text-sm text-muted-foreground">Nilai tercatat sekarang</span>
            <span className="num text-sm font-semibold">
              {balances.isLoading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                rupiah(currentValue)
              )}
            </span>
          </div>

          <MoneyInput id="audit-value" label="Nilai baru" value={value} onChange={setValue} />

          <div className="space-y-1.5">
            <Label htmlFor="audit-reason" className="text-xs text-muted-foreground">
              Alasan koreksi (wajib)
            </Label>
            <Input
              id="audit-reason"
              value={reason}
              maxLength={200}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Contoh: Rekonsiliasi mutasi rekening BRI D tanggal 16 Agt"
              className="h-10"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            Batal
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || balances.isLoading}>
            {save.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
            Simpan koreksi
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
