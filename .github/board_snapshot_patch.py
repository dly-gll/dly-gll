from pathlib import Path
p=Path('server.js')
s=p.read_text(encoding='utf-8')
old="""      SELECT o.id order_id,o.order_number,o.product_code,o.product_name,
             COALESCE(snap.quantity,o.quantity) quantity,o.status order_status,
             snap.shipping_required_date,snap.delivery_date,
             o.priority,o.mold,o.process,o.capacity,o.mold_change_time,
             snap.stage workflow_stage,snap.status_text workflow_status_text,snap.expected_date workflow_expected_date,
             snap.production_progress workflow_production_progress,snap.material_status workflow_material_status,snap.shortage_detail workflow_shortage_detail,
             s.start_time scheduled_start,s.end_time scheduled_end,s.status schedule_status
      FROM workflow_snapshots snap
      JOIN orders o ON o.order_number=snap.work_order_number
"""
new="""      SELECT o.id order_id,
             COALESCE(o.order_number,snap.work_order_number) order_number,
             COALESCE(o.product_code,snap.product_code) product_code,
             COALESCE(o.product_name,snap.product_name) product_name,
             COALESCE(snap.quantity,o.quantity) quantity,
             COALESCE(o.status,'pending') order_status,
             snap.shipping_required_date,snap.delivery_date,
             o.priority,o.mold,o.process,o.capacity,o.mold_change_time,
             snap.stage workflow_stage,snap.status_text workflow_status_text,snap.expected_date workflow_expected_date,
             snap.production_progress workflow_production_progress,snap.material_status workflow_material_status,snap.shortage_detail workflow_shortage_detail,
             s.start_time scheduled_start,s.end_time scheduled_end,s.status schedule_status
      FROM workflow_snapshots snap
      LEFT JOIN orders o ON o.order_number=snap.work_order_number
"""
if old not in s:
    raise SystemExit('workflow board SQL anchor not found')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')
print('workflow board now reads imported snapshots with LEFT JOIN orders')
