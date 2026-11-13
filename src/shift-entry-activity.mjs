function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function text(value, max = 80) {
  return String(value ?? "").trim().slice(0, max);
}

function moneyText(value) {
  return `₹${round2(value).toFixed(2)}`;
}

function countBag(items, keyOf) {
  const map = new Map();
  for (const item of items) {
    const key = keyOf(item);
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }
  return map;
}

/** Pair before/after rows by soft key, then classify add / update / remove. */
export function diffRows(before, after, { softKey, fingerprint, describe }) {
  const beforeMap = countBag(before, softKey);
  const afterMap = countBag(after, softKey);
  const events = [];
  const keys = new Set([...beforeMap.keys(), ...afterMap.keys()]);

  for (const key of keys) {
    const prev = [...(beforeMap.get(key) ?? [])];
    const next = [...(afterMap.get(key) ?? [])];
    while (prev.length && next.length) {
      const left = prev.shift();
      const right = next.shift();
      if (fingerprint(left) !== fingerprint(right)) {
        events.push({ action: "updated", detail: describe("updated", left, right) });
      }
    }
    for (const row of next) events.push({ action: "created", detail: describe("created", null, row) });
    for (const row of prev) events.push({ action: "deleted", detail: describe("deleted", row, null) });
  }
  return events;
}

function pumpSoft(row) {
  return String(row.equipmentId || row.equipment_id || "");
}

function pumpFinger(row) {
  return [
    round2(row.opening),
    round2(row.closing),
    round2(row.test ?? row.test_qty ?? 0),
    round2(row.rate ?? 0),
  ].join("|");
}

function describePump(kind, before, after) {
  const row = after || before;
  const label = text(row.label || row.equipmentId || row.equipment_id, 40) || "Pump";
  if (kind === "created") {
    return `Added pump reading ${label}: opening ${row.opening}, closing ${row.closing}`;
  }
  if (kind === "deleted") {
    return `Removed pump reading ${label}`;
  }
  return `Updated pump reading ${label}: opening ${before.opening}→${after.opening}, closing ${before.closing}→${after.closing}, test ${before.test ?? 0}→${after.test ?? 0}`;
}

function lubeSoft(row) {
  return String(row.productId || row.product_id || "");
}

function lubeFinger(row) {
  return [
    row.productId || row.product_id || "",
    round2(row.qty),
    round2(row.rate),
    round2(row.discount ?? 0),
    round2(row.gst ?? 0),
    text(row.mode),
    text(row.vehicle),
    text(row.note),
    text(row.docNo || row.doc_no),
  ].join("|");
}

function describeLube(kind, before, after) {
  const row = after || before;
  const name = text(row.productName || row.product_name || row.description || row.productId || row.product_id, 40) || "Product";
  if (kind === "created") {
    return `Added lube / product sale: ${name} × ${round2(row.qty)} @ ${moneyText(row.rate)} (${text(row.mode) || "cash"})`;
  }
  if (kind === "deleted") {
    return `Removed lube / product sale: ${name} × ${round2(row.qty)}`;
  }
  return `Updated lube / product sale: ${name} × ${round2(before.qty)}→${round2(after.qty)} @ ${moneyText(before.rate)}→${moneyText(after.rate)}, discount ${round2(before.discount ?? 0)}%→${round2(after.discount ?? 0)}%, GST ${round2(before.gst ?? 0)}%→${round2(after.gst ?? 0)}%`;
}

function paySoft(row) {
  return `${text(row.mode)}|${text(row.batchId || row.reference)}|${text(row.customer || row.party_name || row.vehicle)}`;
}

function payFinger(row) {
  return [
    text(row.mode),
    round2(row.amount ?? row.net),
    text(row.batchId || row.reference),
    text(row.customer || row.party_name || row.vehicle),
    text(row.at || row.created_at),
  ].join("|");
}

function describePay(kind, before, after) {
  const row = after || before;
  const mode = text(row.mode) || "payment";
  const amount = moneyText(row.amount ?? row.net);
  const batch = text(row.batchId || row.reference);
  const who = text(row.customer || row.party_name || row.vehicle);
  const extra = [who && `customer ${who}`, batch && `batch ${batch}`].filter(Boolean).join(", ");
  if (kind === "created") return `Added ${mode} payment ${amount}${extra ? ` (${extra})` : ""}`;
  if (kind === "deleted") return `Removed ${mode} payment ${amount}${extra ? ` (${extra})` : ""}`;
  return `Updated ${mode} payment ${moneyText(before.amount ?? before.net)}→${moneyText(after.amount ?? after.net)}${extra ? ` (${extra})` : ""}`;
}

function expenseSoft(row) {
  return `${text(row.category)}|${text(row.mode)}|${text(row.note)}`;
}

function expenseFinger(row) {
  return [text(row.category), round2(row.amount), text(row.mode), text(row.note)].join("|");
}

function describeExpense(kind, before, after) {
  const row = after || before;
  const label = text(row.category) || "Expense";
  if (kind === "created") return `Added expense: ${label} ${moneyText(row.amount)} (${text(row.mode) || "cash"})`;
  if (kind === "deleted") return `Removed expense: ${label} ${moneyText(row.amount)}`;
  return `Updated expense: ${label} ${moneyText(before.amount)}→${moneyText(after.amount)}`;
}

