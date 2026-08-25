const { dueInfo } = require('./due-date-first');

function toTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/** Find hard-priority inversions in a proposed schedule. */
function findPriorityViolations(rows) {
  const items = rows.map(r => ({
    orderId: r.orderId ?? r.order_id,
    orderNumber: r.orderNumber ?? r.order_number,
    startTime: toTime(r.startTime ?? r.start_time),
    due: dueInfo(r),
  }));
  const violations = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      const a = items[i], b = items[j];
      if (a.startTime == null || b.startTime == null || a.startTime <= b.startTime) continue;
      const levelInversion = a.due.level < b.due.level;
      const dateInversion = a.due.level === b.due.level && a.due.date && b.due.date && a.due.date > b.due.date;
      if (levelInversion || dateInversion) {
        violations.push({
          earlierScheduled: b.orderId,
          laterScheduled: a.orderId,
          earlierOrderNumber: b.orderNumber,
          laterOrderNumber: a.orderNumber,
          reason: levelInversion ? '交期层级倒置' : '同层级日期倒置',
        });
      }
    }
  }
  return violations;
}

function scheduleHealth(rows) {
  const violations = findPriorityViolations(rows);
  const dated = rows.filter(r => dueInfo(r).level < 2).length;
  return {
    ok: violations.length === 0,
    violationCount: violations.length,
    datedCount: dated,
    undatedCount: rows.length - dated,
    violations,
  };
}

module.exports = { findPriorityViolations, scheduleHealth };
