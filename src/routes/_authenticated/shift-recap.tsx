import { createFileRoute, Link } from "@tanstack/react-router";
import { ShieldCheck, TableProperties, ArrowLeft } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { ShiftRecapTable } from "@/components/ShiftRecapTable";

export const Route = createFileRoute("/_authenticated/shift-recap")({
  head: () => ({
    meta: [
      { title: "Rincian Tutup Shift — Kasir BRILink" },
      {
        name: "description",
        content: "Audit rincian inputan buka dan tutup shift kasir agen BRILink.",
      },
      { property: "og:title", content: "Rincian Tutup Shift — Kasir BRILink" },
    ],
  }),
  component: ShiftRecapPage,
});

function ShiftRecapPage() {
  const { role, loading } = useAuth();
  const isOwner = role === "owner";

  if (!loading && !isOwner) {
    return (
      <div className="glass-card max-w-xl p-6 sm:p-8 space-y-4">
        <h1 className="text-xl font-bold text-destructive">Akses Khusus Owner</h1>
        <p className="text-sm text-muted-foreground">
          Halaman rincian audit tutup shift kasir hanya dapat diakses oleh akun pemilik (owner).
        </p>
        <Button asChild variant="outline">
          <Link to="/dashboard">
            <ArrowLeft className="mr-1.5 size-4" /> Kembali ke Halaman Utama
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6 sm:space-y-7">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2.5 text-xl font-bold sm:text-2xl">
            <div className="flex size-9 items-center justify-center rounded-xl bg-primary/15 shadow-[0_0_15px_-3px] shadow-primary/20">
              <TableProperties className="size-5 text-primary" />
            </div>
            Rincian Tutup Shift Kasir
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Verifikasi seluruh komponen saldo awal, saldo akhir rekening bank, fisik tutup kasir,
            settlement, pengeluaran, dan laba kasir.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/10 px-3 py-1.5 text-xs font-semibold text-primary">
            <ShieldCheck className="size-3.5" />
            Owner Audit Mode
          </span>
        </div>
      </div>

      {/* Detailed Table */}
      <ShiftRecapTable />
    </div>
  );
}
