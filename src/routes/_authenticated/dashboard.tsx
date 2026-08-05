import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { PlayCircle, Plus, Loader2, TriangleAlert, ArrowRight } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { MoneyInput } from "@/components/MoneyInput";
import { OwnerOverview } from "@/components/OwnerOverview";

import {
  ACCOUNTS,
  BANKS,
  PPOB_PROVIDERS,
  TXN_TYPES,
  type TxnType,
  accountLabel,
  cashDelta,
  expectedCash,
  num,
  rupiah,
  summarize,
  txnLabel,
} from "@/lib/ledger";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Shift & Transaksi — Kasir BRILink" },
      {
        name: "description",
        content: "Buka shift, catat transaksi tarik tunai, setor, transfer, PPOB, dan piutang.",
      },
      { property: "og:title", content: "Shift & Transaksi — Kasir BRILink" },
      { property: "og:description", content: "Pencatatan ledger harian agen BRILink & PPOB." },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const { user, role, loading, username } = useAuth();
  const userId = user?.id;
  const isOwner = role === "owner";

  const shiftQuery = useQuery({
    queryKey: ["open-shift", userId],
    enabled: !!userId && !loading && !isOwner,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("shifts")
        .select("*")
        .eq("user_id", userId!)
        .eq("status", "open")
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  if (loading) return <LoadingBlock />;
  if (isOwner) return <OwnerOverview username={username} />;
  if (shiftQuery.isLoading) return <LoadingBlock />;
  if (!shiftQuery.data) return <OpenShiftPanel userId={userId} />;
  return <ActiveShiftPanel shiftId={shiftQuery.data.id} shift={shiftQuery.data} />;
}


function LoadingBlock() {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> Memuat data shift…
    </div>
  );
}

function OpenShiftPanel({ userId }: { userId?: string | undefined }) {
  const queryClient = useQueryClient();
  const [initial, setInitial] = useState("");

  const lastShift = useQuery({
    queryKey: ["last-closed-shift", userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data: shift } = await supabase
        .from("shifts")
        .select("id, end_time, final_physical_balance")
        .eq("user_id", userId!)
        .eq("status", "closed")
        .order("end_time", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!shift) return null;
      const [{ data: banks }, { data: ppob }] = await Promise.all([
        supabase.from("bank_balances").select("bank_name, final_amount").eq("shift_id", shift.id),
        supabase
          .from("ppob_balances")
          .select("provider_name, final_amount")
          .eq("shift_id", shift.id),
      ]);
      return { shift, banks: banks ?? [], ppob: ppob ?? [] };
    },
  });

  const openShift = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("shifts").insert({
        user_id: userId!,
        initial_physical_balance: Number(initial || 0),
        status: "open",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Shift dibuka");
      queryClient.invalidateQueries();
    },
    onError: (e: Error) =>
      toast.error(
        e.message.includes("duplicate")
          ? "Masih ada shift aktif di akun ini. Tutup dulu shift tersebut."
          : e.message,
      ),
  });

  const digitalCarry =
    (lastShift.data?.banks.reduce((s, b) => s + num(b.final_amount), 0) ?? 0) +
    (lastShift.data?.ppob.reduce((s, p) => s + num(p.final_amount), 0) ?? 0);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_1.1fr]">
      <section className="ledger-card p-5 sm:p-6">
        <h1 className="text-lg font-semibold sm:text-xl">Buka Shift</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Tidak ada shift aktif. Isi modal kas fisik di laci untuk memulai shift baru.
        </p>
        <form
          className="mt-5 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            openShift.mutate();
          }}
        >
          <MoneyInput
            id="initial"
            label="Saldo Fisik Awal (kas di laci)"
            value={initial}
            onChange={setInitial}
            required
          />
          <Button type="submit" className="w-full" disabled={openShift.isPending}>
            {openShift.isPending ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <PlayCircle className="mr-2 size-4" />
            )}
            Mulai shift
          </Button>
        </form>
      </section>

      <section className="ledger-card p-5 sm:p-6">
        <h2 className="text-base font-semibold">Saldo digital dari shift sebelumnya</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Ditarik otomatis dari snapshot penutupan terakhir agar kontinuitas data terjaga.
        </p>
        {lastShift.isLoading ? (
          <p className="mt-4 text-sm text-muted-foreground">Memuat…</p>
        ) : !lastShift.data ? (
          <p className="mt-4 text-sm text-muted-foreground">
            Belum ada shift tertutup. Snapshot akan tersedia setelah shift pertama ditutup.
          </p>
        ) : (
          <>
            <p className="num mt-4 text-xl font-semibold text-primary sm:text-2xl">{rupiah(digitalCarry)}</p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <BalanceList title="Bank" rows={lastShift.data.banks} nameKey="bank_name" />
              <BalanceList title="PPOB" rows={lastShift.data.ppob} nameKey="provider_name" />
            </div>
            <p className="num mt-4 text-xs text-muted-foreground">
              Kas fisik akhir shift lalu: {rupiah(lastShift.data.shift.final_physical_balance)}
            </p>
          </>
        )}
      </section>
    </div>
  );
}

