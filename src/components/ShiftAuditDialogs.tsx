import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, ScanLine, Undo2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MoneyInput } from "@/components/MoneyInput";
import { BANKS, num, PPOB_PROVIDERS, rupiah } from "@/lib/ledger";

export const SHIFT_FIELDS = [
  { key: "total_expenses", label: "Pengeluaran" },
  { key: "settlement_amount", label: "Settlement" },
  { key: "final_physical_balance", label: "Kas Fisik Akhir (S.Akhir Tutup Kasir)" },
  { key: "additional_capital", label: "Modal Tambahan (Penambahan Saldo)" },
  { key: "deposit_amount", label: "Setoran" },
] as const;

/**
 * Dialog penolakan laporan tutup shift oleh owner.
 * Mengembalikan shift ke status 'open' agar kasir memperbaiki angka laporannya.
 */
export function RejectReportDialog({
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
      queryClient.invalidateQueries({ queryKey: ["shift-recap"] });
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
              Saldo tunai akhir, saldo bank/PPOB akhir, pengeluaran, setoran, dan settlement
              dikosongkan.
              {shift.depositConfirmed
                ? " Konfirmasi setoran ikut dibatalkan — setoran perlu dikonfirmasi ulang setelah kasir menutup shift lagi."
                : ""}{" "}
              Modal awal shift tidak berubah.
            </p>
            <p className="text-muted-foreground">
              Hanya shift terakhir di cabang yang bisa ditolak. Kalau saldo penutupannya sudah
              dipakai sebagai modal awal shift berikutnya, gunakan tombol Audit.
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
 * Dialog audit dan koreksi saldo per-mesin atau kolom shift oleh owner.
 * Menggunakan RPC owner_adjust_balance atau owner_adjust_shift_field.
 */
export function BalanceAuditDialog({
  shift,
  onClose,
}: {
  shift: { id: string; cashier: string; startedAt: string; status?: string };
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<"bank" | "ppob" | "shift">("bank");
  const [name, setName] = useState<string>(BANKS[0]);
  const [field, setField] = useState<"initial" | "final">("final");
  const [shiftField, setShiftField] = useState<string>(SHIFT_FIELDS[0].key);
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");

  const balances = useQuery({
    queryKey: ["audit-balances", shift.id],
    queryFn: async () => {
      const [bankRes, ppobRes, shiftRes] = await Promise.all([
        supabase
          .from("bank_balances")
          .select("bank_name, initial_amount, final_amount")
          .eq("shift_id", shift.id),
        supabase
          .from("ppob_balances")
          .select("provider_name, initial_amount, final_amount")
          .eq("shift_id", shift.id),
        supabase
          .from("shifts")
          .select(
            "total_expenses, settlement_amount, final_physical_balance, additional_capital, deposit_amount",
          )
          .eq("id", shift.id)
          .single(),
      ]);
      if (bankRes.error) throw bankRes.error;
      if (ppobRes.error) throw ppobRes.error;
      if (shiftRes.error) throw shiftRes.error;
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
      return { bankPpob: map, shiftRow: shiftRes.data };
    },
  });

  const options =
    kind === "bank"
      ? [...BANKS]
      : kind === "ppob"
        ? [...PPOB_PROVIDERS]
        : SHIFT_FIELDS.map((f) => f.key);
  const current = kind === "shift" ? undefined : balances.data?.bankPpob.get(`${kind}:${name}`);
  const currentValue =
    kind === "shift"
      ? num(balances.data?.shiftRow?.[shiftField as keyof typeof balances.data.shiftRow] ?? 0)
      : field === "initial"
        ? (current?.initial ?? 0)
        : (current?.final ?? 0);

  const save = useMutation({
    mutationFn: async () => {
      if (value === "") throw new Error("Nilai baru wajib diisi");
      if (reason.trim().length < 5)
        throw new Error("Alasan audit wajib diisi (minimal 5 karakter)");
      if (kind === "shift") {
        const { error } = await supabase.rpc("owner_adjust_shift_field", {
          _shift_id: shift.id,
          _field: shiftField,
          _new_value: Number(value),
          _reason: reason.trim(),
        });
        if (error) throw error;
      } else {
        const { error } = await supabase.rpc("owner_adjust_balance", {
          _shift_id: shift.id,
          _kind: kind,
          _name: name,
          _field: field,
          _new_value: Number(value),
          _reason: reason.trim(),
        });
        if (error) throw error;
      }
    },
    onSuccess: () => {
      toast.success("Koreksi tercatat di riwayat audit");
      queryClient.invalidateQueries({ queryKey: ["shift-reports"] });
      queryClient.invalidateQueries({ queryKey: ["shift-recap"] });
      queryClient.invalidateQueries({ queryKey: ["shift-amendments"] });
      queryClient.invalidateQueries({ queryKey: ["owner-overview"] });
      queryClient.invalidateQueries({ queryKey: ["deposit-shifts"] });
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
            <ScanLine className="size-5 text-primary" /> Audit Angka Penutupan
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
                  const k = e.target.value as "bank" | "ppob" | "shift";
                  setKind(k);
                  setName(
                    k === "bank"
                      ? BANKS[0]
                      : k === "ppob"
                        ? PPOB_PROVIDERS[0]
                        : SHIFT_FIELDS[0].key,
                  );
                }}
              >
                <option value="bank">Bank</option>
                <option value="ppob">PPOB</option>
                {shift.status !== "open" && <option value="shift">Angka Penutupan (Shift)</option>}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="audit-name" className="text-xs text-muted-foreground">
                {kind === "shift" ? "Kolom" : "Akun"}
              </Label>
              <select
                id="audit-name"
                value={kind === "shift" ? shiftField : name}
                className={selectClass}
                onChange={(e) => {
                  if (kind === "shift") {
                    setShiftField(e.target.value);
                  } else {
                    setName(e.target.value);
                  }
                }}
              >
                {(kind === "shift"
                  ? SHIFT_FIELDS.map((f) => ({ value: f.key, label: f.label }))
                  : options.map((o) => ({ value: o, label: o }))
                ).map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            {kind !== "shift" && (
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
            )}
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
