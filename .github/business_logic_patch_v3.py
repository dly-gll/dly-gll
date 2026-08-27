from pathlib import Path
import re

p=Path('server.js')
s=p.read_text(encoding='utf-8')
old='''function getWorkflowOrderRow(orderNumber, productCode) {
  if (orderNumber) {
    const row = db.prepare('SELECT * FROM orders WHERE order_number=? ORDER BY id DESC LIMIT 1').get(orderNumber);
    if (row) return row;
  }
  if (productCode) {
    return db.prepare("SELECT * FROM orders WHERE product_code=? AND status IN ('pending','scheduled','running') ORDER BY CASE WHEN workflow_stage='waiting_schedule' THEN 0 WHEN workflow_stage='in_process' THEN 1 ELSE 2 END, id ASC LIMIT 1").get(productCode);
  }
  return null;
}'''
new='''function getWorkflowOrderRow(orderNumber, productCode) {
  // 有明确工单号时，只允许按工单号匹配；绝不能按品号兜底，否则同品号多工单会互相覆盖。
  if (orderNumber) {
    return db.prepare('SELECT * FROM orders WHERE order_number=? ORDER BY id DESC LIMIT 1').get(orderNumber) || null;
  }
  // 只有 Excel 没有工单号时，才允许按品号寻找可复用的未完工订单。
  if (productCode) {
    return db.prepare("SELECT * FROM orders WHERE product_code=? AND status IN ('pending','scheduled','running') ORDER BY CASE WHEN workflow_stage='waiting_schedule' THEN 0 WHEN workflow_stage='in_process' THEN 1 ELSE 2 END, id ASC LIMIT 1").get(productCode) || null;
  }
  return null;
}'''
if old not in s:
    raise SystemExit('target getWorkflowOrderRow block not found')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
assert new in s
print('same-product multi-work-order matching fix applied')
