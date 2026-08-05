import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, HandCoins, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { num, rupiah } from "@/lib/ledger";

export const Route = createFileRoute("/_authenticated/receivables")({
  head: () => ({
    meta: [
      { title: "Piutang Customer — Kasir BRILink" },
      {
        name: "description",
        content:
          "Pantau modal yang tertahan di pelanggan: nama customer, nominal piutang, janji bayar, dan pelunasan.",
      },
      { property: "og:title", content: "Piutang Customer — Kasir BRILink" },
      { property: "og:description", content: "Manajemen piutang agen BRILink & PPOB." },
    ],
  }),
  component: Receivables,
});

function Receivables() {
  const queryClient = useQueryClient();

  const list = useQuery({
    queryKey: ["all-receivables"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("receivables")
        .select("*")
        .order("status", { ascending: true })
        .order("due_date", { ascending: true, nullsFirst: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const pay = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("receivables")
        .update({ status: "paid", paid_at: new Date().toISOString() })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Piutang ditandai lunas");
      queryClient.invalidateQueries();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const [payId, setPayId] = useState<string | null>(null);
  const [payName, setPayName] = useState("");
  const [payAmount, setPayAmount] = useState(0);

  const rows = list.data ?? [];
  const pending = rows.filter((r) => r.status === "pending");
  const totalPending = pending.reduce((s, r) => s + num(r.debt_amount), 0);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-5 sm:space-y-6">
      <div>
        <h1 className="text-lg font-semibold sm:text-xl">Piutang Customer</h1>
        <p className="text-sm text-muted-foreground">
          Modal yang tertahan di pelanggan tidak dianggap berkurang sampai piutang dilunasi.
        </p>
      </div>

      <div className="responsive-grid-3">
        <div className="ledger-card p-4">
          <p className="text-xs text-muted-foreground">Total belum lunas</p>
          <p className="num mt-2 text-base font-semibold text-warning sm:text-lg">{rupiah(totalPending)}</p>
        </div>
        <div className="ledger-card p-4">
          <p className="text-xs text-muted-foreground">Jumlah piutang aktif</p>
          <p className="num mt-2 text-base font-semibold sm:text-lg">{pending.length}</p>
        </div>
        <div className="ledger-card p-4">
          <p className="text-xs text-muted-foreground">Jatuh tempo terlewat</p>
          <p className="num mt-2 text-base font-semibold text-destructive sm:text-lg">
            {pending.filter((r) => r.due_date && r.due_date < today).length}
          </p>
        </div>
      </div>

      <section className="ledger-card overflow-x-auto p-4 sm:p-5">
        {list.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Memuat…
          </p>
        ) : rows.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <HandCoins className="size-4" /> Belum ada piutang tercatat.
          </p>
        ) : (
          <>
            {/* Desktop table */}
            <table className="hidden w-full min-w-[640px] text-sm md:table">
              <thead className="text-left text-xs tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th className="pb-3">Customer</th>
                  <th className="pb-3">Nominal</th>
                  <th className="pb-3">Janji bayar</th>
                  <th className="pb-3">Dicatat</th>
                  <th className="pb-3">Status</th>
                  <th className="pb-3" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const overdue = r.status === "pending" && r.due_date && r.due_date < today;
                  return (
                    <tr key={r.id} className="border-t border-border">
                      <td className="py-3 font-medium">{r.customer_name}</td>
                      <td className="num py-3">{rupiah(r.debt_amount)}</td>
                      <td className={`num py-3 ${overdue ? "text-destructive" : ""}`}>
                        {r.due_date ?? "—"}
                      </td>
                      <td className="num py-3 text-muted-foreground">
                        {new Date(r.created_at).toLocaleDateString("id-ID")}
                      </td>
                      <td className="py-3">
                        {r.status === "paid" ? (
                          <span className="inline-flex items-center gap-1 text-success">
                            <CheckCircle2 className="size-4" /> Lunas
                          </span>
                        ) : (
                          <span className="text-warning">Pending</span>
                        )}
                      </td>
                      <td className="py-3 text-right">
                        {r.status === "pending" && (
                          <Button
                            size="sm"
                            variant="secondary"
                            disabled={pay.isPending}
                            onClick={() => {
                              setPayId(r.id);
                              setPayName(r.customer_name);
                              setPayAmount(num(r.debt_amount));
                            }}
                          >
                            Tandai lunas
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* Mobile cards */}
            <ul className="space-y-3 md:hidden">
              {rows.map((r) => {
                const overdue = r.status === "pending" && r.due_date && r.due_date < today;
                return (
                  <li key={r.id} className="rounded-lg border border-border bg-secondary/30 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium">{r.customer_name}</span>
                      {r.status === "paid" ? (
                        <span className="inline-flex items-center gap-1 text-xs text-success">
                          <CheckCircle2 className="size-3.5" /> Lunas
                        </span>
                      ) : (
                        <span className="text-xs text-warning">Pending</span>
                      )}
                    </div>
                    <div className="num mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Nominal</span>
                        <span>{rupiah(r.debt_amount)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Janji bayar</span>
                        <span className={overdue ? "text-destructive" : ""}>{r.due_date ?? "—"}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Dicatat</span>
                        <span>{new Date(r.created_at).toLocaleDateString("id-ID")}</span>
                      </div>
                    </div>
                    {r.status === "pending" && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={pay.isPending}
                        onClick={() => {
                          setPayId(r.id);
                          setPayName(r.customer_name);
                          setPayAmount(num(r.debt_amount));
                        }}
                        className="mt-3 w-full"
                      >
                        Tandai lunas
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      {payId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
          <div className="ledger-card w-full max-w-sm p-6 text-center">
            <CheckCircle2 className="mx-auto size-8 text-success" />
            <h2 className="mt-4 text-lg font-semibold">Tandai Lunas</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Piutang <span className="font-semibold">{payName}</span> sebesar{" "}
              <span className="font-semibold text-cash">{rupiah(payAmount)}</span> akan ditandai lunas.
            </p>
            <div className="mt-6 flex gap-3">
              <Button
                type="button"
                variant="secondary"
                className="flex-1"
                onClick={() => setPayId(null)}
              >
                Batal
              </Button>
              <Button
                className="flex-1"
                disabled={pay.isPending}
                onClick={() => {
                  pay.mutate(payId);
                  setPayId(null);
                }}
              >
                {pay.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                Ya, Lunas
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
