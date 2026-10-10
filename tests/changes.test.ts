import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChange, type ChangeInput } from '../src/monitor/changes.js';

const base: ChangeInput = { previous: 'out_of_stock', current: 'out_of_stock', previousPrice: 1000, price: 1000, isNew: false, isBaseline: false };
const run = (o: Partial<ChangeInput>) => classifyChange({ ...base, ...o });

test('out_of_stock -> in_stock = back_in_stock', () => assert.deepEqual(run({ current: 'in_stock' }), ['back_in_stock']));
test('out_of_stock -> pre_order = preorder_opened', () => assert.deepEqual(run({ current: 'pre_order' }), ['preorder_opened']));
test('pre_order -> in_stock = back_in_stock', () => assert.deepEqual(run({ previous: 'pre_order', current: 'in_stock' }), ['back_in_stock']));
test('in_stock -> out_of_stock = recorded, not alerted', () =>
  assert.deepEqual(run({ previous: 'in_stock', current: 'out_of_stock' }), ['went_out_of_stock']));
test('no change = nothing', () => assert.deepEqual(run({}), []));

test('unknown result (fetch failed) = nothing', () => assert.deepEqual(run({ previous: 'in_stock', current: 'unknown' }), []));
test('first real status after failures = baseline, nothing', () => assert.deepEqual(run({ previous: 'unknown', current: 'in_stock' }), []));

test('new product on baseline run = nothing (no day-1 alert storm)', () =>
  assert.deepEqual(run({ isNew: true, isBaseline: true, previous: 'unknown', current: 'in_stock' }), []));
test('new in-stock product on later run = new_listing', () =>
  assert.deepEqual(run({ isNew: true, previous: 'unknown', current: 'in_stock' }), ['new_listing']));
test('new out-of-stock product = silently tracked', () =>
  assert.deepEqual(run({ isNew: true, previous: 'unknown', current: 'out_of_stock' }), []));

test('price drop >= 5% while buyable = price_drop', () =>
  assert.deepEqual(run({ previous: 'in_stock', current: 'in_stock', price: 900 }), ['price_drop']));
test('price drop < 5% = noise', () => assert.deepEqual(run({ previous: 'in_stock', current: 'in_stock', price: 970 }), []));
test('restock with a lower price = both events', () =>
  assert.deepEqual(run({ current: 'in_stock', price: 800 }), ['back_in_stock', 'price_drop']));
