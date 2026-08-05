import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Wallet } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { num, rupiah } from "@/lib/ledger";

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

  const shifts = useQuery({
    queryKey: ["deposit-shifts", user?.id, role],
    enabled: !!user?.id && !authLoading,
    queryFn: async () => {
      let query = supabase
        .from("shifts")
        .select("*, profiles!shifts_user_id_fkey(username)")
        .eq("status", "closed")
        .not("deposit_amount", "eq", 0)
        .order("end_time", { ascending: false })
        .limit(60);

      if (!isOwner) {
        query = query.eq("user_id", user!.id);
      }

      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
  });

  const confirmDeposit = useMutation({
    mutationFn: async (shiftId: string) => {
      const { error } = await supabase
        .from("shifts")
        .update({ deposit_amount: 0 })
        .eq("id", shiftId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Setoran dikonfirmasi diterima");
      queryClient.invalidateQueries({ queryKey: ["deposit-shifts"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = shifts.data ?? [];
  const totalPending = rows.reduce((s, r) => s + num(r.deposit_amount), 0);

  return (
    <div className="space-y-5 sm:space-y-6">
      <div>
        <h1 className="text-lg font-semibold sm:text-xl">Setoran Kasir</h1>
        <p className="text-sm text-muted-foreground">
          {isOwner
            ? "Dokumentasi serah terima uang fisik dari kasir kepada pemilik."
            : "Riwayat setoran uang fisik yang telah Anda serahkan kepada owner."}
        </p>
      </div>

      <div className="responsive-grid-2">
        <div className="ledger-card p-4">
          <p className="text-xs text-muted-foreground">Total setoran pending</p>
          <p className="num mt-2 text-base font-semibold text-cash sm:text-lg">{rupiah(totalPending)}</p>
        </div>
        <div className="ledger-card p-4">
          <p className="text-xs text-muted-foreground">Jumlah setoran tercatat</p>
          <p className="num mt-2 text-base font-semibold sm:text-lg">{rows.length}</p>
        </div>
      </div>

      <section className="ledger-card overflow-x-auto p-4 sm:p-5">
        {shifts.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Memuat…
          </p>
        ) : rows.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Wallet className="size-4" /> Belum ada setoran tercatat.
          </p>
        ) : (
          <>
            {/* Desktop table */}
            <table className="hidden w-full min-w-[600px] text-sm md:table">
              <thead className="text-left text-xs tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th className="pb-3">{isOwner ? "Kasir" : "Tanggal"}</th>
                  <th className="pb-3">Tanggal tutup</th>
                  <th className="pb-3">Kas akhir</th>
                  <th className="pb-3">Setoran</th>
                  {isOwner && <th className="pb-3" />}
                </tr>
              </thead>
              <tbody className="num">
                {rows.map((s) => (
                  <tr key={s.id} className="border-t border-border">
                    <td className="py-3">
                      {isOwner
                        ? (s.profiles as { username: string } | null)?.username ?? "—"
                        : new Date(s.end_time ?? s.start_time).toLocaleDateString("id-ID")}
                    </td>
                    <td className="py-3 text-muted-foreground">
                      {s.end_time
                        ? new Date(s.end_time).toLocaleString("id-ID", {
                            dateStyle: "short",
                            timeStyle: "short",
                          })
                        : "—"}
                    </td>
                    <td className="py-3">{rupiah(s.final_physical_balance)}</td>
                    <td className="py-3 font-medium text-cash">{rupiah(s.deposit_amount)}</td>
                    {isOwner && (
                      <td className="py-3 text-right">
                        <Button
                          size="sm"
                          variant="secondary"
                          disabled={confirmDeposit.isPending}
                          onClick={() => confirmDeposit.mutate(s.id)}
                        >
                          <CheckCircle2 className="mr-1 size-3.5" />
                          Konfirmasi
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Mobile cards */}
            <ul className="space-y-3 md:hidden">
              {rows.map((s) => (
                <li key={s.id} className="rounded-lg border border-border bg-secondary/30 p-3">
                  {isOwner && (
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">
                        {(s.profiles as { username: string } | null)?.username ?? "—"}
                      </span>
                    </div>
                  )}
                  <div className="num mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Tutup shift</span>
                      <span>
                        {s.end_time
                          ? new Date(s.end_time).toLocaleDateString("id-ID")
                          : "—"}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Kas akhir</span>
                      <span>{rupiah(s.final_physical_balance)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Setoran</span>
                      <span className="font-medium text-cash">{rupiah(s.deposit_amount)}</span>
                    </div>
                  </div>
                  {isOwner && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={confirmDeposit.isPending}
                      onClick={() => confirmDeposit.mutate(s.id)}
                      className="mt-3 w-full"
                    >
                      <CheckCircle2 className="mr-1 size-3.5" />
                      Konfirmasi diterima
                    </Button>
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
