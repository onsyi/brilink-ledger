import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { rupiah } from "@/lib/ledger";

type Props = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  required?: boolean;
};

export function MoneyInput({ id, label, value, onChange, hint, required }: Props) {
  const numericVal = Number(value || 0);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id} className="text-xs font-medium text-muted-foreground">
          {label}
        </Label>
        {numericVal > 0 && (
          <span className="num text-[11px] font-semibold text-primary">{rupiah(numericVal)}</span>
        )}
      </div>
      <div className="relative flex items-center">
        <span className="pointer-events-none absolute left-3 select-none text-xs font-bold text-primary/80">
          Rp
        </span>
        <Input
          id={id}
          inputMode="numeric"
          className="num pl-9 text-sm font-semibold tracking-wide transition-all focus-visible:ring-primary/50"
          value={value}
          required={required}
          onChange={(e) => {
            const raw = e.target.value.replace(/[^0-9]/g, "");
            // Prevent leading zeros (except single "0")
            const cleaned = raw.length > 1 ? raw.replace(/^0+/, "") : raw;
            onChange(cleaned);
          }}
          placeholder="0"
        />
      </div>
      {hint && <p className="num text-[11px] text-muted-foreground">{hint}</p>}
    </div>
  );
}
