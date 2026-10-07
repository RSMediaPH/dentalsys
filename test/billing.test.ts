import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, fixture, type Fixture } from './helpers.js';
import { addLine, createDraftInvoice, getInvoice, issueInvoice, patientAccount, recordPayment, reversePayment, setInvoiceDiscount, voidInvoice } from '../src/domain/billing.js';
import { dailyCollections } from '../src/domain/reports.js';
import { AppError, clock, formatMoney, newId, parseMoney } from '../src/lib/core.js';
import { recordEvent } from '../src/domain/outbox.js';
import { tx } from '../src/db/db.js';

const code = (fn: () => unknown) => {
  try { fn(); return 'ok'; } catch (e) { if (e instanceof AppError) return e.code; throw e; }
};

describe('money helpers', () => {
  it('parses and formats without floating point errors', () => {
    assert.equal(parseMoney('1,234.50', 'PHP'), 123450);
    assert.equal(parseMoney('0.1', 'PHP'), 10);
    assert.equal(parseMoney('19.999', 'PHP'), null);
    assert.equal(parseMoney('-5', 'PHP'), null);
    assert.equal(parseMoney('abc', 'PHP'), null);
    assert.equal(parseMoney('1500', 'JPY'), 1500);
    assert.equal(formatMoney(123450, 'PHP'), '₱1,234.50');
  });
});

describe('invoices and payments', () => {
  let f: Fixture;
  before(async () => { f = await fixture(); });
  after(() => { clock.now = () => new Date(); cleanup(f); });

  function issued(total = '2500.00') {
    const r = f.ctx('receptionA');
    const id = createDraftInvoice(r, { patient_id: f.patientA.id });
    addLine(r, id, { description: 'Test procedure', quantity: '1', unit_price: total });
    issueInvoice(r, id);
    return id;
  }

  it('partial payments, overpayment rejection and reversals produce correct balances', () => {
    const r = f.ctx('receptionA');
    const id = issued('2500.00');
    const p1 = recordPayment(r, id, { payment_id: newId(), amount: '1000', method: 'cash' });
    assert.equal(getInvoice(r, id).balance_minor, 150000);
    assert.equal(code(() => recordPayment(r, id, { payment_id: newId(), amount: '1500.01', method: 'cash' })), 'VALIDATION');
    recordPayment(r, id, { payment_id: newId(), amount: '500', method: 'bank_transfer', reference: 'BT-1' });
    assert.equal(getInvoice(r, id).balance_minor, 100000);
    reversePayment(f.ctx('managerA'), p1.paymentId, 'Recorded on wrong invoice');
    const inv = getInvoice(r, id);
    assert.equal(inv.paid_minor, 50000);
    assert.equal(inv.balance_minor, 200000);
    assert.equal(code(() => reversePayment(f.ctx('managerA'), p1.paymentId, 'again please')), 'ALREADY_REVERSED');
    // After reversal, balance can be collected again
    recordPayment(r, id, { payment_id: newId(), amount: '2000', method: 'cash' });
    assert.equal(getInvoice(r, id).balance_minor, 0);
    assert.equal(code(() => recordPayment(r, id, { payment_id: newId(), amount: '0.01', method: 'cash' })), 'VALIDATION');
  });

  it('non-cash payments need a reference', () => {
    const id = issued('100');
    assert.equal(code(() => recordPayment(f.ctx('receptionA'), id, { payment_id: newId(), amount: '50', method: 'card_manual' })), 'VALIDATION');
  });

  it('retrying the same payment (same payment ID) never records it twice', () => {
    const r = f.ctx('receptionA');
    const id = issued('1000');
    const pid = newId();
    const a = recordPayment(r, id, { payment_id: pid, amount: '400', method: 'cash' });
    const b = recordPayment(r, id, { payment_id: pid, amount: '400', method: 'cash' });
    const c = recordPayment(f.ctx('reception2A'), id, { payment_id: pid, amount: '400', method: 'cash' });
    assert.equal(a.duplicate, false);
    assert.equal(b.duplicate, true);
    assert.equal(c.paymentNo, a.paymentNo);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM payments WHERE id = ?').pluck().get(pid), 1);
    assert.equal(f.db.prepare(`SELECT COUNT(*) FROM outbox_events WHERE entity_id = ? AND op = 'recorded'`).pluck().get(pid), 1);
    assert.equal(getInvoice(r, id).balance_minor, 60000);
    assert.equal(code(() => recordPayment(r, id, { payment_id: pid, amount: '300', method: 'cash' })), 'PAYMENT_ID_REUSED');
  });

  it('issued invoices, payments and reversals cannot be edited or deleted, even with raw SQL', () => {
    const r = f.ctx('receptionA');
    const id = issued('300');
    const p = recordPayment(r, id, { payment_id: newId(), amount: '100', method: 'cash' });
    assert.throws(() => f.db.prepare('UPDATE invoices SET total_minor = 1, subtotal_minor = 1 WHERE id = ?').run(id), /INVOICE_IMMUTABLE/);
    assert.throws(() => f.db.prepare('DELETE FROM invoices WHERE id = ?').run(id), /INVOICE_IMMUTABLE/);
    assert.throws(() => f.db.prepare('UPDATE invoice_lines SET unit_price_minor = 1 WHERE invoice_id = ?').run(id), /INVOICE_IMMUTABLE/);
    assert.throws(() => f.db.prepare('UPDATE payments SET amount_minor = 1 WHERE id = ?').run(p.paymentId), /APPEND_ONLY/);
    assert.throws(() => f.db.prepare('DELETE FROM payments WHERE id = ?').run(p.paymentId), /APPEND_ONLY/);
    assert.throws(() => f.db.prepare('DELETE FROM audit_events').run(), /APPEND_ONLY/);
    assert.equal(code(() => addLine(r, id, { description: 'extra', quantity: '1', unit_price: '1' })), 'INVOICE_IMMUTABLE');
  });

  it('void requires all payments reversed and a reason; voided invoices leave the balance', () => {
    const r = f.ctx('receptionA');
    const m = f.ctx('managerA');
    const id = issued('700');
    const p = recordPayment(r, id, { payment_id: newId(), amount: '700', method: 'cash' });
    assert.equal(code(() => voidInvoice(m, id, 'patient disputed')), 'VOID_HAS_PAYMENTS');
    assert.equal(code(() => voidInvoice(r, id, 'patient disputed')), 'FORBIDDEN');
    reversePayment(m, p.paymentId, 'refund given in cash');
    const before = patientAccount(r, f.patientA.id).outstanding_minor;
    voidInvoice(m, id, 'patient disputed');
    assert.equal(patientAccount(r, f.patientA.id).outstanding_minor, before - 70000);
    assert.equal(getInvoice(r, id).status, 'void');
  });

  it('discounts are exact and capped', () => {
    const r = f.ctx('receptionA');
    const id = createDraftInvoice(r, { patient_id: f.patientA.id });
    addLine(r, id, { service_id: f.svcA, quantity: '3', discount: '0.50' }); // 3 × 500.00 − 0.50
    setInvoiceDiscount(r, id, '99.50');
    const inv = getInvoice(r, id);
    assert.equal(inv.subtotal_minor, 149950);
    assert.equal(inv.total_minor, 140000);
    assert.equal(code(() => setInvoiceDiscount(r, id, '1500')), 'VALIDATION');
  });

  it('daily collections: received, reversals (on the day recorded) and net are precise', () => {
    const r = f.ctx('receptionA');
    const m = f.ctx('managerA');
    const at = (iso: string) => { clock.now = () => new Date(iso); };
    at('2031-03-02T02:00:00.000Z'); // 10:00 Manila on 2 Mar
    const id = issued('5000');
    const p1 = recordPayment(r, id, { payment_id: newId(), amount: '1000', method: 'cash' });
    recordPayment(r, id, { payment_id: newId(), amount: '2000', method: 'bank_transfer', reference: 'X1' });
    at('2031-03-02T16:30:00.000Z'); // 00:30 Manila on 3 Mar — belongs to the next local day
    recordPayment(r, id, { payment_id: newId(), amount: '500', method: 'cash' });
    reversePayment(m, p1.paymentId, 'duplicate entry');

    const d1 = dailyCollections(r, '2031-03-02');
    assert.equal(d1.received_minor, 300000);
    assert.equal(d1.reversed_minor, 0);
    assert.equal(d1.net_minor, 300000);
    assert.equal(d1.charges_issued_minor, 500000);
    const d2 = dailyCollections(r, '2031-03-03');
    assert.equal(d2.received_minor, 50000);
    assert.equal(d2.reversed_minor, 100000);
    assert.equal(d2.net_minor, -50000);
    assert.deepEqual(d1.byMethod.map((x) => [x.method, x.amount_minor]).sort(), [['bank_transfer', 200000], ['cash', 100000]]);
    clock.now = () => new Date();
  });
});

