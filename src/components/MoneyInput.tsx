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
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        inputMode="numeric"
        className="num"
        value={value}
        required={required}
        onChange={(e) => {
          // Rupiah has no decimals — strip dots and non-numeric chars
          onChange(e.target.value.replace(/[^0-9]/g, ""));
        }}
        placeholder="0"
      />
      <p className="num text-[11px] text-muted-foreground">{hint ?? rupiah(Number(value || 0))}</p>
    </div>
  );
}
