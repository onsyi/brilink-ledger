import { createFileRoute, Link } from "@tanstack/react-router";
import {
  BookOpenCheck,
  ShieldCheck,
  Wallet,
  Layers,
  Clock,
  ArrowRight,
} from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Kasir BRILink — Pembukuan Agen BRILink & PPOB" },
      {
        name: "description",
        content:
          "Ganti buku tulis dan Excel: catat kas fisik dan saldo digital sekaligus, dan tutup shift dalam 10 menit.",
      },
      { property: "og:title", content: "Kasir BRILink — Pembukuan Agen BRILink & PPOB" },
      {
        property: "og:description",
        content:
          "Sistem akuntansi shift untuk agen BRILink & PPOB: ledger dua kantong uang, laba bersih real-time.",
      },
    ],
  }),
  component: Landing,
});

const features = [
  {
    icon: Wallet,
    title: "Dua kantong uang",
    body: "Setiap transaksi menggerakkan kas fisik dan saldo digital sekaligus, tersinkron otomatis.",
  },
  {
    icon: Layers,
    title: "Snapshot 9 bank & 5 PPOB",
    body: "Saldo akhir BRI D, BRI Y, Mandiri, BCA, PAPUA, BNI46, SeaBank, Superbank, FLIP, dan distributor PPOB.",
  },
  {
    icon: Clock,
    title: "Tutup shift < 10 menit",
    body: "Expected balance dihitung otomatis, selisih fisik langsung diberi peringatan variance.",
  },
  {
    icon: ShieldCheck,
    title: "Audit trail & role",
    body: "Owner mengawasi semua shift; kasir hanya shift aktifnya. Data terkunci setelah shift ditutup.",
  },
  {
    icon: BookOpenCheck,
    title: "Laba bersih akurat",
    body: "Nominal pokok, fee pelanggan, dan biaya provider dipisah otomatis.",
  },
];

function Landing() {
  const { user, loading } = useAuth();

  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-10 sm:px-5 sm:py-14 md:py-20 lg:px-6">
      <section className="max-w-3xl">
        <span className="inline-flex items-center gap-2 rounded-full border border-border bg-secondary/60 px-3 py-1 text-xs font-medium text-muted-foreground">
          <span className="size-1.5 rounded-full bg-primary" />
          Sistem arsitektur akuntansi agen BRILink & PPOB
        </span>
        <h1 className="mt-5 text-3xl leading-tight font-bold sm:text-4xl md:mt-6 md:text-6xl">
          Pembukuan shift yang tahu di mana uang Anda berada.
        </h1>
        <p className="mt-4 text-sm text-muted-foreground sm:mt-5 sm:text-base md:text-lg">
          Kas di laci dan saldo di EDC bergerak bersamaan dalam satu transaksi. Aplikasi ini mencatat
          keduanya secara atomik dan menutup shift dengan laporan
          variance yang bisa diaudit.
        </p>
        <div className="mt-6 flex flex-wrap gap-3 sm:mt-8">
          {user && !loading ? (
            <Button asChild size="lg">
              <Link to="/dashboard">
                Buka dashboard <ArrowRight className="ml-1 size-4" />
              </Link>
            </Button>
          ) : (
            <>
              <Button asChild size="lg">
                <Link to="/auth">
                  Masuk / Daftar <ArrowRight className="ml-1 size-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="secondary">
                <Link to="/auth" search={{ mode: "signup" }}>
                  Buat akun kasir
                </Link>
              </Button>
            </>
          )}
        </div>
      </section>

      <section className="responsive-card-stack mt-12 sm:mt-16">
        {features.map((f) => (
          <article key={f.title} className="ledger-card p-4 sm:p-5">
            <f.icon className="size-5 text-primary" aria-hidden />
            <h2 className="mt-3 text-sm font-semibold sm:mt-4 sm:text-base">{f.title}</h2>
            <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground sm:mt-2 sm:text-sm">{f.body}</p>
          </article>
        ))}
      </section>

      <section className="ledger-card mt-10 grid gap-5 p-5 sm:mt-14 sm:grid-cols-2 sm:gap-6 sm:p-7">
        <div>
          <h2 className="text-lg font-semibold sm:text-xl">Owner</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Audit lintas shift, mutasi per akun, rekap laba bersih, dan pengawasan setoran kasir.
          </p>
        </div>
        <div>
          <h2 className="text-lg font-semibold sm:text-xl">Kasir</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Buka shift, input transaksi dengan preset cepat, lalu tutup shift dengan
            saldo bank dan PPOB.
          </p>
        </div>
      </section>
    </main>
  );
}