function creditSoft(row) {
  return `${text(row.kind)}|${row.customerId || ""}|${text(row.name)}`;
}

function creditFinger(row) {
  return [text(row.kind), row.customerId || "", text(row.name), text(row.phone), text(row.vehicle), round2(row.amount)].join("|");
}

function describeCredit(kind, before, after, noun) {
  const row = after || before;
  const who = text(row.name) || "Customer";
  const type = row.kind === "temp_credit" ? "temporary credit" : "credit";
  if (kind === "created") return `Added ${noun}: ${who} (${type}) ${moneyText(row.amount)}`;
  if (kind === "deleted") return `Removed ${noun}: ${who} (${type}) ${moneyText(row.amount)}`;
  return `Updated ${noun}: ${who} ${moneyText(before.amount)}→${moneyText(after.amount)}`;
}

function adjustSoft(row) {
  return `${text(row.type || row.category)}|${text(row.note)}`;
}

function adjustFinger(row) {
  return `${text(row.type || row.category)}|${round2(row.amount)}|${text(row.note)}`;
}

function describeAdjust(kind, before, after) {
  const row = after || before;
  const type = text(row.type || row.category) || "adjustment";
  if (kind === "created") return `Added cash adjustment (${type}): ${moneyText(row.amount)}`;
  if (kind === "deleted") return `Removed cash adjustment (${type}): ${moneyText(row.amount)}`;
  return `Updated cash adjustment (${type}): ${moneyText(before.amount)}→${moneyText(after.amount)}`;
}

function entryNoteEvents(beforeEntry, afterEntry) {
  const fields = [
    ["remarks", "Shift remarks"],
    ["lubeNotes", "Lube notes"],
    ["paymentNotes", "Payment notes"],
    ["weather", "Weather"],
    ["footfall", "Footfall"],
    ["events", "Events"],
    ["otherNotes", "Other notes"],
    ["incidentType", "Incident type"],
    ["incidentDescription", "Incident description"],
    ["incidentStatus", "Incident status"],
    ["handoverNotes", "Handover notes"],
  ];
  const events = [];
  for (const [key, label] of fields) {
    const prev = text(beforeEntry?.[key], 200);
    const next = text(afterEntry?.[key], 200);
    if (prev === next) continue;
    if (!prev && next) events.push({ action: "created", detail: `Added ${label}: ${next}` });
    else if (prev && !next) events.push({ action: "deleted", detail: `Cleared ${label}` });
    else events.push({ action: "updated", detail: `Updated ${label}` });
  }
  const prevCash = round2(beforeEntry?.totals?.cash);
  const nextCash = round2(afterEntry?.totals?.cash);
  if (prevCash !== nextCash) {
    events.push({ action: "updated", detail: `Updated cash total ${moneyText(prevCash)}→${moneyText(nextCash)}` });
  }
  return events;
}

export function shiftEntryActivityEvents({
  beforePumps = [],
  afterPumps = [],
  beforeLubes = [],
  afterLubes = [],
  beforePayments = [],
  afterPayments = [],
  beforeExpenses = [],
  afterExpenses = [],
  beforeCreditSales = [],
  afterCreditSales = [],
  beforeCreditReceipts = [],
  afterCreditReceipts = [],
  beforeAdjustments = [],
  afterAdjustments = [],
  beforeEntry = {},
  afterEntry = {},
}) {
  const events = [];

  events.push(...diffRows(beforePumps, afterPumps, {
    softKey: pumpSoft,
    fingerprint: pumpFinger,
    describe: describePump,
  }));

  events.push(...diffRows(beforeLubes, afterLubes, {
    softKey: lubeSoft,
    fingerprint: lubeFinger,
    describe: describeLube,
  }));

  events.push(...diffRows(beforePayments, afterPayments, {
    softKey: paySoft,
    fingerprint: payFinger,
    describe: describePay,
  }));

  events.push(...diffRows(beforeExpenses, afterExpenses, {
    softKey: expenseSoft,
    fingerprint: expenseFinger,
    describe: describeExpense,
  }));

  events.push(...diffRows(beforeCreditSales, afterCreditSales, {
    softKey: creditSoft,
    fingerprint: creditFinger,
    describe: (kind, before, after) => describeCredit(kind, before, after, "credit sale"),
  }));

  events.push(...diffRows(beforeCreditReceipts, afterCreditReceipts, {
    softKey: creditSoft,
    fingerprint: creditFinger,
    describe: (kind, before, after) => describeCredit(kind, before, after, "credit received"),
  }));

  events.push(...diffRows(beforeAdjustments, afterAdjustments, {
    softKey: adjustSoft,
    fingerprint: adjustFinger,
    describe: describeAdjust,
  }));

  events.push(...entryNoteEvents(beforeEntry, afterEntry));
  return events;
}

export async function writeShiftEntryActivity(client, {
  user,
  outletId,
  shiftId,
  events,
}) {
  for (const event of events) {
    if (!event?.detail) continue;
    await client.query(
      `INSERT INTO activity (outlet_id, actor_id, action, detail, target_table, target_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [outletId, user.id, event.action || "updated", event.detail, "shifts", shiftId],
    );
  }
}
