import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { rupiah } from "@/lib/ledger";
import { cn } from "@/lib/utils";
import { Lock } from "lucide-react";

type Props = {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  required?: boolean;
  readOnly?: boolean;
  disabled?: boolean;
};

export function MoneyInput({
  id,
  label,
  value,
  onChange,
  hint,
  required,
  readOnly,
  disabled,
}: Props) {
  const numericVal = Number(value || 0);
  const isLocked = readOnly || disabled;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label
          htmlFor={id}
          className={cn(
            "text-xs font-medium text-muted-foreground flex items-center gap-1.5",
            isLocked && "text-muted-foreground/80",
          )}
        >
          <span>{label}</span>
          {isLocked && <Lock className="size-3 text-muted-foreground/70" />}
        </Label>
        {numericVal > 0 && (
          <span
            className={cn(
              "num text-[11px] font-semibold",
              isLocked ? "text-primary/75" : "text-primary",
            )}
          >
            {rupiah(numericVal)}
          </span>
        )}
      </div>
      <div className="relative flex items-center">
        <span
          className={cn(
            "pointer-events-none absolute left-3 select-none text-xs font-bold transition-colors",
            isLocked ? "text-muted-foreground/60" : "text-primary/80",
          )}
        >
          Rp
        </span>
        <Input
          id={id}
          inputMode="numeric"
          readOnly={readOnly}
          disabled={disabled}
          tabIndex={isLocked ? -1 : undefined}
          className={cn(
            "num pl-9 text-sm font-semibold tracking-wide transition-all focus-visible:ring-primary/50",
            isLocked &&
              "bg-secondary/40 text-muted-foreground border-border/40 cursor-not-allowed select-none focus-visible:ring-0 focus-visible:border-border/40",
          )}
          value={value ?? ""}
          required={required}
          onChange={(e) => {
            if (isLocked) return;
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
