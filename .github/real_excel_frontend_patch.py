from pathlib import Path
import re
p=Path('public/index.html')
s=p.read_text(encoding='utf-8')
old=re.compile(r"const isStandardProductionWorkbook =\n\s*wb\.SheetNames\.some\(n => /在制工单明细\|生产工单明细/i\.test\(n\)\) &&\n\s*wb\.SheetNames\.some\(n => /刀模基表/i\.test\(n\)\);", re.M)
new="""const hasWorkOrderSheet = wb.SheetNames.some(n => /在制工单明细|生产工单明细/i.test(n));\n        const hasProductionSupportSheet = wb.SheetNames.some(n => /销货明细|库存明细|待检产品|每日急件满足进度|急件满足进度|模数跳距/i.test(n));\n        const isStandardProductionWorkbook = hasWorkOrderSheet && hasProductionSupportSheet;"""
s, n = old.subn(new, s, count=1)
if n != 1: raise SystemExit('standard workbook detection anchor not found')
old2="""          if ((resp.stages||{}).waiting_schedule>0) {\n            showToast('检测到车间待排工单，正在按出货需求日期/交货日期 + 预计开工时间自动排程','info');\n            setTimeout(()=>runAutoSchedule(),300);\n          }\n          return;"""
if old2 not in s: raise SystemExit('auto-run-after-import block not found')
s=s.replace(old2,"""          return;""",1)
p.write_text(s,encoding='utf-8')
print('real workbook frontend detection fixed')
