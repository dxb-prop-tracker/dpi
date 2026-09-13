// One identity for a DLD transaction, whatever feed it arrived on.
//
// The three feeds write the same transaction number in two different shapes:
//   bulk dump / open-data API   G-P-Y-S    1-11-2026-26618    (group, procedure, year, serial)
//   DLD website export          P-S-Y      11-26618-2026      (procedure, serial, year)
// and they disagree about the DATE: the website (and the register's own screen) carries the
// date the sale was registered, while the bulk dump and the API carry the next working day for
// anything registered from about 16:00 — so 27 August 16:56 arrives as 28 August, a Friday sale
// arrives on Monday. Matching on number + date therefore let the same sale in twice, which is
// what inflated June-August 2026 by 30-40%. Nothing may key a transaction on its date again.
//
// The key is procedure|year|serial|group. Verified against the whole register: 1.77m bulk rows
// produce no collisions at all, and the leading digit of the four-part form maps exactly to the
// group name (1 Sales, 2 Mortgages, 3 Gifts), so the group is recoverable even without the name.

const GROUP_BY_LEAD: Record<string, string> = { '1': 'Sales', '2': 'Mortgages', '3': 'Gifts' };

/** The transaction number itself, stripped of the suffix we add to make our primary key unique. */
export function txNumber(storedId: string): string {
  const id = String(storedId ?? '').trim();
  if (id.startsWith('w#')) {
    const rest = id.slice(2);
    const hash = rest.indexOf('#');
    return hash < 0 ? rest : rest.slice(0, hash);
  }
  const hash = id.indexOf('#');
  return hash < 0 ? id : id.slice(0, hash);
}

/** Canonical key, or null if the number is not a shape we recognise (never guess). */
export function txKey(storedIdOrNumber: string, group?: string | null): string | null {
  const num = txNumber(storedIdOrNumber);
  if (!num) return null;
  const parts = num.split('-');
  let proc: string, year: string, serial: string, lead: string | null = null;
  if (parts.length === 4) [lead, proc, year, serial] = parts;
  else if (parts.length === 3) [proc, serial, year] = parts;
  else return null;
  if (!/^\d{4}$/.test(year) || !proc || !serial) return null;
  const named = String(group ?? '').trim();
  const g = named || (lead ? GROUP_BY_LEAD[lead] ?? '' : '');
  if (!g) return null;
  return `${proc}|${year}|${serial}|${g}`;
}

/** True for ids that came from the DLD website export, which carries the register's own date. */
export const isWebId = (id: string) => String(id ?? '').startsWith('w#');
