import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Loader2, ShieldCheck, Users, BarChart3, Building2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { num, rupiah, summarize } from "@/lib/ledger";

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
        .select("*")
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
          ? supabase.from("transactions").select("*").in("shift_id", ids)
          : Promise.resolve({ data: [] as never[] }),
        supabase.from("profiles").select("id, username"),
      ]);
      const nameOf = (id: string) => (profiles ?? []).find((p) => p.id === id)?.username ?? "kasir";
      const rows = (shifts ?? []).map((s) => {
        const own = (txns ?? []).filter((t) => t.shift_id === s.id);
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

  if (overview.isLoading)
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Memuat ringkasan owner…
      </div>
    );

  const d = overview.data;

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold sm:text-xl">Dashboard Owner</h1>
          <p className="text-sm text-muted-foreground">
            Halo {username ?? "owner"} — pantau shift kasir dan laba.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {branches.data && branches.data.length > 0 && (
            <select
              value={branchFilter}
              onChange={(e) => setBranchFilter(e.target.value)}
              className="h-8 rounded-lg border border-border bg-secondary px-2 text-xs"
            >
              <option value="all">Semua Cabang</option>
              {branches.data.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary/60 px-3 py-1 text-xs">
            <ShieldCheck className="size-3.5 text-primary" /> Mode audit
          </span>
        </div>
      </div>

      <div className="responsive-grid-3">
        <Kpi label="Shift aktif sekarang" value={String(d?.open.length ?? 0)} tone="text-cash" />
        <Kpi label="Laba hari ini" value={rupiah(d?.profitToday ?? 0)} tone="text-success" />
        <Kpi label="Total kasir" value={String(d?.cashiers ?? 0)} />
      </div>

      <section className="ledger-card p-4 sm:p-5">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Users className="size-4 text-primary" /> Shift kasir yang sedang berjalan
        </h2>
        {(d?.open.length ?? 0) === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Tidak ada shift aktif. Kasir dapat membuka shift dari akun masing-masing.
          </p>
        ) : (
          <ul className="mt-3 space-y-2 sm:mt-4">
            {d?.open.map((r) => (
              <li
                key={r.shift.id}
                className="rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{r.cashier}</span>
                  <span className="num text-xs text-muted-foreground">
                    dibuka {new Date(r.shift.start_time).toLocaleString("id-ID")}
                  </span>
                </div>
                <div className="num mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground sm:gap-x-4">
                  <span>modal {rupiah(r.shift.initial_physical_balance)}</span>
                  <span>{r.summary.count} transaksi</span>
                  <span className="text-success">laba {rupiah(r.summary.profit)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="ledger-card p-4 sm:p-5">
        <h2 className="text-base font-semibold">Riwayat shift terakhir</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[500px] text-sm">
            <thead className="text-xs text-muted-foreground uppercase">
              <tr>
                <th className="py-2 text-left">Kasir</th>
                <th className="py-2 text-left">Mulai</th>
                <th className="py-2 text-right">Transaksi</th>
                <th className="py-2 text-right">Laba</th>
                <th className="py-2 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="num">
              {(d?.rows ?? []).slice(0, 10).map((r) => (
                <tr key={r.shift.id} className="border-t border-border">
                  <td className="py-2 text-left">{r.cashier}</td>
                  <td className="py-2 text-left">
                    {new Date(r.shift.start_time).toLocaleDateString("id-ID")}
                  </td>
                  <td className="py-2 text-right">{r.summary.count}</td>
                  <td className="py-2 text-right text-success">{rupiah(r.summary.profit)}</td>
                  <td className="py-2 text-right">
                    {r.shift.status === "open" ? "Berjalan" : "Ditutup"}
                  </td>
                </tr>
              ))}
              {(d?.rows ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} className="py-3 text-muted-foreground">
                    Belum ada shift tercatat.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="mt-4 flex flex-wrap gap-2 sm:mt-5">
          <Button asChild variant="secondary" size="sm">
            <Link to="/reports">
              <BarChart3 className="mr-1 size-4" /> Laporan & audit
            </Link>
          </Button>
        </div>
      </section>
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="ledger-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`num mt-2 text-lg font-semibold ${tone ?? "text-foreground"}`}>{value}</p>
    </div>
  );
}
