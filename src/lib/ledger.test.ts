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

    it("should calculate total closing assets in drawer, bank, and PPOB", () => {
      const akhir = modalAkhir({
        finalPhysical: 3000000,
        bankFinals: [9000000, 5000000],
        ppobFinals: [1500000, 1000000],
      });
      // 3M di laci + 14M bank + 2.5M PPOB = 19.5M
      assert.equal(akhir, 19500000);
    });
  });

  describe("labaFee (Laba Fee BRILink)", () => {
    it("should calculate net fee profit from cash & bank changes, expenses, and settlement", () => {
      // Kasus: Tarik tunai / transfer yang menghasilkan fee 10.000
      // Saldo tunai awal 1M, akhir 1.01M (masuk fee 10k), bank tetap
      const profit = labaFee({
        initialPhysical: 1000000,
        finalPhysical: 1010000,
        bankInitials: [5000000],
        bankFinals: [5000000],
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
        bankInitials: [5000000],
        bankFinals: [5000000],
        expenses: 50000, // Bayar listrik 50.000 dari laci
        settlement: 15000, // Settlement EDC 15.000
        additionalCapital: 200000, // Suntikan modal 200.000
      });
      // (1M + 5M + 50.000 + 15.000) - (1M + 5M + 200.000) = 6.065.000 - 6.200.000 = -135.000
      assert.equal(profit, -135000);
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

  describe("Rumus FBI (Laba Fee - PPOB Terpakai)", () => {
    it("should calculate FBI = Laba Fee - PPOB Terpakai", () => {
      assert.equal(fbi({ laba: 1500000, ppobUsed: 1200000 }), 300000);
      assert.equal(fbi({ laba: 500000, ppobUsed: 800000 }), -300000);
      assert.equal(fbi({ laba: 0, ppobUsed: 0 }), 0);
    });
  });

  describe("Rumus FS (Fee Sharing = Setoran x 15%)", () => {
    it("should calculate 15% from deposit amount", () => {
      // Jika kasir mengisi setoran kasir Rp 200.000
      // FS kasir (15%) = Rp 30.000
      assert.equal(fsSetoran(200000), 30000);
      assert.equal(fsSetoran(1000000), 150000);
    });

    it("should return 0 when deposit is 0 or not filled (e.g. Hari Hari 3 & 8)", () => {
      assert.equal(fsSetoran(0), 0);
      assert.equal(fsSetoran(-50000), 0);
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
