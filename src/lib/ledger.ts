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

/**
 * Modal awal (opening capital): physical cash + opening balances of every
 * bank & PPOB account.
 */
export function modalAwal(opts: {
  initialPhysical: number;
  bankInitials: number[];
  ppobInitials: number[];
}) {
  return (
    opts.initialPhysical +
    opts.bankInitials.reduce((s, n) => s + n, 0) +
    opts.ppobInitials.reduce((s, n) => s + n, 0)
  );
}

/**
 * Modal akhir (gross closing capital): final physical cash + final bank/PPOB balances.
 * Laba/rugi shift dihitung dengan modalAkhir - modalAwal.
 */
export function modalAkhir(opts: {
  finalPhysical: number;
  bankFinals: number[];
  ppobFinals: number[];
}) {
  return (
    opts.finalPhysical +
    opts.bankFinals.reduce((s, n) => s + n, 0) +
    opts.ppobFinals.reduce((s, n) => s + n, 0)
  );
}

/**
 * Laba Fee (fee profit) — the BRILink side only: physical cash and bank
 * accounts.
 *
 *   (Saldo Akhir + total saldo rekening AKHIR + settlement)
 *   - (Saldo Awal + total saldo rekening AWAL)
 *
 * Two things are deliberately absent.
 *
 * PPOB: its balances and its top-up are settled on their own ledger via
 * {@link ppobTerpakai}. Folding the top-up in here double-counted it,
 * because buying PPOB balance out of a bank account already shows up as a
 * drop in the closing bank total.
 *
 * Pengeluaran and setoran owner: recorded and reported, never calculated.
 * Cash spent on operating costs leaves the drawer, so it lowers Laba Fee
 * through the closing cash figure on its own; adding it back would cancel
 * that out. Both remain visible as their own columns in Laporan.
 */
export function labaFee(opts: {
  initialPhysical: number;
  finalPhysical: number;
  bankInitials: number[];
  bankFinals: number[];
  settlement: number;
}) {
  const bankInitialTotal = opts.bankInitials.reduce((s, n) => s + n, 0);
  const bankFinalTotal = opts.bankFinals.reduce((s, n) => s + n, 0);
  return (
    opts.finalPhysical +
    bankFinalTotal +
    opts.settlement -
    (opts.initialPhysical + bankInitialTotal)
  );
}

/**
 * Saldo PPOB yang terpakai selama shift — kept entirely separate from
 * Laba Fee, since PPOB top-ups have nothing to do with the BRILink books.
 *
 *   total saldo awal PPOB + penambahan saldo - total saldo akhir PPOB
 */
export function ppobTerpakai(opts: {
  ppobInitials: number[];
  ppobFinals: number[];
  topup: number;
}) {
  const initialTotal = opts.ppobInitials.reduce((s, n) => s + n, 0);
  const finalTotal = opts.ppobFinals.reduce((s, n) => s + n, 0);
  return initialTotal + opts.topup - finalTotal;
}
