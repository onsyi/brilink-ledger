export const BANKS = [
  "BRI D",
  "BRI Y",
  // Saldo BRILink itu sendiri. Duduk di sisi bank, bukan PPOB, karena fee
  // transaksi BRILink mendarat di sini -- labaFee() menjumlah saldo bank, jadi
  // menaruhnya di PPOB akan membuat fee yang diterima hilang dari laba.
  "Link",
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

export const num = (value: number | string | null | undefined) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

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
    return -principal + fee;
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
 * Rumus Saldo Awal:
 * Saldo semua rekening shift sebelumnya + Saldo Awal Buka Kasir + Penambahan Modal
 * Tidak bisa ditambahkan dengan PPOB karena masing-masing berdiri sendiri.
 */
export function saldoAwal(opts: {
  initialPhysical: number;
  bankInitials: number[];
  additionalCapital?: number;
}) {
  const bankTotal = opts.bankInitials.reduce((s, n) => s + num(n), 0);
  return num(opts.initialPhysical) + bankTotal + num(opts.additionalCapital);
}

/**
 * Rumus Saldo Akhir:
 * Saldo uang Fisik tutup kasir + Saldo rekening Bank tutup kasir + settlement + Pengeluaran
 * Tidak bisa ditambahkan dengan PPOB karena masing-masing berdiri sendiri.
 */
export function saldoAkhir(opts: {
  finalPhysical: number;
  bankFinals: number[];
  settlement?: number;
  expenses?: number;
}) {
  const bankTotal = opts.bankFinals.reduce((s, n) => s + num(n), 0);
  return (
    num(opts.finalPhysical) +
    bankTotal +
    num(opts.settlement) +
    num(opts.expenses)
  );
}

/**
 * Rumus Laba:
 * Saldo Akhir - Saldo Awal
 */
export function hitungLaba(opts: {
  saldoAkhir: number;
  saldoAwal: number;
}) {
  return opts.saldoAkhir - opts.saldoAwal;
}

/**
 * Modal Awal (Legacy/Alias kompatibilitas)
 */
export function modalAwal(opts: {
  initialPhysical: number;
  bankInitials: number[];
  ppobInitials?: number[];
  additionalCapital?: number;
}) {
  return saldoAwal({
    initialPhysical: opts.initialPhysical,
    bankInitials: opts.bankInitials,
    additionalCapital: opts.additionalCapital,
  });
}

/**
 * Modal Akhir (Legacy/Alias kompatibilitas)
 */
export function modalAkhir(opts: {
  finalPhysical: number;
  bankFinals: number[];
  ppobFinals?: number[];
  settlement?: number;
  expenses?: number;
}) {
  return saldoAkhir({
    finalPhysical: opts.finalPhysical,
    bankFinals: opts.bankFinals,
    settlement: opts.settlement,
    expenses: opts.expenses,
  });
}

/**
 * Laba Fee / Laba BRILink:
 * Saldo Akhir - Saldo Awal
 */
export function labaFee(opts: {
  initialPhysical: number;
  finalPhysical: number;
  bankInitials: number[];
  bankFinals: number[];
  expenses: number;
  settlement: number;
  additionalCapital: number;
  deposit?: number;
  topup?: number;
}) {
  const awal = saldoAwal({
    initialPhysical: opts.initialPhysical,
    bankInitials: opts.bankInitials,
    additionalCapital: opts.additionalCapital,
  });
  const akhir = saldoAkhir({
    finalPhysical: opts.finalPhysical,
    bankFinals: opts.bankFinals,
    settlement: opts.settlement,
    expenses: opts.expenses,
  });
  return hitungLaba({ saldoAkhir: akhir, saldoAwal: awal });
}

/**
 * Pemakaian PPOB — volume saldo PPOB yang terpakai selama shift.
 *
 *   (Saldo Awal PPOB 1 + PPOB 2 + …) + Penambahan Saldo
 *   - (Saldo Akhir PPOB 1 + PPOB 2 + …)
 *
 * Bernilai positif saat saldo terpakai untuk transaksi pelanggan.
 */
export function ppobTerpakai(opts: {
  ppobInitials: number[];
  ppobFinals: number[];
  topup: number;
}) {
  const initialTotal = opts.ppobInitials.reduce((s, n) => s + n, 0);
  const finalTotal = opts.ppobFinals.reduce((s, n) => s + n, 0);
  return initialTotal + num(opts.topup) - finalTotal;
}

/**
 * Porsi setoran kasir yang dihitung sebagai FS (15%).
 */
export const FS_RATE = 0.15;

/**
 * Rumus FBI = Laba Fee - PPOB terpakai.
 */
export function fbi(opts: { laba: number; ppobUsed: number }) {
  return opts.laba - opts.ppobUsed;
}

/**
 * Rumus FS = Setoran x 15%, dibulatkan ke rupiah penuh.
 * Kasir yang tidak mengisi setoran kasir (setoran = 0) menghasilkan FS = 0.
 */
export function fsSetoran(deposit: number, rate = FS_RATE) {
  const d = num(deposit);
  if (d <= 0) return 0;
  return Math.round(d * rate);
}
