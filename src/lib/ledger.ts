export const BANKS = [
  "BRI D",
  "BRI Y",
  "Mandiri",
  "BCA",
  "PAPUA",
  "BNI46",
  "SEABANK",
  "SUPERBANK",
  "FLIP",
] as const;

export const PPOB_PROVIDERS = [
  "Digipost",
  "Anggichanger",
  "Radar",
  "Saveplus",
  "I-Simpel",
] as const;

export const ACCOUNTS = [
  { value: "kas_fisik", label: "Saldo Fisik (Kas)" },
  { value: "saldo_bank", label: "Saldo Digital (Bank/EDC)" },
  { value: "saldo_ppob", label: "Saldo PPOB" },
] as const;

export type TxnType = "tarik_tunai" | "setor_tunai" | "transfer" | "ppob";

export const TXN_TYPES: {
  value: TxnType;
  label: string;
  source: string;
  destination: string;
  hint: string;
}[] = [
  {
    value: "tarik_tunai",
    label: "Tarik Tunai",
    source: "kas_fisik",
    destination: "saldo_bank",
    hint: "Kas fisik (-), saldo digital (+)",
  },
  {
    value: "setor_tunai",
    label: "Setor Tunai",
    source: "saldo_bank",
    destination: "kas_fisik",
    hint: "Saldo digital (-), kas fisik (+)",
  },
  {
    value: "transfer",
    label: "Transfer",
    source: "kas_fisik",
    destination: "saldo_bank",
    hint: "Kas fisik (+ dari pelanggan), saldo digital (-)",
  },
  {
    value: "ppob",
    label: "PPOB / Tagihan",
    source: "kas_fisik",
    destination: "saldo_ppob",
    hint: "Kas fisik (+ dari pelanggan), saldo PPOB (-)",
  },
];

export function txnLabel(type: string) {
  return TXN_TYPES.find((t) => t.value === type)?.label ?? type;
}

export function accountLabel(value: string) {
  return ACCOUNTS.find((a) => a.value === value)?.label ?? value;
}

export const rupiah = (value: number | string | null | undefined) =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(Number(value ?? 0));

export const num = (value: number | string | null | undefined) => Number(value ?? 0);

export type LedgerTxn = {
  transaction_type: string;
  source_account: string;
  destination_account: string;
  principal_amount: number | string;
  customer_fee: number | string;
  provider_cost: number | string;
  profit_net: number | string | null;
};

/**
 * Cash movement per transaction:
 * - cash leaves the drawer when kas_fisik is the source of the principal
 * - cash enters the drawer when kas_fisik is the destination, or when the
 *   customer hands over cash (transfer / PPOB) plus the admin fee.
 */
export function cashDelta(t: LedgerTxn) {
  const principal = num(t.principal_amount);
  const fee = num(t.customer_fee);
  if (t.transaction_type === "tarik_tunai") return -principal + fee;
  if (t.transaction_type === "setor_tunai") return principal + fee;
  if (t.source_account === "kas_fisik" && t.destination_account !== "kas_fisik")
    return principal + fee;
  if (t.destination_account === "kas_fisik") return principal + fee;
  return fee;
}

/** Validate a transaction before insert. Returns error message or null. */
export function validateTxn(t: LedgerTxn): string | null {
  const principal = num(t.principal_amount);
  const fee = num(t.customer_fee);
  const cost = num(t.provider_cost);
  if (principal < 0) return "Pokok transaksi tidak boleh negatif";
  if (fee < 0) return "Fee pelanggan tidak boleh negatif";
  if (cost < 0) return "Biaya provider tidak boleh negatif";
  if (t.transaction_type === "tarik_tunai" && fee > principal)
    return "Fee tidak boleh melebihi pokok transaksi";
  return null;
}

export function digitalDelta(t: LedgerTxn) {
  const principal = num(t.principal_amount);
  if (t.destination_account === "saldo_bank" || t.destination_account === "saldo_ppob")
    return t.transaction_type === "tarik_tunai" ? principal : -principal;
  if (t.source_account === "saldo_bank" || t.source_account === "saldo_ppob") return -principal;
  return 0;
}

export type ShiftSummary = {
  count: number;
  principal: number;
  fees: number;
  providerCost: number;
  profit: number;
  cashIn: number;
  cashOut: number;
  cashNet: number;
};

export function summarize(txns: LedgerTxn[]): ShiftSummary {
  return txns.reduce<ShiftSummary>(
    (acc, t) => {
      const delta = cashDelta(t);
      acc.count += 1;
      acc.principal += num(t.principal_amount);
      acc.fees += num(t.customer_fee);
      acc.providerCost += num(t.provider_cost);
      acc.profit += num(t.customer_fee) - num(t.provider_cost);
      if (delta >= 0) acc.cashIn += delta;
      else acc.cashOut += Math.abs(delta);
      acc.cashNet += delta;
      return acc;
    },
    {
      count: 0,
      principal: 0,
      fees: 0,
      providerCost: 0,
      profit: 0,
      cashIn: 0,
      cashOut: 0,
      cashNet: 0,
    },
  );
}

/** Expected physical cash at closing time. */
export function expectedCash(opts: {
  initial: number;
  cashNet: number;
  pendingReceivables: number;
  expenses: number;
}) {
  return opts.initial + opts.cashNet - opts.pendingReceivables - opts.expenses;
}
