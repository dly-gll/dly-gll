from pathlib import Path
import re

p = Path('server.js')
s = p.read_text(encoding='utf-8')

pattern = re.compile(r"function getWorkflowOrderRow\(orderNumber, productCode\) \{.*?\n\}\n\nfunction updateWorkflowTransition", re.S)
match = pattern.search(s)
if not match:
    raise SystemExit('getWorkflowOrderRow function boundary not found')

new_func = '''function getWorkflowOrderRow(orderNumber, productCode) {
  // 有明确工单号时，只允许按工单号匹配；绝不能按品号兜底，否则同品号多工单会互相覆盖。
  if (orderNumber) {
    return db.prepare('SELECT * FROM orders WHERE order_number=? ORDER BY id DESC LIMIT 1').get(orderNumber) || null;
  }
  // 只有 Excel 没有工单号时，才允许按品号寻找可复用的未完工订单。
  if (productCode) {
    return db.prepare("SELECT * FROM orders WHERE product_code=? AND status IN ('pending','scheduled','running') ORDER BY CASE WHEN workflow_stage='waiting_schedule' THEN 0 WHEN workflow_stage='in_process' THEN 1 ELSE 2 END, id ASC LIMIT 1").get(productCode) || null;
  }
  return null;
}

function updateWorkflowTransition'''

s = s[:match.start()] + new_func + s[match.end():]
p.write_text(s, encoding='utf-8')
assert '有明确工单号时，只允许按工单号匹配' in s
print('same-product multi-work-order matching fix applied')
