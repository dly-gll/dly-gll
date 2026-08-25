const assert = require('assert');
const { dueInfo, compare } = require('./due-date-first');
const { scheduleHealth } = require('./schedule-validator');
const { riskFromTimes } = require('./schedule-risk');

assert.strictEqual(dueInfo({shipping_required_date:'2026-08-25',delivery_date:'2026-08-24'}).level, 0);
assert.strictEqual(dueInfo({delivery_date:'2026-08-24'}).level, 1);
assert.strictEqual(dueInfo({}).level, 2);
assert(compare({shipping_required_date:'2026-08-25'},{delivery_date:'2026-08-20'}) < 0);
assert(compare({delivery_date:'2026-08-20'},{}) < 0);
assert.strictEqual(scheduleHealth([
  {order_id:1,order_number:'A',shipping_required_date:'2026-08-27',start_time:'2026-08-25T10:00:00Z'},
  {order_id:2,order_number:'B',delivery_date:'2026-08-26',start_time:'2026-08-25T09:00:00Z'}
]).ok, false);
assert.strictEqual(riskFromTimes('2026-08-25T16:00:00Z','2026-08-25T23:00:00Z',null).level, 'tight');
assert.strictEqual(riskFromTimes('2026-08-26T10:00:00Z','2026-08-26T08:00:00Z',null).level, 'late');
console.log('V5.1 scheduler tests passed');
