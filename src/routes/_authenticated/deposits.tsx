import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  CheckCircle2,
  Loader2,
  Wallet,
  ArrowDownRight,
  Clock,
  ShieldCheck,
  Building2,
} from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { num, rupiah } from "@/lib/ledger";
import { QueryError } from "@/components/QueryError";

export const Route = createFileRoute("/_authenticated/deposits")({
  head: () => ({
    meta: [
      { title: "Setoran Kasir — Kasir BRILink" },
      {
        name: "description",
        content: "Dokumentasi serah terima uang fisik dari kasir kepada pemilik.",
      },
      { property: "og:title", content: "Setoran Kasir — Kasir BRILink" },
      { property: "og:description", content: "Manajemen setoran kasir agen BRILink & PPOB." },
    ],
  }),
  component: Deposits,
});

function Deposits() {
  const { user, role, loading: authLoading } = useAuth();
  const isOwner = role === "owner";
  const queryClient = useQueryClient();
  const [branchFilter, setBranchFilter] = useState<string>("all");

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
    queryKey: ["deposit-shifts", user?.id, role, branchFilter],
    enabled: !!user?.id && !authLoading,
    queryFn: async () => {
      let query = supabase
        .from("shifts")
        .select(
          "id, user_id, start_time, end_time, final_physical_balance, deposit_amount, deposit_confirmed, branch_id",
        )
        .eq("status", "closed")
        .gt("deposit_amount", 0)
        .eq("deposit_confirmed", false)
        .order("end_time", { ascending: false })
        .limit(60);

      if (!isOwner) {
        query = query.eq("user_id", user!.id);
      } else if (isOwner && branchFilter !== "all") {
        query = query.eq("branch_id", branchFilter);
      }

      const { data, error } = await query;
      if (error) throw error;
      const shiftRows = data ?? [];
      if (shiftRows.length === 0) return [];

      // shifts.user_id references auth.users, so there is no PostgREST
      // relationship to public.profiles — resolve cashier names separately.
      const { data: profiles, error: profilesError } = await supabase
        .from("profiles")
        .select("id, username")
        .in("id", [...new Set(shiftRows.map((s) => s.user_id))]);
      if (profilesError) throw profilesError;
      const usernameOf = new Map((profiles ?? []).map((p) => [p.id, p.username]));

      return shiftRows.map((s) => ({ ...s, cashierName: usernameOf.get(s.user_id) ?? "Kasir" }));
    },
  });

  const confirmDeposit = useMutation({
    mutationFn: async (shiftId: string) => {
      const { error } = await supabase
        .from("shifts")
        .update({ deposit_confirmed: true })
        .eq("id", shiftId)
        .eq("deposit_confirmed", false);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Setoran dikonfirmasi diterima");
      queryClient.invalidateQueries({ queryKey: ["deposit-shifts"] });
      queryClient.invalidateQueries({ queryKey: ["shift-reports"] });
      queryClient.invalidateQueries({ queryKey: ["owner-overview"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [confirmId, setConfirmId] = useState<string | null>(null);

  const rows = shifts.data ?? [];
  // Derived rather than stored, so the dialog can never show an amount left
  // over from a previously selected shift.
  const confirmAmount = num(rows.find((r) => r.id === confirmId)?.deposit_amount);
  const totalPending = rows.reduce((s, r) => s + num(r.deposit_amount), 0);

  return (
    <div className="space-y-6 sm:space-y-7">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-bold sm:text-2xl">
            <div className="flex size-9 items-center justify-center rounded-xl bg-primary/15 shadow-[0_0_15px_-3px] shadow-primary/20">
              <Wallet className="size-5 text-primary" />
            </div>
            Setoran Kasir
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {isOwner
              ? "Dokumentasi serah terima uang fisik dari kasir kepada pemilik."
              : "Riwayat setoran uang fisik yang telah Anda serahkan kepada owner."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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

      <div className="responsive-grid-2">
        <div className="ledger-card glass-card-hover p-5">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs font-medium text-muted-foreground">Total setoran pending</p>
            <div className="flex size-9 items-center justify-center rounded-xl bg-[oklch(0.82_0.16_82_/_0.15)] text-cash">
              <ArrowDownRight className="size-5" />
            </div>
          </div>
          <p className="num mt-3 text-xl font-bold gradient-text-gold sm:text-2xl">
            {rupiah(totalPending)}
          </p>
        </div>
        <div className="ledger-card glass-card-hover p-5">
          <div className="flex items-start justify-between gap-3">
            <p className="text-xs font-medium text-muted-foreground">Jumlah setoran tercatat</p>
            <div className="flex size-9 items-center justify-center rounded-xl bg-[oklch(0.72_0.13_205_/_0.15)] text-digital">
              <Clock className="size-5" />
            </div>
          </div>
          <p className="num mt-3 text-xl font-bold gradient-text-cyan sm:text-2xl">{rows.length}</p>
        </div>
      </div>

      <section className="glass-card p-5 sm:p-6">
        <h2 className="text-base font-bold mb-4">Daftar Setoran Uang Fisik</h2>

        {shifts.isError ? (
          <QueryError onRetry={() => shifts.refetch()} />
        ) : shifts.isLoading ? (
          <div className="flex min-h-[160px] flex-col items-center justify-center gap-3">
            <Loader2 className="size-6 animate-spin text-primary" />
            <p className="text-sm font-medium text-muted-foreground">Memuat data setoran…</p>
          </div>
        ) : rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Belum ada setoran kasir yang perlu dikonfirmasi.
          </p>
        ) : (
          <div className="grid gap-3.5 sm:grid-cols-2">
            {rows.map((r) => {
              const cashierName = r.cashierName;
              const amt = num(r.deposit_amount);
              return (
                <div
                  key={r.id}
                  className="flex flex-col justify-between gap-3 rounded-2xl border border-border/50 bg-secondary/30 p-4.5 backdrop-blur-sm transition-all hover:border-primary/20 hover:bg-secondary/40"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <span className="font-bold text-foreground text-base">{cashierName}</span>
                      <p className="num mt-1 text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="size-3" />
                        {r.end_time
                          ? new Date(r.end_time).toLocaleString("id-ID")
                          : "Shift belum ditutup"}
                      </p>
                    </div>
                    <span className="num font-bold text-lg text-cash">{rupiah(amt)}</span>
                  </div>

                  {isOwner && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full mt-1 border-primary/30 text-primary hover:bg-primary/10"
                      onClick={() => setConfirmId(r.id)}
                    >
                      <CheckCircle2 className="mr-1.5 size-4" /> Konfirmasi Diterima
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Confirm Modal */}
      {confirmId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-md"
          role="dialog"
          aria-modal="true"
          aria-labelledby="deposit-confirm-title"
          onClick={(e) => {
            if (e.target === e.currentTarget) setConfirmId(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") setConfirmId(null);
          }}
        >
          <div className="glass-card w-full max-w-md p-6 text-center">
            <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-success/20 shadow-[0_0_20px_-3px] shadow-success/30">
              <ShieldCheck className="size-7 text-success" />
            </div>
            <h2 id="deposit-confirm-title" className="mt-5 font-display text-xl font-bold">
              Konfirmasi Penerimaan Setoran
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Apakah Anda telah menerima uang fisik sebesar:
            </p>
            <p className="num mt-2 text-2xl font-bold gradient-text-gold">
              {rupiah(confirmAmount)}
            </p>
            <div className="mt-6 flex gap-3">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => setConfirmId(null)}
              >
                Batal
              </Button>
              <Button
                className="flex-1"
                disabled={confirmDeposit.isPending}
                onClick={() => {
                  confirmDeposit.mutate(confirmId, {
                    onSuccess: () => setConfirmId(null),
                  });
                }}
              >
                {confirmDeposit.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                Ya, Terima Uang
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
