export function shiftReadingQty(reading, entry) {
  if (reading.kind !== "opening") return reading.qty;
  const saved = entry?.meters?.[reading.equipment_id];
  if (saved == null || saved === "") return reading.qty;
  const value = Number(saved);
  return Number.isFinite(value) ? value : reading.qty;
}
