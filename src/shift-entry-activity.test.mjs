import test from "node:test";
import assert from "node:assert/strict";
import { shiftEntryActivityEvents } from "./shift-entry-activity.mjs";

test("logs add update and delete for lubes payments and expenses", () => {
  const events = shiftEntryActivityEvents({
    beforeLubes: [
      { productId: "p1", productName: "Oil", qty: 2, rate: 450, gst: 18, mode: "cash", vehicle: "", note: "", docNo: "" },
      { productId: "p2", productName: "Grease", qty: 1, rate: 100, gst: 18, mode: "upi", vehicle: "", note: "", docNo: "" },
    ],
    afterLubes: [
      { productId: "p1", productName: "Oil", qty: 3, rate: 450, gst: 18, mode: "cash", vehicle: "", note: "", docNo: "" },
      { productId: "p3", productName: "Coolant", qty: 1, rate: 200, gst: 12, mode: "cash", vehicle: "", note: "", docNo: "" },
    ],
    beforePayments: [
      { mode: "upi", amount: 500, batchId: "B1", customer: "A", at: "2026-01-01" },
    ],
    afterPayments: [
      { mode: "upi", amount: 700, batchId: "B1", customer: "A", at: "2026-01-01" },
      { mode: "card", amount: 200, batchId: "B2", customer: "B", at: "2026-01-01" },
    ],
    beforeExpenses: [{ category: "Maintenance", amount: 100, mode: "cash", note: "" }],
    afterExpenses: [],
    beforeCreditSales: [],
    afterCreditSales: [{ kind: "credit", customerId: "c1", name: "Fleet", phone: "", vehicle: "", amount: 1000 }],
    beforeCreditReceipts: [{ kind: "credit", customerId: "c1", name: "Fleet", phone: "", vehicle: "", amount: 50 }],
    afterCreditReceipts: [],
    beforePumps: [{ equipmentId: "n1", label: "Pump 1", opening: 1000, closing: 1100, test: 0, rate: 100 }],
    afterPumps: [{ equipmentId: "n1", label: "Pump 1", opening: 1000, closing: 1200, test: 1, rate: 100 }],
    beforeAdjustments: [{ type: "out", amount: 100, note: "staff" }],
    afterAdjustments: [
      { type: "out", amount: 150, note: "staff" },
      { type: "in", amount: 50, note: "extra" },
    ],
    beforeEntry: { paymentNotes: "", totals: { cash: 100 } },
    afterEntry: { paymentNotes: "Drawer tallied", totals: { cash: 150 } },
  });

  const details = events.map((event) => event.detail);
  assert.ok(details.some((line) => line.includes("Updated lube / product sale") && line.includes("2→3")));
  assert.ok(details.some((line) => line.includes("Removed lube / product sale") && line.includes("Grease")));
  assert.ok(details.some((line) => line.includes("Added lube / product sale") && line.includes("Coolant")));
  assert.ok(details.some((line) => line.includes("Updated upi payment") && line.includes("500.00→₹700.00")));
  assert.ok(details.some((line) => line.includes("Added card payment")));
  assert.ok(details.some((line) => line.includes("Removed expense: Maintenance")));
  assert.ok(details.some((line) => line.includes("Added credit sale: Fleet")));
  assert.ok(details.some((line) => line.includes("Removed credit received: Fleet")));
  assert.ok(details.some((line) => line.includes("Updated pump reading Pump 1") && line.includes("1100→1200")));
  assert.ok(details.some((line) => line.includes("Updated cash adjustment") && line.includes("100.00→₹150.00")));
  assert.ok(details.some((line) => line.includes("Added cash adjustment (in)")));
  assert.ok(details.some((line) => line.includes("Added Payment notes")));
  assert.ok(details.some((line) => line.includes("Updated cash total")));
});

test("ignores unchanged shift entry sections", () => {
  const row = { productId: "p1", productName: "Oil", qty: 2, rate: 450, gst: 18, mode: "cash", vehicle: "", note: "", docNo: "" };
  const events = shiftEntryActivityEvents({
    beforeLubes: [row],
    afterLubes: [row],
    beforeEntry: { totals: { cash: 10 } },
    afterEntry: { totals: { cash: 10 } },
  });
  assert.deepEqual(events, []);
});
