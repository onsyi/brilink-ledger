import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

type Props = {
  open: boolean;
  onExtend: () => void;
  onLogout: () => void;
};

export function SessionTimeoutDialog({ open, onExtend, onLogout }: Props) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onExtend();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onExtend]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      onClick={onExtend}
    >
      <div
        className="ledger-card w-full max-w-sm p-6 text-center"
        onClick={(e) => e.stopPropagation()}
      >
        <Loader2 className="mx-auto size-8 animate-spin text-warning" />
        <h2 className="mt-4 text-lg font-semibold">Sesi hampir berakhir</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Anda tidak aktif selama beberapa menit. Sesi akan berakhir secara otomatis untuk keamanan.
        </p>
        <div className="mt-6 flex gap-3">
          <Button variant="secondary" className="flex-1" onClick={onLogout}>
            Keluar
          </Button>
          <Button className="flex-1" onClick={onExtend}>
            Tetap di sini
          </Button>
        </div>
      </div>
    </div>
  );
}
