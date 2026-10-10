import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyByRules, textHints } from '../src/extract/rules.js';
import type { PageObservation } from '../src/sources/types.js';

// Fixtures are the real observations we captured from each retailer.
const obs = (signals: PageObservation['signals'], pageText?: string): PageObservation =>
  ({ url: 'https://x', title: 't', price: null, category: null, signals, pageText });

test('Robu: schema.org OutOfStock with no contradicting text -> out_of_stock', () => {
  assert.equal(classifyByRules(obs({ schemaAvailability: 'OutOfStock' }, ''))?.status, 'out_of_stock');
});

test('Zbotic: is_in_stock=true but "Available on backorder" -> pre_order', () => {
  const r = classifyByRules(obs({ platformInStock: true, availabilityText: 'Available on backorder | button: Add to cart' }));
  assert.equal(r?.status, 'pre_order');
});

test('ThinkRobotics: available with one sold-out variant -> in_stock', () => {
  const r = classifyByRules(obs({ platformInStock: true, availabilityText: '2GB: available, 4GB: sold out, 8GB: available' }));
  assert.equal(r?.status, 'in_stock');
});

test('Shopify pre-order tag -> pre_order', () => {
  assert.equal(classifyByRules(obs({ platformInStock: true, availabilityText: 'tag: pre-order' }))?.status, 'pre_order');
});

test('Evelta: schema OutOfStock but page says "30 in stock" -> null (send to LLM)', () => {
  const r = classifyByRules(obs({ schemaAvailability: 'OutOfStock' }, 'Ships in 24 hours | 30 in stock | 3 in stock'));
  assert.equal(r, null);
});

test('Only text, conflicting hints -> null', () => {
  assert.equal(classifyByRules(obs({}, 'Sold out | Add to cart')), null);
});

test('Only text, single clear hint -> decided', () => {
  assert.equal(classifyByRules(obs({}, 'Pre-order now, ships in 3 weeks'))?.status, 'pre_order');
});

test('No signals at all -> null', () => {
  assert.equal(classifyByRules(obs({})), null);
});

test('"out of stock" is not mistaken for "in stock"', () => {
  assert.deepEqual([...textHints('Out of stock')], ['out_of_stock']);
});

test('"not in stock" is an out-of-stock hint, not an in-stock one', () => {
  assert.deepEqual([...textHints('This item is not in stock')], ['out_of_stock']);
});
