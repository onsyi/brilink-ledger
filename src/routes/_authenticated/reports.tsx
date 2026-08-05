import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Loader2, ShieldCheck } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { expectedCash, num, rupiah, summarize } from "@/lib/ledger";

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

function Reports() {
  const { role, user, loading } = useAuth();
  const isOwner = role === "owner";

  const shifts = useQuery({
    queryKey: ["shift-reports", role, user?.id],
    enabled: !!user?.id && !loading,

    queryFn: async () => {
      const { data: shiftRows, error } = await supabase
        .from("shifts")
        .select("*")
        .order("start_time", { ascending: false })
        .limit(60);
      if (error) throw error;
      const ids = (shiftRows ?? []).map((s) => s.id);
      if (ids.length === 0) return [];
      const [{ data: txns }, { data: recv }, { data: profiles }] = await Promise.all([
        supabase.from("transactions").select("*").in("shift_id", ids),
        supabase.from("receivables").select("*").in("shift_id", ids),
        supabase.from("profiles").select("id, username"),
      ]);
      return (shiftRows ?? []).map((s) => {
        const own = (txns ?? []).filter((t) => t.shift_id === s.id);
        const summary = summarize(own);
        const pendingDebt = (recv ?? [])
          .filter((r) => r.shift_id === s.id && r.status === "pending")
          .reduce((acc, r) => acc + num(r.debt_amount), 0);
        const expected = expectedCash({
          initial: num(s.initial_physical_balance),
          cashNet: summary.cashNet,
          pendingReceivables: pendingDebt,
          expenses: num(s.total_expenses),
        });
        return {
          shift: s,
          summary,
          pendingDebt,
          expected,
          variance: s.final_physical_balance === null ? null : num(s.final_physical_balance) - expected,
          cashier: (profiles ?? []).find((p) => p.id === s.user_id)?.username ?? "—",
        };
      });
    },
  });

  const rows = shifts.data ?? [];
  const totalProfit = rows.reduce((s, r) => s + r.summary.profit, 0);
  const totalDeposit = rows.reduce((s, r) => s + num(r.shift.deposit_amount), 0);
  const totalPending = rows.reduce((s, r) => s + r.pendingDebt, 0);

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold sm:text-xl">Laporan & Audit Shift</h1>
          <p className="text-sm text-muted-foreground">
            {loading
              ? "Memuat hak akses…"
              : isOwner
                ? "Semua shift dari seluruh kasir."
                : "Hanya shift milik akun Anda (akses kasir)."}
          </p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary/60 px-3 py-1 text-xs">
          <ShieldCheck className="size-3.5 text-primary" />{" "}
          {loading ? "…" : isOwner ? "Owner" : "Kasir"}
        </span>
      </div>

      <div className="responsive-grid-3">
        <Stat label="Total laba bersih" value={rupiah(totalProfit)} tone="text-success" />
        <Stat label="Total setoran kasir" value={rupiah(totalDeposit)} tone="text-cash" />
        <Stat label="Piutang berjalan" value={rupiah(totalPending)} tone="text-warning" />
      </div>

      {rows.length > 0 && (
        <section className="ledger-card p-4 sm:p-5">
          <h2 className="text-base font-semibold">Rekap Hari Ini</h2>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(() => {
              const today = new Date().toDateString();
              const todayRows = rows.filter(
                (r) => new Date(r.shift.start_time).toDateString() === today,
              );
              const todayProfit = todayRows.reduce((s, r) => s + r.summary.profit, 0);
              const todayTxn = todayRows.reduce((s, r) => s + r.summary.count, 0);
              const todayDeposit = todayRows.reduce(
                (s, r) => s + num(r.shift.deposit_amount),
                0,
              );
              const todayOpen = todayRows.filter((r) => r.shift.status === "open").length;
              return (
                <>
                  <div>
                    <p className="text-xs text-muted-foreground">Shift hari ini</p>
                    <p className="num mt-1 text-lg font-semibold">{todayRows.length}</p>
                    {todayOpen > 0 && (
                      <p className="text-xs text-warning">{todayOpen} masih buka</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Transaksi</p>
                    <p className="num mt-1 text-lg font-semibold">{todayTxn}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Laba hari ini</p>
                    <p className="num mt-1 text-lg font-semibold text-success">
                      {rupiah(todayProfit)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Setoran</p>
                    <p className="num mt-1 text-lg font-semibold text-cash">
                      {rupiah(todayDeposit)}
                    </p>
                  </div>
                </>
              );
            })()}
          </div>
        </section>
      )}

      <section className="ledger-card overflow-x-auto p-4 sm:p-5">
        {shifts.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Memuat laporan…
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">Belum ada shift tercatat.</p>
        ) : (
          <>
            {/* Desktop table */}
            <table className="hidden w-full min-w-[1100px] text-sm md:table">
              <thead className="text-left text-xs tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th className="pb-3">Shift</th>
                  <th className="pb-3">Kasir</th>
                  <th className="pb-3">Modal awal</th>
                  <th className="pb-3">Trx</th>
                  <th className="pb-3">Laba</th>
                  <th className="pb-3">Ekspektasi</th>
                  <th className="pb-3">Kas akhir</th>
                  <th className="pb-3">Selisih</th>
                  <th className="pb-3">Pengeluaran</th>
                  <th className="pb-3">Top-up</th>
                  <th className="pb-3">Setoran</th>
                  <th className="pb-3">Status</th>
                </tr>
              </thead>
              <tbody className="num">
                {rows.map(({ shift, summary, expected, variance, cashier }) => (
                  <tr key={shift.id} className="border-t border-border">
                    <td className="py-3">
                      {new Date(shift.start_time).toLocaleString("id-ID", {
                        dateStyle: "short",
                        timeStyle: "short",
                      })}
                    </td>
                    <td className="py-3">{cashier}</td>
                    <td className="py-3">{rupiah(shift.initial_physical_balance)}</td>
                    <td className="py-3">{summary.count}</td>
                    <td className="py-3 text-success">{rupiah(summary.profit)}</td>
                    <td className="py-3">{rupiah(expected)}</td>
                    <td className="py-3">
                      {shift.final_physical_balance === null
                        ? "—"
                        : rupiah(shift.final_physical_balance)}
                    </td>
                    <td
                      className={`py-3 ${
                        variance === null ? "" : variance === 0 ? "text-success" : "text-destructive"
                      }`}
                    >
                      {variance === null ? "—" : rupiah(variance)}
                    </td>
                    <td className="py-3">
                      {num(shift.total_expenses) > 0 ? (
                        <span className="group relative cursor-default">
                          {rupiah(shift.total_expenses)}
                          {shift.expense_notes && (
                            <span className="pointer-events-none absolute bottom-full left-0 z-10 mb-1 hidden w-48 rounded-lg border border-border bg-popover p-2 text-xs text-popover-foreground shadow-md group-hover:block">
                              {shift.expense_notes}
                            </span>
                          )}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="py-3">{num(shift.topup_request) > 0 ? rupiah(shift.topup_request) : "—"}</td>
                    <td className="py-3">{rupiah(shift.deposit_amount)}</td>
                    <td className="py-3">
                      <span className={shift.status === "open" ? "text-warning" : "text-muted-foreground"}>
                        {shift.status === "open" ? "Open" : "Closed"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Mobile cards */}
            <ul className="space-y-3 md:hidden">
              {rows.map(({ shift, summary, expected, variance, cashier }) => (
                <li key={shift.id} className="rounded-lg border border-border bg-secondary/30 p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{cashier}</span>
                    <span className={`num text-xs ${shift.status === "open" ? "text-warning" : "text-muted-foreground"}`}>
                      {shift.status === "open" ? "Open" : "Closed"}
                    </span>
                  </div>
                  <p className="num mt-1 text-xs text-muted-foreground">
                    {new Date(shift.start_time).toLocaleString("id-ID", {
                      dateStyle: "short",
                      timeStyle: "short",
                    })}
                  </p>
                  <div className="num mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Modal</span>
                      <span>{rupiah(shift.initial_physical_balance)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Trx</span>
                      <span>{summary.count}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Laba</span>
                      <span className="text-success">{rupiah(summary.profit)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Ekspektasi</span>
                      <span>{rupiah(expected)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Kas akhir</span>
                      <span>{shift.final_physical_balance === null ? "—" : rupiah(shift.final_physical_balance)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Selisih</span>
                      <span className={variance === null ? "" : variance === 0 ? "text-success" : "text-destructive"}>
                        {variance === null ? "—" : rupiah(variance)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Pengeluaran</span>
                      <span>{num(shift.total_expenses) > 0 ? rupiah(shift.total_expenses) : "—"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Top-up</span>
                      <span>{num(shift.topup_request) > 0 ? rupiah(shift.topup_request) : "—"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Setoran</span>
                      <span>{rupiah(shift.deposit_amount)}</span>
                    </div>
                  </div>
                  {shift.expense_notes && (
                    <p className="mt-2 text-xs text-muted-foreground">Catatan: {shift.expense_notes}</p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="ledger-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`num mt-2 text-base font-semibold ${tone} sm:text-lg`}>{value}</p>
    </div>
  );
}
