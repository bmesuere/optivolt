// Dry-run mapper that attaches DESS decisions per slot.
// Assumes a complete, valid cfg is provided.
//
// Rules implemented:
// - AllowGridFeedin (feedin): 1 when export price >= 0, 0 when export price < 0,
//   -1 when export price is unavailable (unknown case).
// - Restrictions and Strategy are intentionally undecided for now: set to -1.
// - Flags remain 0.
// - socTarget_Wh mirrors the parsed end-of-slot SoC (Wh).
//
// Numbering reference (for later use):
//   Restrictions:
//     0 = No restrictions between battery and the grid
//     1 = Grid → Battery flow restricted
//     2 = Battery → Grid flow restricted
//     3 = No energy flow between battery and grid (both directions blocked)
//   Strategies:
//     0 = Target SOC
//     1 = Self-consumption
//     2 = Pro battery
//     3 = Pro grid

export function mapRowsToDess(rows, cfg) {
  const slotCount = rows.length;
  const perSlot = new Array(slotCount);

  for (let t = 0; t < slotCount; t++) {
    const row = rows[t];

    const exportPriceNow = Number(row.ec);
    let allowGridFeedin;
    let feedinCase;

    if (Number.isFinite(exportPriceNow)) {
      if (exportPriceNow < 0) {
        allowGridFeedin = 0;
        feedinCase = "neg-export-price";
      } else {
        allowGridFeedin = 1;
        feedinCase = "nonneg-export-price";
      }
    } else {
      allowGridFeedin = -1; // unknown case
      feedinCase = "?";
    }

    perSlot[t] = {
      feedin: allowGridFeedin,     // 1 | 0 | -1
      feedinCase,                  // "neg-export-price" | "nonneg-export-price" | "?"
      restrictions: -1,            // undecided
      strategy: -1,                // undecided
      flags: 0,
      socTarget_Wh: Number(row.soc)
    };
  }

  return { perSlot };
}
