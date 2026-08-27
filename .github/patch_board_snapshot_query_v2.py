from pathlib import Path
import re

p = Path('server.js')
s = p.read_text(encoding='utf-8')
old = "FROM workflow_snapshots snap\n      JOIN orders o ON o.order_number=snap.work_order_number\n      LEFT JOIN schedules s ON s.order_id=o.id AND s.status IN ('scheduled','running')"
new = "FROM workflow_snapshots snap\n      LEFT JOIN orders o ON o.order_number=snap.work_order_number\n      LEFT JOIN schedules s ON s.order_id=o.id AND s.status IN ('scheduled','running')"
if old not in s:
    raise SystemExit('workflow board join anchor not found')
s = s.replace(old, new, 1)
old_select = "SELECT o.id order_id,o.order_number,o.product_code,o.product_name,\n             COALESCE(snap.quantity,o.quantity) quantity,o.status order_status,"
new_select = "SELECT o.id order_id,COALESCE(o.order_number,snap.work_order_number) order_number,\n             COALESCE(o.product_code,snap.product_code) product_code,\n             COALESCE(o.product_name,snap.product_name) product_name,\n             COALESCE(snap.quantity,o.quantity,0) quantity,o.status order_status,"
if old_select not in s:
    raise SystemExit('workflow board select anchor not found')
s = s.replace(old_select, new_select, 1)
p.write_text(s, encoding='utf-8')
print('workflow board now renders from latest snapshots even when order master join is absent')
