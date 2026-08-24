/**
 * V5.1 Due-Date-First scheduling policy.
 * Keep this module independent from HTTP/database code.
 *
 * Rule order:
 * 1. Dated orders always precede undated orders.
 * 2. Among dated orders, earlier due date always wins.
 * 3. Only then compare tardiness/slack/setup/load/priority.
 * 4. Running/completed work must be excluded by the caller.
 */
function parseDueDate(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw || /^#(N\/A|VALUE!|REF!|NAME\?|DIV\/0!)/i.test(raw)) return null;
  let m = raw.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (m) return validDate(new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999));
  m = raw.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/);
  if (m) return validDate(new Date(+m[3], +m[1] - 1, +m[2], 23, 59, 59, 999));
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : validDate(new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999));
}
function validDate(d){ return Number.isNaN(d.getTime()) ? null : d; }

function compareDueFirst(a,b){
  const ad = a.dueDate instanceof Date && !Number.isNaN(a.dueDate.getTime());
  const bd = b.dueDate instanceof Date && !Number.isNaN(b.dueDate.getTime());
  if (ad !== bd) return ad ? -1 : 1;
  if (ad) {
    const diff=a.dueDate.getTime()-b.dueDate.getTime();
    if(diff) return diff;
  }
  const as=Number.isFinite(a.score)?a.score:Number.POSITIVE_INFINITY;
  const bs=Number.isFinite(b.score)?b.score:Number.POSITIVE_INFINITY;
  if(as!==bs) return as-bs;
  const ae=a.endTime instanceof Date?a.endTime.getTime():Number.POSITIVE_INFINITY;
  const be=b.endTime instanceof Date?b.endTime.getTime():Number.POSITIVE_INFINITY;
  return ae-be;
}

module.exports={parseDueDate,compareDueFirst};
