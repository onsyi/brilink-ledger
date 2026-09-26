import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Building2,
  Calendar,
  Clock,
  PencilLine,
  Search,
  ScanLine,
  Undo2,
  Wallet,
  TrendingUp,
  Banknote,
  Receipt,
  Info,
  Loader2,
  Landmark,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  BANKS,
  fbi,
  fsSetoran,
  hitungLaba,
  num,
  PPOB_PROVIDERS,
  ppobTerpakai,
  rupiah,
  saldoAkhir,
  saldoAwal,
} from "@/lib/ledger";
import { cn } from "@/lib/utils";
import { QueryError } from "@/components/QueryError";
import { BalanceAuditDialog, RejectReportDialog } from "@/components/ShiftAuditDialogs";

type Period = "all" | "today" | "week" | "month";

interface BankDetailModalData {
  title: string;
  type: "initial" | "final";
  cashier: string;
  branch: string;
  time: string;
  bankMap: Record<string, number>;
  total: number;
}

export function ShiftRecapTable({ initialBranchFilter = "all" }: { initialBranchFilter?: string }) {
  const [branchFilter, setBranchFilter] = useState<string>(initialBranchFilter);
  const [periodFilter, setPeriodFilter] = useState<Period>("all");
  const [searchCashier, setSearchCashier] = useState<string>("");
  const [auditShift, setAuditShift] = useState<{
    id: string;
    cashier: string;
    startedAt: string;
    status?: string;
  } | null>(null);
  const [rejectShift, setRejectShift] = useState<{
    id: string;
    cashier: string;
    startedAt: string;
    modalAkhir: number;
    deposit: number;
    depositConfirmed: boolean;
  } | null>(null);
  const [bankModal, setBankModal] = useState<BankDetailModalData | null>(null);

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

  const shifts = useQuery({
    queryKey: ["shift-recap", branchFilter, periodFilter],
    queryFn: async () => {
      let query = supabase
        .from("shifts")
        .select(
          "id, user_id, start_time, end_time, initial_physical_balance, final_physical_balance, total_expenses, expense_notes, deposit_amount, topup_request, settlement_amount, status, branch_id, modal_awal, modal_akhir, additional_capital, rejected_at, rejection_reason, deposit_confirmed",
        )
        .order("start_time", { ascending: false })
        .limit(200);

      if (branchFilter !== "all") {
        query = query.eq("branch_id", branchFilter);
      }

      if (periodFilter !== "all") {
        const now = new Date();
        let since: Date;
        if (periodFilter === "today") {
          since = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
        } else if (periodFilter === "week") {
          since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        } else {
          since = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
        }
        query = query.gte("start_time", since.toISOString());
      }

      const { data: shiftRows, error } = await query;
      if (error) throw error;

      const ids = (shiftRows ?? []).map((s) => s.id);
      if (ids.length === 0) {
        return { rows: [] };
      }

      const [
        { data: profiles },
        { data: allBranches },
        { data: txns },
        { data: ppobRows },
        { data: bankRows },
      ] = await Promise.all([
        supabase
          .from("profiles")
          .select("id, username")
          .in("id", [...new Set(shiftRows?.map((s) => s.user_id))]),
        supabase.from("branches").select("id, name"),
        supabase.from("transactions").select("shift_id").in("shift_id", ids).limit(20000),
        supabase
          .from("ppob_balances")
          .select("shift_id, provider_name, initial_amount, final_amount")
          .in("shift_id", ids)
          .limit(10000),
        supabase
          .from("bank_balances")
          .select("shift_id, bank_name, initial_amount, final_amount")
          .in("shift_id", ids)
          .limit(10000),
      ]);

      const nameOf = (id: string) => (profiles ?? []).find((p) => p.id === id)?.username ?? "Kasir";
      const branchNameOf = new Map<string, string>();
      (allBranches ?? []).forEach((b) => branchNameOf.set(b.id, b.name));

      const txnCountByShift = new Map<string, number>();
      (txns ?? []).forEach((t) => {
        txnCountByShift.set(t.shift_id, (txnCountByShift.get(t.shift_id) ?? 0) + 1);
      });

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

      const bankInitialMapByShift = new Map<string, Record<string, number>>();
      const bankFinalMapByShift = new Map<string, Record<string, number>>();
      const bankInitialTotalByShift = new Map<string, number>();
      const bankFinalTotalByShift = new Map<string, number>();

      (bankRows ?? []).forEach((b) => {
        const initMap = bankInitialMapByShift.get(b.shift_id) ?? {};
        initMap[b.bank_name] = num(b.initial_amount);
        bankInitialMapByShift.set(b.shift_id, initMap);

        const finMap = bankFinalMapByShift.get(b.shift_id) ?? {};
        finMap[b.bank_name] = num(b.final_amount);
        bankFinalMapByShift.set(b.shift_id, finMap);

        bankInitialTotalByShift.set(
          b.shift_id,
          (bankInitialTotalByShift.get(b.shift_id) ?? 0) + num(b.initial_amount),
        );
        bankFinalTotalByShift.set(
          b.shift_id,
          (bankFinalTotalByShift.get(b.shift_id) ?? 0) + num(b.final_amount),
        );
      });

      const rows = (shiftRows ?? []).map((s) => {
        const cashierName = nameOf(s.user_id);
        const branchName = (s.branch_id ? branchNameOf.get(s.branch_id) : null) ?? "Cabang";
        const ppobInitials = ppobInitialsByShift.get(s.id) ?? [];
        const ppobFinals = ppobFinalsByShift.get(s.id) ?? [];

        const closed = s.modal_akhir !== null;
        const ppobUsed = closed
          ? ppobTerpakai({ ppobInitials, ppobFinals, topup: num(s.topup_request) })
          : null;

        const bankInitialMap = bankInitialMapByShift.get(s.id) ?? {};
        const bankFinalMap = bankFinalMapByShift.get(s.id) ?? {};
        const bankInitialTotal = bankInitialTotalByShift.get(s.id) ?? 0;
        const bankFinalTotal = bankFinalTotalByShift.get(s.id) ?? 0;

        const calculatedSaldoAwal = saldoAwal({
          initialPhysical: num(s.initial_physical_balance),
          bankInitials: [bankInitialTotal],
          additionalCapital: num(s.additional_capital),
        });
        const rowSaldoAwal = s.modal_awal !== null ? num(s.modal_awal) : calculatedSaldoAwal;

        const calculatedSaldoAkhir = closed
          ? saldoAkhir({
              finalPhysical: num(s.final_physical_balance),
              bankFinals: [bankFinalTotal],
              settlement: num(s.settlement_amount),
              expenses: num(s.total_expenses),
            })
          : null;
        const rowSaldoAkhir = closed
          ? s.modal_akhir !== null
            ? num(s.modal_akhir)
            : calculatedSaldoAkhir
          : null;

        const laba =
          closed && rowSaldoAkhir !== null
            ? hitungLaba({ saldoAkhir: rowSaldoAkhir, saldoAwal: rowSaldoAwal })
            : null;

        const fbiVal =
          closed && laba !== null && ppobUsed !== null ? fbi({ laba, ppobUsed }) : null;
        const fsVal = closed ? fsSetoran(num(s.deposit_amount)) : null;

        return {
          shift: s,
          cashier: cashierName,
          branchName,
          txnCount: txnCountByShift.get(s.id) ?? 0,
          bankInitialMap,
          bankFinalMap,
          bankInitialTotal,
          bankFinalTotal,
          saldoAwal: rowSaldoAwal,
          saldoAkhir: rowSaldoAkhir,
          ppobUsed,
          laba,
          fbi: fbiVal,
          fs: fsVal,
        };
      });

      return { rows };
    },
  });

  const amendments = useQuery({
    queryKey: ["shift-amendments"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shift_amendments")
        .select("shift_id, action")
        .limit(200);
      if (error) throw error;
      return new Set((data ?? []).filter((a) => a.action === "amend").map((a) => a.shift_id));
    },
  });

  const allRows = useMemo(() => shifts.data?.rows ?? [], [shifts.data]);

  const filteredRows = useMemo(() => {
    if (!searchCashier.trim()) return allRows;
    const query = searchCashier.toLowerCase();
    return allRows.filter(
      (r) =>
        r.cashier.toLowerCase().includes(query) ||
        r.branchName.toLowerCase().includes(query) ||
        (r.shift.expense_notes ?? "").toLowerCase().includes(query),
    );
  }, [allRows, searchCashier]);

  // Aggregate totals
  const totalSaldoAwal = filteredRows.reduce((s, r) => s + (r.saldoAwal ?? 0), 0);
  const totalAwalBank = filteredRows.reduce((s, r) => s + r.bankInitialTotal, 0);
  const totalAwalKasir = filteredRows.reduce(
    (s, r) => s + num(r.shift.initial_physical_balance),
    0,
  );
  const totalPenambahan = filteredRows.reduce((s, r) => s + num(r.shift.additional_capital), 0);
  const totalSaldoAkhir = filteredRows.reduce((s, r) => s + (r.saldoAkhir ?? 0), 0);
  const totalAkhirBank = filteredRows.reduce((s, r) => s + r.bankFinalTotal, 0);
  const totalAkhirKasir = filteredRows.reduce((s, r) => s + num(r.shift.final_physical_balance), 0);
  const totalSettlement = filteredRows.reduce((s, r) => s + num(r.shift.settlement_amount), 0);
  const totalExpenses = filteredRows.reduce((s, r) => s + num(r.shift.total_expenses), 0);
  const totalPpobUsed = filteredRows.reduce((s, r) => s + (r.ppobUsed ?? 0), 0);
  const totalDeposit = filteredRows.reduce((s, r) => s + num(r.shift.deposit_amount), 0);
  const totalLaba = filteredRows.reduce((s, r) => s + (r.laba ?? 0), 0);
  const totalFbi = filteredRows.reduce((s, r) => s + (r.fbi ?? 0), 0);
  const totalFs = filteredRows.reduce((s, r) => s + (r.fs ?? 0), 0);

  const periods: { id: Period; label: string }[] = [
    { id: "all", label: "Semua Waktu" },
    { id: "today", label: "Hari Ini" },
    { id: "week", label: "7 Hari Terakhir" },
    { id: "month", label: "Bulan Ini" },
  ];

  const openBankDetail = (r: (typeof filteredRows)[number], type: "initial" | "final") => {
    const isInitial = type === "initial";
    setBankModal({
      title: isInitial ? "Rincian Saldo Awal Rekening Bank" : "Rincian Saldo Akhir Rekening Bank",
      type,
      cashier: r.cashier,
      branch: r.branchName,
      time: new Date(r.shift.start_time).toLocaleString("id-ID"),
      bankMap: isInitial ? r.bankInitialMap : r.bankFinalMap,
      total: isInitial ? r.bankInitialTotal : r.bankFinalTotal,
    });
  };

  return (
    <div className="space-y-6">
      {/* Control Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/60 bg-secondary/30 p-3 sm:p-4 backdrop-blur-md">
        <div className="flex flex-wrap items-center gap-2">
          {/* Period Tabs */}
          <div className="flex rounded-xl bg-background/80 p-1 border border-border/50">
            {periods.map((p) => (
              <button
                key={p.id}
                onClick={() => setPeriodFilter(p.id)}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-xs font-semibold transition-all",
                  periodFilter === p.id
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* Branch Select */}
          {branches.data && branches.data.length > 0 && (
            <div className="relative">
              <Building2 className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <select
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value)}
                className="h-9 appearance-none rounded-xl border border-border/60 bg-background/80 py-1 pl-8 pr-4 text-xs font-medium backdrop-blur-sm transition-colors hover:border-primary/30 focus:outline-none focus:ring-2 focus:ring-primary/30"
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

        {/* Search Input */}
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchCashier}
            onChange={(e) => setSearchCashier(e.target.value)}
            placeholder="Cari kasir / catatan..."
            className="h-9 pl-8 text-xs bg-background/80"
          />
        </div>
      </div>

      {/* Summary Stats Cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <div className="rounded-xl border border-border/50 bg-secondary/30 p-3.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Landmark className="size-3.5 text-digital" />
            <span>Total Saldo Awal</span>
          </div>
          <p className="num mt-1 text-base font-bold text-digital sm:text-lg">
            {rupiah(totalSaldoAwal)}
          </p>
        </div>

        <div className="rounded-xl border border-border/50 bg-secondary/30 p-3.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Wallet className="size-3.5 text-cash" />
            <span>Total Saldo Akhir</span>
          </div>
          <p className="num mt-1 text-base font-bold text-cash sm:text-lg">
            {rupiah(totalSaldoAkhir)}
          </p>
        </div>

        <div className="rounded-xl border border-border/50 bg-secondary/30 p-3.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Receipt className="size-3.5 text-warning" />
            <span>Total Pengeluaran</span>
          </div>
          <p className="num mt-1 text-base font-bold text-destructive sm:text-lg">
            {rupiah(totalExpenses)}
          </p>
        </div>

        <div className="rounded-xl border border-border/50 bg-secondary/30 p-3.5">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Banknote className="size-3.5 text-cash" />
            <span>Total Setoran Kasir</span>
          </div>
          <p className="num mt-1 text-base font-bold text-foreground sm:text-lg">
            {rupiah(totalDeposit)}
          </p>
        </div>

        <div className="rounded-xl border border-border/50 bg-secondary/30 p-3.5 col-span-2 sm:col-span-1">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <TrendingUp className="size-3.5 text-success" />
            <span>Total Laba Shift</span>
          </div>
          <p
            className={cn(
              "num mt-1 text-base font-bold sm:text-lg",
              totalLaba < 0 ? "text-destructive" : "text-success",
            )}
          >
            {rupiah(totalLaba)}
          </p>
        </div>
      </div>

      {/* Audit Guide Notification */}
      <div className="flex items-start gap-2.5 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-xs text-muted-foreground">
        <Info className="size-4 shrink-0 text-primary mt-0.5" />
        <div>
          <p className="font-semibold text-foreground">Panduan Validasi Tutup Shift Owner</p>
          <p className="mt-0.5">
            <b>Total S. Awal</b> = S.Awal Rek Bank + S.Awal Buka Kasir + Penambahan Saldo.
            <br />
            <b>Total S. Akhir</b> = S.Akhir Rek Bank + S.Akhir Tutup Kasir + Settlement +
            Pengeluaran.
            <br />
            Klik tombol biru pada kolom <b>S.Awal Rek Bank</b> atau <b>S.Akhir Rek Bank</b> untuk
            memeriksa rincian saldo per mesin ATM/bank.
          </p>
        </div>
      </div>

      {/* Main Detailed Audit Table */}
      <div className="rounded-2xl border border-border/60 bg-card overflow-hidden shadow-sm">
        {shifts.isError ? (
          <div className="p-6">
            <QueryError onRetry={() => shifts.refetch()} />
          </div>
        ) : shifts.isLoading ? (
          <div className="flex min-h-[260px] flex-col items-center justify-center gap-3">
            <Loader2 className="size-7 animate-spin text-primary" />
            <p className="text-sm font-medium text-muted-foreground">
              Memuat data rincian tutup shift...
            </p>
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            Tidak ada data shift yang cocok dengan filter.
          </div>
        ) : (
          <div className="overflow-x-auto hide-scrollbar">
            <table className="w-full min-w-[1580px] text-xs">
              <thead>
                {/* Level 1: Category Header Groups */}
                <tr className="border-b border-border/70 text-center font-bold tracking-wider uppercase text-[10px]">
                  <th
                    colSpan={3}
                    className="bg-secondary/40 py-2.5 px-3 border-r border-border/40 text-muted-foreground"
                  >
                    1. Informasi Shift
                  </th>
                  <th
                    colSpan={4}
                    className="bg-primary/10 py-2.5 px-3 border-r border-border/40 text-primary"
                  >
                    2. Rincian Saldo Awal (Buka Kasir)
                  </th>
                  <th
                    colSpan={6}
                    className="bg-accent/10 py-2.5 px-3 border-r border-border/40 text-accent"
                  >
                    3. Rincian Saldo Akhir (Tutup Kasir)
                  </th>
                  <th
                    colSpan={5}
                    className="bg-success/10 py-2.5 px-3 border-r border-border/40 text-success"
                  >
                    4. PPOB, Setoran & Laba
                  </th>
                  <th colSpan={2} className="bg-secondary/40 py-2.5 px-3 text-muted-foreground">
                    5. Status & Kontrol
                  </th>
                </tr>

                {/* Level 2: Column Headers */}
                <tr className="border-b border-border/60 text-left text-[11px] font-semibold text-muted-foreground bg-secondary/20">
                  {/* Info Shift */}
                  <th className="py-3 px-3">Waktu</th>
                  <th className="py-3 px-2">Kasir</th>
                  <th className="py-3 px-2 border-r border-border/40">Cabang</th>

                  {/* Saldo Awal */}
                  <th className="py-3 px-2.5 text-right font-bold text-digital">Total S. Awal</th>
                  <th className="py-3 px-2 text-right">S.Awal Rek Bank</th>
                  <th className="py-3 px-2 text-right">S.Awal Buka Kasir</th>
                  <th className="py-3 px-2 text-right border-r border-border/40">
                    Penambahan Saldo
                  </th>

                  {/* Saldo Akhir */}
                  <th className="py-3 px-2.5 text-right font-bold text-accent">Total S. Akhir</th>
                  <th className="py-3 px-2 text-right">S.Akhir Rek Bank</th>
                  <th
                    className="py-3 px-2 text-right text-cash"
                    title="Saldo uang tunai fisik akhir di laci kasir"
                  >
                    S.Akhir Tutup Kasir
                  </th>
                  <th className="py-3 px-2 text-right">Settlement</th>
                  <th className="py-3 px-2 text-right">Pengeluaran</th>
                  <th className="py-3 px-2 max-w-[150px] border-r border-border/40">Ket</th>

                  {/* PPOB, Setoran & Laba */}
                  <th className="py-3 px-2 text-right">PPOB Terpakai</th>
                  <th className="py-3 px-2 text-right text-cash">Setoran</th>
                  <th className="py-3 px-2 text-right font-bold">Laba</th>
                  <th className="py-3 px-2 text-right font-bold" title="Laba - PPOB Terpakai">
                    FBI
                  </th>
                  <th
                    className="py-3 px-2 text-right font-bold border-r border-border/40"
                    title="Setoran x 15%"
                  >
                    FS (15%)
                  </th>

                  {/* Status & Tindakan */}
                  <th className="py-3 px-2 text-center">Status</th>
                  <th className="py-3 px-3 text-center">Tindakan</th>
                </tr>
              </thead>

              <tbody className="num divide-y divide-border/30">
                {filteredRows.map((r) => {
                  const closed = r.shift.modal_akhir !== null;
                  const isAmended = amendments.data?.has(r.shift.id);

                  return (
                    <tr
                      key={r.shift.id}
                      className="transition-colors hover:bg-secondary/40 text-xs"
                    >
                      {/* Waktu */}
                      <td className="py-3 px-3 align-top whitespace-nowrap">
                        <div className="flex flex-col gap-0.5">
                          <span className="font-semibold text-foreground flex items-center gap-1">
                            <Clock className="size-3 text-muted-foreground" />
                            {new Date(r.shift.start_time).toLocaleDateString("id-ID", {
                              day: "numeric",
                              month: "short",
                            })}
                          </span>
                          <span className="text-[10px] text-muted-foreground">
                            {new Date(r.shift.start_time).toLocaleTimeString("id-ID", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                            {" → "}
                            {r.shift.end_time
                              ? new Date(r.shift.end_time).toLocaleTimeString("id-ID", {
                                  hour: "2-digit",
                                  minute: "2-digit",
                                })
                              : "Aktif"}
                          </span>
                          {isAmended && (
                            <span className="inline-flex items-center gap-0.5 text-[9px] font-bold text-warning">
                              <PencilLine className="size-2.5" /> diedit
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Kasir */}
                      <td className="py-3 px-2 align-top font-medium whitespace-nowrap">
                        {r.cashier}
                      </td>

                      {/* Cabang */}
                      <td className="py-3 px-2 align-top text-muted-foreground whitespace-nowrap border-r border-border/40">
                        {r.branchName}
                      </td>

                      {/* Total S. Awal */}
                      <td
                        className="py-3 px-2.5 align-top text-right font-bold text-digital whitespace-nowrap bg-digital/5"
                        title="Rumus: S.Awal Bank + S.Awal Buka Kasir + Penambahan Saldo"
                      >
                        {rupiah(r.saldoAwal)}
                      </td>

                      {/* S.Awal Rek Bank */}
                      <td className="py-3 px-2 align-top text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={() => openBankDetail(r, "initial")}
                          title="Klik untuk melihat rincian per bank"
                          className="inline-flex items-center gap-1 font-semibold text-primary hover:underline hover:text-primary/80"
                        >
                          {rupiah(r.bankInitialTotal)}
                          <Info className="size-3 opacity-60" />
                        </button>
                      </td>

                      {/* S.Awal Buka Kasir */}
                      <td className="py-3 px-2 align-top text-right whitespace-nowrap">
                        {rupiah(r.shift.initial_physical_balance)}
                      </td>

                      {/* Penambahan Saldo */}
                      <td className="py-3 px-2 align-top text-right whitespace-nowrap border-r border-border/40">
                        {num(r.shift.additional_capital) > 0 ? (
                          <span className="font-semibold text-foreground">
                            {rupiah(r.shift.additional_capital)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>

                      {/* Total S. Akhir */}
                      <td
                        className="py-3 px-2.5 align-top text-right font-bold text-accent whitespace-nowrap bg-accent/5"
                        title="Rumus: S.Akhir Bank + S.Akhir Tutup Kasir + Settlement + Pengeluaran"
                      >
                        {closed ? (
                          rupiah(r.saldoAkhir)
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>

                      {/* S.Akhir Rek Bank */}
                      <td className="py-3 px-2 align-top text-right whitespace-nowrap">
                        {closed ? (
                          <button
                            type="button"
                            onClick={() => openBankDetail(r, "final")}
                            title="Klik untuk melihat rincian per bank"
                            className="inline-flex items-center gap-1 font-semibold text-primary hover:underline hover:text-primary/80"
                          >
                            {rupiah(r.bankFinalTotal)}
                            <Info className="size-3 opacity-60" />
                          </button>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>

                      {/* S.Akhir Tutup Kasir (Saldo Fisik) */}
                      <td
                        className="py-3 px-2 align-top text-right font-semibold text-cash whitespace-nowrap"
                        title="Saldo uang tunai fisik akhir di laci kasir (Saldo Fisik)"
                      >
                        {closed ? (
                          rupiah(r.shift.final_physical_balance)
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>

                      {/* Settlement */}
                      <td className="py-3 px-2 align-top text-right whitespace-nowrap">
                        {closed && num(r.shift.settlement_amount) > 0 ? (
                          rupiah(r.shift.settlement_amount)
                        ) : closed ? (
                          "0"
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>

                      {/* Pengeluaran */}
                      <td className="py-3 px-2 align-top text-right whitespace-nowrap">
                        {num(r.shift.total_expenses) > 0 ? (
                          <span className="font-semibold text-destructive">
                            {rupiah(r.shift.total_expenses)}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </td>

                      {/* Ket (Keterangan Pengeluaran) */}
                      <td className="py-3 px-2 align-top text-left max-w-[160px] border-r border-border/40">
                        {r.shift.expense_notes ? (
                          <span
                            title={r.shift.expense_notes}
                            className="block truncate text-[11px] italic text-muted-foreground"
                          >
                            {r.shift.expense_notes}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>

                      {/* PPOB Terpakai */}
                      <td className="py-3 px-2 align-top text-right whitespace-nowrap">
                        {r.ppobUsed !== null ? (
                          <span className="text-accent font-semibold">{rupiah(r.ppobUsed)}</span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>

                      {/* Setoran */}
                      <td className="py-3 px-2 align-top text-right font-semibold text-cash whitespace-nowrap">
                        {num(r.shift.deposit_amount) > 0 ? (
                          rupiah(r.shift.deposit_amount)
                        ) : (
                          <span className="text-muted-foreground">0</span>
                        )}
                      </td>

                      {/* Laba */}
                      <td
                        className={cn(
                          "py-3 px-2 align-top text-right font-bold whitespace-nowrap",
                          r.laba !== null && r.laba < 0
                            ? "text-destructive"
                            : r.laba !== null
                              ? "text-success"
                              : "text-muted-foreground",
                        )}
                        title="Rumus: Total S. Akhir - Total S. Awal"
                      >
                        {r.laba !== null ? rupiah(r.laba) : "—"}
                      </td>

                      {/* FBI */}
                      <td
                        className={cn(
                          "py-3 px-2 align-top text-right font-bold whitespace-nowrap",
                          r.fbi !== null && r.fbi < 0
                            ? "text-destructive"
                            : r.fbi !== null
                              ? "text-success"
                              : "text-muted-foreground",
                        )}
                        title="Rumus: Laba - PPOB Terpakai"
                      >
                        {r.fbi !== null ? rupiah(r.fbi) : "—"}
                      </td>

                      {/* FS */}
                      <td className="py-3 px-2 align-top text-right font-medium text-cash whitespace-nowrap border-r border-border/40">
                        {r.fs !== null ? rupiah(r.fs) : "—"}
                      </td>

                      {/* Status */}
                      <td className="py-3 px-2 align-top text-center whitespace-nowrap">
                        <span
                          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold ${
                            r.shift.status === "open"
                              ? "bg-success/15 text-success border border-success/30"
                              : "bg-secondary text-muted-foreground"
                          }`}
                        >
                          {r.shift.status === "open" ? "Berjalan" : "Ditutup"}
                        </span>
                      </td>

                      {/* Tindakan */}
                      <td className="py-3 px-3 align-top text-center whitespace-nowrap">
                        <div className="flex items-center justify-center gap-1">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2 text-[10px] hover:bg-primary/10 hover:text-primary"
                            title="Audit atau koreksi angka shift ini"
                            onClick={() =>
                              setAuditShift({
                                id: r.shift.id,
                                cashier: r.cashier,
                                startedAt: r.shift.start_time,
                                status: r.shift.status,
                              })
                            }
                          >
                            <ScanLine className="size-3 mr-1" /> Audit
                          </Button>
                          {closed && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 px-2 text-[10px] text-destructive hover:bg-destructive/10"
                              title="Tolak laporan & kembalikan ke kasir untuk diperbaiki"
                              onClick={() =>
                                setRejectShift({
                                  id: r.shift.id,
                                  cashier: r.cashier,
                                  startedAt: r.shift.start_time,
                                  modalAkhir: num(r.shift.modal_akhir),
                                  deposit: num(r.shift.deposit_amount),
                                  depositConfirmed: Boolean(r.shift.deposit_confirmed),
                                })
                              }
                            >
                              <Undo2 className="size-3 mr-1" /> Tolak
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>

              {/* Table Footer Totals */}
              <tfoot className="num bg-secondary/30 border-t-2 border-border/70 text-xs font-bold">
                <tr>
                  <td
                    colSpan={3}
                    className="py-3.5 px-3 uppercase tracking-wider text-muted-foreground"
                  >
                    Total {filteredRows.length} Shift
                  </td>
                  <td className="py-3.5 px-2.5 text-right text-digital">
                    {rupiah(totalSaldoAwal)}
                  </td>
                  <td className="py-3.5 px-2 text-right">{rupiah(totalAwalBank)}</td>
                  <td className="py-3.5 px-2 text-right">{rupiah(totalAwalKasir)}</td>
                  <td className="py-3.5 px-2 text-right border-r border-border/40">
                    {rupiah(totalPenambahan)}
                  </td>

                  <td className="py-3.5 px-2.5 text-right text-accent">
                    {rupiah(totalSaldoAkhir)}
                  </td>
                  <td className="py-3.5 px-2 text-right">{rupiah(totalAkhirBank)}</td>
                  <td className="py-3.5 px-2 text-right text-cash">{rupiah(totalAkhirKasir)}</td>
                  <td className="py-3.5 px-2 text-right">{rupiah(totalSettlement)}</td>
                  <td className="py-3.5 px-2 text-right text-destructive">
                    {rupiah(totalExpenses)}
                  </td>
                  <td className="py-3.5 px-2 border-r border-border/40" />

                  <td className="py-3.5 px-2 text-right text-accent">{rupiah(totalPpobUsed)}</td>
                  <td className="py-3.5 px-2 text-right text-cash">{rupiah(totalDeposit)}</td>
                  <td
                    className={cn(
                      "py-3.5 px-2 text-right",
                      totalLaba < 0 ? "text-destructive" : "text-success",
                    )}
                  >
                    {rupiah(totalLaba)}
                  </td>
                  <td
                    className={cn(
                      "py-3.5 px-2 text-right",
                      totalFbi < 0 ? "text-destructive" : "text-success",
                    )}
                  >
                    {rupiah(totalFbi)}
                  </td>
                  <td className="py-3.5 px-2 text-right text-cash border-r border-border/40">
                    {rupiah(totalFs)}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Pop-up Dialog: Rincian Saldo Bank per Mesin */}
      {bankModal && (
        <Dialog open onOpenChange={() => setBankModal(null)}>
          <DialogContent className="glass-card max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 font-display text-lg font-bold">
                <Landmark className="size-5 text-primary" /> {bankModal.title}
              </DialogTitle>
              <DialogDescription>
                Shift <span className="font-semibold text-foreground">{bankModal.cashier}</span> ·{" "}
                {bankModal.branch} ({bankModal.time})
              </DialogDescription>
            </DialogHeader>

            <div className="mt-3 space-y-2">
              <div className="rounded-xl border border-border/50 bg-secondary/30 divide-y divide-border/30 max-h-80 overflow-y-auto">
                {BANKS.map((b) => {
                  const val = bankModal.bankMap[b] ?? 0;
                  return (
                    <div key={b} className="flex items-center justify-between p-2.5 text-xs">
                      <span className="font-medium text-foreground">{b}</span>
                      <span className="num font-semibold text-primary">{rupiah(val)}</span>
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center justify-between rounded-xl border border-primary/30 bg-primary/10 p-3 text-xs font-bold">
                <span>Total Seluruh Rekening Bank</span>
                <span className="num text-sm text-primary">{rupiah(bankModal.total)}</span>
              </div>
            </div>

            <div className="mt-4 flex justify-end">
              <Button size="sm" variant="secondary" onClick={() => setBankModal(null)}>
                Tutup
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Audit & Tolak Dialogs */}
      {auditShift && <BalanceAuditDialog shift={auditShift} onClose={() => setAuditShift(null)} />}
      {rejectShift && (
        <RejectReportDialog shift={rejectShift} onClose={() => setRejectShift(null)} />
      )}
    </div>
  );
}