describe('transactional outbox', () => {
  let f: Fixture;
  before(async () => { f = await fixture(); });
  after(() => cleanup(f));

  it('every business change writes exactly one event, in order', () => {
    const before = f.db.prepare('SELECT COUNT(*) FROM outbox_events').pluck().get() as number;
    const r = f.ctx('receptionA');
    const id = createDraftInvoice(r, { patient_id: f.patientA.id });
    addLine(r, id, { service_id: f.svcA, quantity: '1' });
    issueInvoice(r, id);
    recordPayment(r, id, { payment_id: newId(), amount: '100', method: 'cash' });
    const rows = f.db.prepare('SELECT seq, op, entity_type FROM outbox_events WHERE seq > ? ORDER BY seq').all(before) as { seq: number; op: string; entity_type: string }[];
    assert.deepEqual(rows.map((x) => `${x.entity_type}.${x.op}`), ['invoice.issued', 'payment.recorded']);
    assert.ok(rows[1]!.seq > rows[0]!.seq);
  });

  it('a failure after the event is written rolls back BOTH the change and the event', () => {
    const r = f.ctx('receptionA');
    const count = () => [f.db.prepare('SELECT COUNT(*) FROM outbox_events').pluck().get(), f.db.prepare('SELECT COUNT(*) FROM patients').pluck().get()];
    const before = count();
    assert.throws(() => tx(f.db, () => {
      f.db.prepare(`UPDATE patients SET first_name = 'Changed' WHERE id = ?`).run(f.patientA.id);
      recordEvent(r, { entityType: 'patient', entityId: f.patientA.id, op: 'updated', payload: {} });
      throw new Error('simulated crash before commit');
    }));
    assert.deepEqual(count(), before);
    assert.equal(f.db.prepare('SELECT first_name FROM patients WHERE id = ?').pluck().get(f.patientA.id), 'Test');
  });

  it('recordEvent refuses to run outside a transaction', () => {
    assert.throws(() => recordEvent(f.ctx('receptionA'), { entityType: 'x', entityId: 'y', op: 'z', payload: {} }), /inside the business transaction/);
  });
});
