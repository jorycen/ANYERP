import test from 'node:test'
import assert from 'node:assert/strict'
import { mergePurchaseProductOptions } from '../src/utils/purchaseProducts.js'

test('searching the second product keeps the first selected product company price', () => {
  const first = { product_id: 'white', name: 'R360 White', standard_price: 120 }
  const second = { product_id: 'black', name: 'R360 Black', standard_price: 120 }
  const result = mergePurchaseProductOptions([first], [second], ['white'])
  assert.equal(result.find(p => p.product_id === 'white').standard_price, 120)
  assert.equal(result.find(p => p.product_id === 'black').standard_price, 120)
})

test('fresh records replace cached prices without duplicates, including an invalidated price', () => {
  const result = mergePurchaseProductOptions([{ product_id: 1, standard_price: 100 }],
    [{ product_id: '1', standard_price: 0 }], ['1'])
  assert.equal(result.length, 1)
  assert.equal(result[0].standard_price, 0)
})

test('unselected old search results are removed while every selected product survives', () => {
  const result = mergePurchaseProductOptions([{ product_id: 'a' }, { product_id: 'b' }, { product_id: 'unused' }],
    [{ product_id: 'c' }], ['a', 'b'])
  assert.deepEqual(result.map(p => p.product_id), ['a', 'b', 'c'])
})
