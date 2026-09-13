// Unit tests for the one engine. Small, exact, and each one pins down a rule someone got wrong once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectRow, edate, monthsBetween, releasedShare, collectedShare, SCENARIOS } from '../src/engine/escrow.mjs';

const base = SCENARIOS[0];
const asOf = new Date('2026-09-10T00:00:00Z');

test('EDATE clamps to the month end the way Excel does', () => {
  assert.equal(edate(new Date('2026-01-31T00:00:00Z'), 1).toISOString().slice(0, 10), '2026-02-28');
  assert.equal(edate(new Date('2026-03-31T00:00:00Z'), -1).toISOString().slice(0, 10), '2026-02-28');
});

test('months are counted on year and month only, never on days', () => {
  assert.equal(monthsBetween(asOf, new Date('2027-02-28T00:00:00Z')), 5);   // Feb-27 horizon
  assert.equal(monthsBetween(asOf, new Date('2026-09-30T00:00:00Z')), 0);
});

test('nothing is released until something is certified, and everything at 100', () => {
  assert.equal(releasedShare(0, base), 0);
  assert.equal(releasedShare(100, base), 1);
  assert.equal(collectedShare(100, base), 1);
  assert.equal(collectedShare(0, base), base.book);
});

test('release is drawn down in step with certified progress, not paid up front', () => {
  // at 50% certified: collected = 0.10 + 0.60*0.5 = 0.40; released = 0.40 * 0.5 = 0.20
  assert.ok(Math.abs(releasedShare(50, base) - 0.20) < 1e-12);
  assert.ok(Math.abs(collectedShare(50, base) - 0.40) < 1e-12);
});

test('cancellation applies to the contracted book only; future sales of unsold stock are not cancelled', () => {
  const s = { ...base, cancel: 0.10, sell: 0.5, price: 0 };
  const r = projectRow({ units: 100, sold: 60, ticket: 1e6, cert: 50, completion: null, asOf, s });
  // contracted 60m * 0.9 = 54m ; unsold 40 * 1m * 0.5 = 20m
  assert.ok(Math.abs(r.effective - 74) < 1e-9);
});

test('released-to-date is on the contracted book, net of retention', () => {
  const r = projectRow({ units: 100, sold: 100, ticket: 1e6, cert: 50, completion: null, asOf, s: base });
  assert.ok(Math.abs(r.releasedToDate - 100 * 0.20 * 0.95) < 1e-9);
});

test('a project past its filed date gets the past-due allowance, not the delay', () => {
  const s = { ...base, delay: 6, pastdue: 6 };
  const late = projectRow({ units: 10, sold: 10, ticket: 1e6, cert: 30, completion: new Date('2026-01-01T00:00:00Z'), asOf, s });
  const onTime = projectRow({ units: 10, sold: 10, ticket: 1e6, cert: 30, completion: new Date('2027-01-01T00:00:00Z'), asOf, s });
  assert.equal(late.months, 6);          // asOf + pastdue
  assert.equal(onTime.months, 10);       // Jan-27 + 6 months delay = Jul-27 → 10 months from Sep-26
});

test('months to go never falls below one, so pace never divides by zero', () => {
  const r = projectRow({ units: 10, sold: 10, ticket: 1e6, cert: 90, completion: new Date('2026-09-15T00:00:00Z'), asOf, s: base });
  assert.equal(r.months, 1);
  assert.ok(isFinite(r.pace));
});

test('pace is capped', () => {
  const r = projectRow({ units: 10, sold: 10, ticket: 1e6, cert: 0, completion: new Date('2026-10-01T00:00:00Z'), asOf, s: base });
  assert.equal(r.pace, base.cap);
});

test('future release never goes negative and never exceeds effective value net of retention', () => {
  const r = projectRow({ units: 100, sold: 80, ticket: 1e6, cert: 20, completion: null, asOf, s: base,
    horizons: [{ key: 'a', months: 1 }, { key: 'z', months: 240 }] });
  assert.ok(r.byHorizon.a >= 0);
  assert.ok(r.byHorizon.z <= r.effective * (1 - base.ret) - r.releasedToDate + 1e-9);
});
