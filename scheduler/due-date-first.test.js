const assert = require('assert');
const { dueInfo, compare } = require('./due-date-first');

const shipping = { shipping_required_date: '2026-08-25', delivery_date: '2026-08-28' };
const delivery = { shipping_required_date: '', delivery_date: '2026-08-24' };
const undated = { shipping_required_date: '', delivery_date: '', delivery_time: '' };
const laterShipping = { shipping_required_date: '2026-08-27', delivery_date: '2026-08-27' };

assert.strictEqual(dueInfo(shipping).level, 0);
assert.strictEqual(dueInfo(delivery).level, 1);
assert.strictEqual(dueInfo(undated).level, 2);
assert(compare(shipping, delivery) < 0, '出货需求日期必须优先于交货日期');
assert(compare(delivery, undated) < 0, '交货日期必须优先于无日期');
assert(compare(shipping, laterShipping) < 0, '同为出货需求日期时，日期更早者优先');

console.log('V5.1 due-date-first tests passed');
