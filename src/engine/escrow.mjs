// THE escrow release engine. One definition.
//
// Everything that computes escrow release reads this file: the website's simulator inlines it, the
// workbook's Simulator formulas are a port of it, and tests/escrow-parity.py proves the two agree
// to the dirham on every build. If the arithmetic needs to change, it changes here, the workbook
// formulas are changed to match, and the parity test is what says whether that was done right.
//
// It is written as plain JavaScript with no imports so that it runs identically in a browser, in
// node, and in a test harness, and so that the browser copy can be generated from this file rather
// than retyped.
//
// Every formula below is annotated with the cell it mirrors on the workbook's Simulator sheet.

/** Scenario inputs — the Scenarios sheet, one column. Rates are fractions (0.10), not percentages. */
export const SCENARIOS = [
  { name: 'Base',               delay: 0, pastdue: 6,  undated: 24, cancel: 0,    sell: 0.6, price: 0,     book: 0.10, hand: 0.30, ret: 0.05, cap: 8 },
  { name: 'Delayed handovers',  delay: 6, pastdue: 12, undated: 30, cancel: 0,    sell: 0.4, price: 0,     book: 0.10, hand: 0.30, ret: 0.05, cap: 6 },
  { name: 'Cancellation spike', delay: 0, pastdue: 6,  undated: 24, cancel: 0.15, sell: 0.4, price: 0,     book: 0.10, hand: 0.30, ret: 0.05, cap: 8 },
  { name: 'Price cut',          delay: 0, pastdue: 6,  undated: 24, cancel: 0.05, sell: 0.6, price: -0.15, book: 0.10, hand: 0.30, ret: 0.05, cap: 8 },
];

/** Excel's EDATE: the same day-of-month, n months on, clamped to the month's length. */
export function edate(d, months) {
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + months, day = d.getUTCDate();
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day, last)));
}

/** Whole months between two dates the way the workbook counts them: year and month only. */
export const monthsBetween = (a, b) => (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());

/** Share of the price COLLECTED at certified progress p (cell U8's inner term). */
export const collectedShare = (p, s) => (p >= 100 ? 1 : s.book + (1 - s.book - s.hand) * p / 100);

/** Share of the price RELEASED from escrow at certified progress p: collections drawn down in step
 *  with certified progress (cell Q8's inner term). */
export const releasedShare = (p, s) => collectedShare(p, s) * Math.min(1, p / 100);

/**
 * One project row of the Simulator.
 *   units, sold        register counts (E8, F8)
 *   ticket             average registered ticket, AED (G8)
 *   cert               certified progress, 0-100 (H8)
 *   completion         registered completion date or null (I8)
 *   asOf               the register read date (C3)
 *   s                  scenario
 *   horizons           [{ key, months }] — integer months after asOf, as the grid's row 6 counts them
 * Money is in AED millions, as the sheet has it.
 */
export function projectRow({ units, sold, ticket, cert, completion, asOf, s, horizons = [] }) {
  const contracted = sold * ticket / 1e6;                                  // J8
  const unsold = Math.max(0, units - sold);                                // K8
  const soldPct = units > 0 ? sold / units : 0;                            // L8
  let projected;                                                           // M8
  if (!completion) projected = edate(asOf, s.undated);
  else if (completion < asOf) projected = edate(asOf, s.pastdue);
  else projected = edate(completion, s.delay);
  const months = Math.max(1, monthsBetween(asOf, projected));              // N8
  const pace = Math.min(s.cap, (100 - cert) / months);                     // O8
  const effective = contracted * (1 - s.cancel)
                  + unsold * ticket / 1e6 * s.sell * (1 + s.price);        // P8
  const releasedToDate = contracted * releasedShare(cert, s) * (1 - s.ret); // Q8
  const collectedToDate = contracted * collectedShare(cert, s);            // U8
  const atMonth = t => {                                                   // V8.. (t = row 6)
    const p = Math.min(100, cert + pace * t);
    return Math.max(0, effective * releasedShare(p, s) * (1 - s.ret) - releasedToDate);
  };
  const byHorizon = {};
  for (const h of horizons) byHorizon[h.key] = atMonth(h.months);
  return { contracted, unsold, soldPct, projected, months, pace, effective, releasedToDate, collectedToDate, atMonth, byHorizon };
}
