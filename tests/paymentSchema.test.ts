import test from 'node:test';
import assert from 'node:assert/strict';
import { validatePaymentPayload } from '../src/validators/paymentSchema';

const samplePayload = {
  customer_id: 'GIGXXXXX',
  payment_status: 'COMPLETE',
  transaction_amount: '10000',
  transaction_date: '2025-11-07 14:54:16',
  transaction_reference: 'VPAY25110713542114478761522000',
};

test('accepts the sample payload from the brief', () => {
  const result = validatePaymentPayload(samplePayload);
  assert.equal(result.success, true);
  if (result.success) {
    assert.equal(result.data.transaction_amount, 10000); // coerced string -> number
  }
});

test('rejects a non-positive transaction_amount', () => {
  const result = validatePaymentPayload({ ...samplePayload, transaction_amount: '0' });
  assert.equal(result.success, false);
});

test('rejects an unparsable transaction_date', () => {
  const result = validatePaymentPayload({ ...samplePayload, transaction_date: 'not-a-date' });
  assert.equal(result.success, false);
});

test('rejects a missing transaction_reference', () => {
  const { transaction_reference: _omitted, ...withoutRef } = samplePayload;
  const result = validatePaymentPayload(withoutRef);
  assert.equal(result.success, false);
});