function BalanceList({
  title,
  rows,
  nameKey,
}: {
  title: string;
  rows: Record<string, unknown>[];
  nameKey: string;
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      <ul className="mt-2 space-y-1 text-sm">
        {rows.length === 0 && <li className="text-muted-foreground">—</li>}
        {rows.map((r) => (
          <li key={String(r[nameKey])} className="flex justify-between gap-3">
            <span className="text-muted-foreground">{String(r[nameKey])}</span>
            <span className="num">{rupiah(r["final_amount"] as number)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type ShiftRow = {
  id: string;
  initial_physical_balance: number | string;
  total_expenses: number | string;
  start_time: string;
};

function ActiveShiftPanel({ shiftId, shift }: { shiftId: string; shift: ShiftRow }) {
  const queryClient = useQueryClient();

  const txns = useQuery({
    queryKey: ["txns", shiftId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("transactions")
        .select("*")
        .eq("shift_id", shiftId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const receivables = useQuery({
    queryKey: ["receivables", shiftId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("receivables")
        .select("*")
        .eq("shift_id", shiftId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
  });

  const summary = useMemo(() => summarize(txns.data ?? []), [txns.data]);
  const pendingDebt = (receivables.data ?? [])
    .filter((r) => r.status === "pending")
    .reduce((s, r) => s + num(r.debt_amount), 0);

  const expected = expectedCash({
    initial: num(shift.initial_physical_balance),
    cashNet: summary.cashNet,
    pendingReceivables: pendingDebt,
    expenses: num(shift.total_expenses),
  });

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold sm:text-xl">Shift aktif</h1>
          <p className="num text-xs text-muted-foreground sm:text-sm">
            Dibuka {new Date(shift.start_time).toLocaleString("id-ID")} · modal{" "}
            {rupiah(shift.initial_physical_balance)}
          </p>
        </div>
        <Button asChild variant="secondary" size="sm">
          <Link to="/close-shift">
            Tutup shift <ArrowRight className="ml-1 size-4" />
          </Link>
        </Button>
      </div>

      <div className="responsive-grid-4">
        <Kpi label="Ekspektasi kas fisik" value={rupiah(expected)} tone="cash" />
        <Kpi label="Laba bersih shift" value={rupiah(summary.profit)} tone="success" />
        <Kpi label="Transaksi" value={String(summary.count)} />
        <Kpi label="Piutang belum lunas" value={rupiah(pendingDebt)} tone="warning" />
      </div>

      <div className="grid gap-5 lg:grid-cols-[1.05fr_1fr]">
        <TransactionForm shiftId={shiftId} onDone={() => queryClient.invalidateQueries()} />
        <section className="ledger-card p-4 sm:p-5">
          <h2 className="text-base font-semibold">Mutasi shift ini</h2>
          <dl className="num mt-4 grid grid-cols-2 gap-2 text-xs sm:gap-3 sm:text-sm">
            <Row label="Total pokok" value={rupiah(summary.principal)} />
            <Row label="Fee pelanggan" value={rupiah(summary.fees)} />
            <Row label="Biaya provider" value={rupiah(summary.providerCost)} />
            <Row label="Kas masuk" value={rupiah(summary.cashIn)} />
            <Row label="Kas keluar" value={rupiah(summary.cashOut)} />
            <Row label="Pengeluaran" value={rupiah(shift.total_expenses)} />
          </dl>

          <h3 className="mt-5 text-sm font-semibold sm:mt-6">Riwayat transaksi</h3>
          <ul className="mt-3 max-h-60 space-y-2 overflow-y-auto pr-1 sm:max-h-80">
            {txns.isLoading && <li className="text-sm text-muted-foreground">Memuat…</li>}
            {!txns.isLoading && (txns.data ?? []).length === 0 && (
              <li className="text-sm text-muted-foreground">Belum ada transaksi.</li>
            )}
            {(txns.data ?? []).map((t) => (
              <li
                key={t.id}
                className="rounded-lg border border-border bg-secondary/40 px-3 py-2 text-sm"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{txnLabel(t.transaction_type)}</span>
                  <span className="num">{rupiah(t.principal_amount)}</span>
                </div>
                <div className="num mt-1 flex flex-wrap justify-between gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span>
                    {accountLabel(t.source_account)} → {accountLabel(t.destination_account)}
                  </span>
                  <span>
                    fee {rupiah(t.customer_fee)} · laba {rupiah(t.profit_net)} · kas{" "}
                    {rupiah(cashDelta(t))}
                  </span>
                </div>
                {t.note && <p className="mt-1 text-xs text-muted-foreground">{t.note}</p>}
              </li>
            ))}
          </ul>
        </section>
      </div>

      {pendingDebt > 0 && (
        <p className="flex items-center gap-2 rounded-lg border border-border bg-warning/10 px-3 py-2.5 text-xs sm:px-4 sm:py-3 sm:text-sm">
          <TriangleAlert className="size-4 shrink-0 text-warning" />
          <span>
            Ada {rupiah(pendingDebt)} modal tertahan di piutang pelanggan.{" "}
            <Link to="/receivables" className="underline">
              Kelola piutang
            </Link>
          </span>
        </p>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function Kpi({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "cash" | "success" | "warning";
}) {
  const toneClass =
    tone === "cash"
      ? "text-cash"
      : tone === "success"
        ? "text-success"
        : tone === "warning"
          ? "text-warning"
          : "text-foreground";
  return (
    <div className="ledger-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`num mt-2 text-lg font-semibold ${toneClass}`}>{value}</p>
    </div>
  );
}

function TransactionForm({ shiftId, onDone }: { shiftId: string; onDone: () => void }) {
  const [type, setType] = useState<TxnType>("tarik_tunai");
  const preset = TXN_TYPES.find((t) => t.value === type)!;
  const [source, setSource] = useState(preset.source);
  const [destination, setDestination] = useState(preset.destination);
  const [principal, setPrincipal] = useState("");
  const [fee, setFee] = useState("");
  const [cost, setCost] = useState("");
  const [channel, setChannel] = useState<string>("");
  const [note, setNote] = useState("");
  const [isDebt, setIsDebt] = useState(false);
  const [customer, setCustomer] = useState("");
  const [debt, setDebt] = useState("");
  const [due, setDue] = useState("");

  const applyType = (value: TxnType) => {
    const next = TXN_TYPES.find((t) => t.value === value)!;
    setType(value);
    setSource(next.source);
    setDestination(next.destination);
    setChannel("");
  };

  const reset = () => {
    setPrincipal("");
    setFee("");
    setCost("");
    setNote("");
    setIsDebt(false);
    setCustomer("");
    setDebt("");
    setDue("");
  };

  const save = useMutation({
    mutationFn: async () => {
      if (Number(principal || 0) <= 0) throw new Error("Nominal pokok wajib diisi");
      if (isDebt) {
        if (customer.trim().length < 2) throw new Error("Nama customer wajib diisi");
        if (Number(debt || 0) <= 0) throw new Error("Nominal piutang wajib diisi");
      }
      const clientRef = `${shiftId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const { data: txn, error } = await supabase
        .from("transactions")
        .insert({
          shift_id: shiftId,
          transaction_type: type,
          source_account: source,
          destination_account: destination,
          principal_amount: Number(principal || 0),
          customer_fee: Number(fee || 0),
          provider_cost: Number(cost || 0),
          note: [channel, note.trim()].filter(Boolean).join(" · ") || null,
          client_ref: clientRef,
        })
        .select("id")
        .single();
      if (error) throw error;

      if (isDebt) {
        const { error: recvError } = await supabase.from("receivables").insert({
          transaction_id: txn.id,
          shift_id: shiftId,
          customer_name: customer.trim(),
          debt_amount: Number(debt || 0),
          due_date: due || null,
        });
        if (recvError) throw recvError;
      }
    },
    onSuccess: () => {
      toast.success("Transaksi tercatat");
      reset();
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const channels = destination === "saldo_ppob" || source === "saldo_ppob" ? PPOB_PROVIDERS : BANKS;

  return (
    <section className="ledger-card p-4 sm:p-5">
      <h2 className="text-base font-semibold">Input transaksi</h2>
      <p className="mt-1 text-xs text-muted-foreground">{preset.hint}</p>

      <div className="mt-3 flex flex-wrap gap-1.5 sm:mt-4 sm:gap-2">
        {TXN_TYPES.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => applyType(t.value)}
            className={`rounded-lg border px-2.5 py-1.5 text-xs transition-colors sm:px-3 sm:text-sm ${
              type === t.value
                ? "border-primary bg-primary/15 text-foreground"
                : "border-border text-muted-foreground hover:bg-secondary"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <form
        className="mt-4 space-y-3 sm:mt-5 sm:space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground" htmlFor="source">
              Akun sumber
            </Label>
            <select
              id="source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            >
              {ACCOUNTS.map((a) => (
                <option key={a.value} value={a.value} className="bg-card">
                  {a.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground" htmlFor="destination">
              Akun tujuan
            </Label>
            <select
              id="destination"
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            >
              {ACCOUNTS.map((a) => (
                <option key={a.value} value={a.value} className="bg-card">
                  {a.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground" htmlFor="channel">
            Bank / distributor
          </Label>
          <select
            id="channel"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          >
            <option value="" className="bg-card">
              — pilih —
            </option>
            {channels.map((c) => (
              <option key={c} value={c} className="bg-card">
                {c}
              </option>
            ))}
          </select>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <MoneyInput
            id="principal"
            label="Nominal pokok"
            value={principal}
            onChange={setPrincipal}
            required
          />
          <MoneyInput id="fee" label="Fee pelanggan" value={fee} onChange={setFee} />
          <MoneyInput id="cost" label="Biaya provider" value={cost} onChange={setCost} />
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground" htmlFor="note">
            Catatan (opsional)
          </Label>
          <Input
            id="note"
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
            placeholder="No. rekening, no. pelanggan, dll."
          />
        </div>

        <div className="rounded-lg border border-border bg-secondary/40 p-3">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={isDebt} onCheckedChange={(v) => setIsDebt(v === true)} />
            Transaksi ini hutang (piutang customer)
          </label>
          {isDebt && (
            <div className="mt-3 grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground" htmlFor="customer">
                  Nama customer
                </Label>
                <Input
                  id="customer"
                  value={customer}
                  maxLength={80}
                  onChange={(e) => setCustomer(e.target.value)}
                />
              </div>
              <MoneyInput id="debt" label="Nominal piutang" value={debt} onChange={setDebt} />
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground" htmlFor="due">
                  Janji bayar
                </Label>
                <Input
                  id="due"
                  type="date"
                  value={due}
                  onChange={(e) => setDue(e.target.value)}
                  className="num"
                />
              </div>
            </div>
          )}
        </div>

        <Button type="submit" className="w-full" disabled={save.isPending}>
          {save.isPending ? (
            <Loader2 className="mr-2 size-4 animate-spin" />
          ) : (
            <Plus className="mr-2 size-4" />
          )}
          Simpan transaksi
        </Button>
      </form>
    </section>
  );
}
