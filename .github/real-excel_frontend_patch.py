from pathlib import Path
import re

# Frontend: recognize the actual PMC workbook shape used on site and never auto-run scheduling after import.
p=Path('public/index.html')
s=p.read_text(encoding='utf-8')
old=re.compile(r"const isStandardProductionWorkbook =\n\s*wb\.SheetNames\.some\(n => /在制工单明细\|生产工单明细/i\.test\(n\)\) &&\n\s*wb\.SheetNames\.some\(n => /刀模基表/i\.test\(n\)\);", re.M)
new="""const hasWorkOrderSheet = wb.SheetNames.some(n => /在制工单明细|生产工单明细/i.test(n));
        const hasProductionSupportSheet = wb.SheetNames.some(n => /销货明细|库存明细|待检产品|每日急件满足进度|急件满足进度|模数跳距/i.test(n));
        const isStandardProductionWorkbook = hasWorkOrderSheet && hasProductionSupportSheet;"""
s, n = old.subn(new, s, count=1)
if n != 1: raise SystemExit('standard workbook detection anchor not found')
old2="""          if ((resp.stages||{}).waiting_schedule>0) {
            showToast('检测到车间待排工单，正在按出货需求日期/交货日期 + 预计开工时间自动排程','info');
            setTimeout(()=>runAutoSchedule(),300);
          }
          return;"""
if old2 not in s: raise SystemExit('auto-run-after-import block not found')
s=s.replace(old2,"""          return;""",1)
p.write_text(s,encoding='utf-8')

# Backend: the imported workflow snapshot is the source of truth for the board.
# Use LEFT JOIN so a display row is not silently dropped merely because the companion order row is missing.
q=Path('server.js')
t=q.read_text(encoding='utf-8')
oldq="""      SELECT o.id order_id,o.order_number,o.product_code,o.product_name,
             COALESCE(snap.quantity,o.quantity) quantity,o.status order_status,
             snap.shipping_required_date,snap.delivery_date,
             o.priority,o.mold,o.process,o.capacity,o.mold_change_time,
             snap.stage workflow_stage,snap.status_text workflow_status_text,snap.expected_date workflow_expected_date,
             snap.production_progress workflow_production_progress,snap.material_status workflow_material_status,snap.shortage_detail workflow_shortage_detail,
             s.start_time scheduled_start,s.end_time scheduled_end,s.status schedule_status
      FROM workflow_snapshots snap
      JOIN orders o ON o.order_number=snap.work_order_number
"""
newq="""      SELECT o.id order_id,
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
if oldq not in t: raise SystemExit('workflow board SQL anchor not found')
t=t.replace(oldq,newq,1)
q.write_text(t,encoding='utf-8')
print('real workbook detection + workflow board join patch applied')