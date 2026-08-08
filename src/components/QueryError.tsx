import { RefreshCcw, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";

type Props = {
  message?: string;
  onRetry?: () => void;
};

export function QueryError({
  message = "Gagal memuat data. Periksa koneksi Anda.",
  onRetry,
}: Props) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-8 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-destructive/15">
        <TriangleAlert className="size-5 text-destructive" />
      </div>
      <p className="text-sm text-muted-foreground">{message}</p>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCcw className="mr-1.5 size-3.5" />
          Coba lagi
        </Button>
      )}
    </div>
  );
}
