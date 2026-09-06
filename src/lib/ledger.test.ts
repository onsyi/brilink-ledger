import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cashDelta,
  modalAwal,
  modalAkhir,
  labaFee,
  ppobTerpakai,
  fsSetoran,
  fbi,
  summarize,
  type LedgerTxn,
} from "./ledger.js";

describe("BRILink Ledger Accounting Audit Tests", () => {
  describe("cashDelta", () => {
    it("should correctly calculate cashDelta when kas_fisik is source", () => {
      const txn: LedgerTxn = {
        transaction_type: "transfer",
        source_account: "kas_fisik",
        destination_account: "bank_bri",
        principal_amount: 100000,
        customer_fee: 5000,
        provider_cost: 2500,
        profit_net: 2500,
      };
      // Kas keluar untuk pokok (-100.000) tapi kasir menerima fee (+5.000)
      assert.equal(cashDelta(txn), -100000 + 5000);
    });

    it("should correctly calculate cashDelta for tarik_tunai", () => {
      const txn: LedgerTxn = {
        transaction_type: "tarik_tunai",
        source_account: "bank_bri",
        destination_account: "kas_fisik",
        principal_amount: 500000,
        customer_fee: 5000,
        provider_cost: 0,
        profit_net: 5000,
      };
      // Kas keluar 500.000 dari laci ke nasabah, fee 5.000 tunai masuk
      assert.equal(cashDelta(txn), -500000 + 5000);
    });

    it("should correctly calculate cashDelta for setor_tunai", () => {
      const txn: LedgerTxn = {
        transaction_type: "setor_tunai",
        source_account: "kas_fisik",
        destination_account: "bank_bri",
        principal_amount: 500000,
        customer_fee: 5000,
        provider_cost: 0,
        profit_net: 5000,
      };
      // Nasabah menyerahkan 500.000 tunai + fee 5.000 tunai ke kasir
      assert.equal(cashDelta(txn), 500000 + 5000);
    });
  });

  describe("modalAwal & modalAkhir", () => {
    it("should calculate total opening capital across cash, bank, and PPOB", () => {
      const awal = modalAwal({
        initialPhysical: 5000000,
        bankInitials: [10000000, 5000000],
        ppobInitials: [2000000, 1000000],
      });
      assert.equal(awal, 23000000);
    });

    it("should calculate total closing capital including deposit to owner", () => {
      const akhir = modalAkhir({
        finalPhysical: 3000000,
        deposit: 7000000,
        bankFinals: [9000000, 5000000],
        ppobFinals: [1500000, 1000000],
      });
      // 3M di laci + 7M disetor ke owner + 14M bank + 2.5M PPOB = 26.5M
      assert.equal(akhir, 26500000);
    });
  });

  describe("labaFee (Unified Net Fee Profit)", () => {
    it("should report 0 profit for internal transfer / PPOB top-up from bank account", () => {
      // Kasus: Agen transfer 1.000.000 dari rekening bank ke saldo PPOB Digipost
      // Saldo bank turun 1M, saldo PPOB naik 1M. Aset tidak berubah, laba harus 0.
      const profit = labaFee({
        initialPhysical: 2000000,
        finalPhysical: 2000000,
        deposit: 0,
        bankInitials: [10000000],
        bankFinals: [9000000], // Bank berkurang 1M
        ppobInitials: [1000000],
        ppobFinals: [2000000], // PPOB bertambah 1M
        expenses: 0,
        settlement: 0,
        additionalCapital: 0,
      });
      assert.equal(profit, 0);
    });

    it("should report exact transaction fee for PPOB sales paid in cash", () => {
      // Kasus: Pelanggan beli token PLN 100.000 bayar tunai 102.500
      // Kas laci naik 102.500, saldo PPOB turun 100.000. Laba harus +2.500.
      const profit = labaFee({
        initialPhysical: 1000000,
        finalPhysical: 1102500, // +102.500
        deposit: 0,
        bankInitials: [5000000],
        bankFinals: [5000000],
        ppobInitials: [2000000],
        ppobFinals: [1900000], // -100.000
        expenses: 0,
        settlement: 0,
        additionalCapital: 0,
      });
      assert.equal(profit, 2500);
    });

    it("should not treat deposit to owner as an asset loss", () => {
      // Kasus: Kasir melayani setor tunai 5.000.000 fee 10.000 (kas di laci jadi 7.010.000).
      // Sebelum tutup shift, kasir menyerahkan 5.000.000 ke owner (deposit).
      // Sisa kas di laci kasir = 2.010.000.
      // Bank berkurang 5.000.000 karena ditransfer ke rekening nasabah.
      // Laba harus +10.000.
      const profit = labaFee({
        initialPhysical: 2000000,
        finalPhysical: 2010000, // sisa kas di laci
        deposit: 5000000, // uang yang diserahkan ke owner
        bankInitials: [10000000],
        bankFinals: [5000000], // berkurang 5M untuk setor tunai
        ppobInitials: [0],
        ppobFinals: [0],
        expenses: 0,
        settlement: 0,
        additionalCapital: 0,
      });
      assert.equal(profit, 10000);
    });

    it("should add back expenses and deduct additional capital correctly", () => {
      const profit = labaFee({
        initialPhysical: 1000000,
        finalPhysical: 1000000,
        deposit: 0,
        bankInitials: [5000000],
        bankFinals: [5000000],
        ppobInitials: [0],
        ppobFinals: [0],
        expenses: 50000, // Bayar listrik 50.000 dari laci
        settlement: 15000, // Settlement EDC 15.000
        additionalCapital: 200000, // Suntikan modal 200.000
      });
      // 0 + 50.000 + 15.000 - 200.000 = -135.000
      assert.equal(profit, -135000);
    });
  });

  describe("Fee Sharing (FS)", () => {
    it("should calculate 15% from fee profit, not from gross deposit", () => {
      // Jika shift menghasilkan Laba Fee Rp 200.000
      // FS kasir (15%) = Rp 30.000
      assert.equal(fsSetoran(200000), 30000);
    });

    it("should return 0 when profit is 0 or negative (loss)", () => {
      assert.equal(fsSetoran(0), 0);
      assert.equal(fsSetoran(-50000), 0);
    });
  });

  describe("PPOB Terpakai", () => {
    it("should correctly compute balance consumed during shift", () => {
      // Buka 2M, top up 1M, sisa 1.8M -> terpakai 1.2M
      const used = ppobTerpakai({
        ppobInitials: [1000000, 1000000],
        ppobFinals: [1000000, 800000],
        topup: 1000000,
      });
      assert.equal(used, 1200000);
    });
  });

  describe("summarize", () => {
    it("should correctly aggregate shift transactions", () => {
      const txns: LedgerTxn[] = [
        {
          transaction_type: "tarik_tunai",
          source_account: "bank_bri",
          destination_account: "kas_fisik",
          principal_amount: 100000,
          customer_fee: 5000,
          provider_cost: 2000,
          profit_net: 3000,
        },
        {
          transaction_type: "setor_tunai",
          source_account: "kas_fisik",
          destination_account: "bank_bri",
          principal_amount: 200000,
          customer_fee: 6000,
          provider_cost: 2500,
          profit_net: 3500,
        },
      ];
      const summary = summarize(txns);
      assert.equal(summary.count, 2);
      assert.equal(summary.principal, 300000);
      assert.equal(summary.fees, 11000);
      assert.equal(summary.providerCost, 4500);
      assert.equal(summary.profit, 6500);
      // Txn 1 delta = -100k + 5k = -95k (cashOut 95k)
      // Txn 2 delta = +200k + 6k = +206k (cashIn 206k)
      // cashNet = 206k - 95k = 111k
      assert.equal(summary.cashIn, 206000);
      assert.equal(summary.cashOut, 95000);
      assert.equal(summary.cashNet, 111000);
    });
  });
});
