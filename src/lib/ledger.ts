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
 * Fee BRILink — the BRILink side: physical cash and bank accounts.
 *
 *   (Saldo Tunai Akhir + Saldo Akhir Total Bank + Setoran ke Owner + Pengeluaran + Settlement + Topup PPOB)
 *   - (Saldo Tunai Awal + Saldo Awal Total Bank + Modal Tambahan)
 *
 * Mengapa komponen ini dimasukkan:
 * - Setoran ke owner ditambahkan karena uang kas fisik diserahkan ke owner sebelum sisa kas laci dihitung.
 * - Pengeluaran operasional ditambahkan kembali agar laba kotor fee tidak berkurang oleh biaya listrik/toko.
 * - Settlement ditambahkan sebagai pendapatan fee/batch settlement EDC.
 * - Top-up PPOB ditambahkan kembali karena ditarik/ditransfer dari rekening bank ke PPOB, sehingga sisi perbankan
 *   tidak tekor akibat pemindahan saldo internal.
 * - Modal tambahan dikurangkan karena merupakan suntikan modal mid-shift.
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
  const bankInitialTotal = opts.bankInitials.reduce((s, n) => s + n, 0);
  const bankFinalTotal = opts.bankFinals.reduce((s, n) => s + n, 0);
  const deposit = num(opts.deposit);
  const topup = num(opts.topup);
  return (
    opts.finalPhysical +
    bankFinalTotal +
    deposit +
    opts.expenses +
    opts.settlement +
    topup -
    (opts.initialPhysical + bankInitialTotal + opts.additionalCapital)
  );
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
