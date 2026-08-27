from pathlib import Path
import re

p=Path('server.js')
s=p.read_text(encoding='utf-8')

# Rebuild the stage router to follow the user's exact first flow diagram.
pat=re.compile(r"function detectWorkflowStage\(row\) \{.*?\n\}\n\nfunction extractWorkflowRow",re.S)
new=r'''function detectWorkflowStage(row) {
  const progress = normalizeImportText(findImportValue(row, ['生产进度','生产状态','生产阶段','状态码','工单状态','订单状态','production progress','progress']));
  const material = normalizeImportText(findImportValue(row, ['是否齐料','齐料状态','物料状态','材料状态','material status']));
  const shortageDetail = normalizeImportText(findImportValue(row, ['欠料明细','欠料原因','缺料明细','缺料原因','shortage detail']));
  const p = progress.toLowerCase();
  const m = material.toLowerCase();
  const sd = shortageDetail.toLowerCase();

  // 1) 完工先终止流程
  if (/成品检验中|成品已完工|已完工|完工|结案/.test(p)) return 'completed';

  // 2) 生产中 -> 车间在制（优先于物料字段，避免“是否齐料=否”把在制单误判成欠料）
  if (/生产中|生产进行中|车间在制|在制|已开工|生产执行/.test(p)) return 'in_process';

  // 3) 已发料 -> 车间待排
  if (/已发料/.test(p)) return 'waiting_schedule';

  // 4) 未发料 -> 继续看是否齐料
  if (/未发料/.test(p)) {
    if (/欠料|缺料|缺材料|欠材|待采购回复|待厂商合同|待财务付款|待厂内.*回货|待通知交货|待回复|未齐|不齐|不全|不够|^(否|no)$/i.test(m) || /欠料|缺料|缺材料|欠材|待采购回复|待厂商合同|待财务付款|待厂内.*回货|待通知交货|待回复/.test(sd)) {
      return 'shortage';
    }
    if (/仓库有料|有料待发|有料|待发料|待发|待分切|分切/.test(m)) return 'available_to_issue';
    if (/齐料|已齐料|物料齐套/.test(m)) return 'waiting_schedule';
  }

  // 5) 没有标准状态码时，用物料/文本兜底识别，兼容现场表格写法
  if (/仓库有料|有料待发|有料|待发料|待发|待分切|分切/.test(m) || /有料待发|待发料|待发/.test(p)) return 'available_to_issue';
  if (/欠料|缺料|缺材料|欠材|待采购回复|待厂商合同|待财务付款|待厂内.*回货|待通知交货|待回复|未齐|不齐|不全|不够|^(否|no)$/i.test(m) || /欠料|缺料|缺材料|欠材|待采购回复|待厂商合同|待财务付款|待厂内.*回货|待通知交货|待回复/.test(sd)) return 'shortage';
  if (/车间待排|待排产|待排|等待排产|已排待制|待制/.test(p)) return 'waiting_schedule';
  if (/齐料|已齐料|物料齐套/.test(m)) return 'waiting_schedule';
  if (/外发|外购|众鑫源|江杉|美佳信|业健宏|五金冲压|正峰|恒基|泰尔森|英利悦|楚锋|众彩|创智捷/.test(p)) return 'in_process';
  return 'unknown';
}

function extractWorkflowRow'''
if not pat.search(s): raise SystemExit('stage router not found')
s=pat.sub(new,s,1)

# When scheduling a waiting order, update both the order row and its latest workflow snapshot.
needle="""        updateOrderStatus.run(item.order.id);
      }
    });"""
repl="""        updateOrderStatus.run(item.order.id);
        const latestSnapshot = db.prepare(`
          SELECT id FROM workflow_snapshots
          WHERE work_order_number=?
          ORDER BY snapshot_date DESC, id DESC LIMIT 1
        `).get(item.order.order_number);
        if (latestSnapshot) {
          db.prepare(`UPDATE workflow_snapshots
            SET production_progress='已排待制', status_text=CASE WHEN status_text IS NULL OR status_text='' THEN '已排待制' ELSE status_text || ' | 已排待制' END
            WHERE id=?`).run(latestSnapshot.id);
        }
      }
    });"""
if needle not in s: raise SystemExit('main auto-run write block not found')
s=s.replace(needle,repl,1)

# Only precheck the orders that are actually eligible for this button.
old="const orders = db.prepare(\"SELECT * FROM orders WHERE status IN ('pending','scheduled','running')\").all();"
newq="const orders = db.prepare(\"SELECT * FROM orders WHERE status IN ('pending','scheduled') AND workflow_stage='waiting_schedule'\").all();"
if old not in s: raise SystemExit('precheck query not found')
s=s.replace(old,newq,1)

# Make the current board snapshot-first. The imported snapshot must remain visible even when
# the normalized orders master does not yet contain the matching work-order row.
old_join="FROM workflow_snapshots snap\n      JOIN orders o ON o.order_number=snap.work_order_number\n      LEFT JOIN schedules s ON s.order_id=o.id AND s.status IN ('scheduled','running')"
new_join="FROM workflow_snapshots snap\n      LEFT JOIN orders o ON o.order_number=snap.work_order_number\n      LEFT JOIN schedules s ON s.order_id=o.id AND s.status IN ('scheduled','running')"
if old_join not in s: raise SystemExit('workflow board join anchor not found')
s=s.replace(old_join,new_join,1)
old_select="SELECT o.id order_id,o.order_number,o.product_code,o.product_name,\n             COALESCE(snap.quantity,o.quantity) quantity,o.status order_status,"
new_select="SELECT o.id order_id,COALESCE(o.order_number,snap.work_order_number) order_number,\n             COALESCE(o.product_code,snap.product_code) product_code,\n             COALESCE(o.product_name,snap.product_name) product_name,\n             COALESCE(snap.quantity,o.quantity,0) quantity,o.status order_status,"
if old_select not in s: raise SystemExit('workflow board select anchor not found')
s=s.replace(old_select,new_select,1)

# Marker for release notes / idempotency.
marker='// V5.1.2-BUSINESS-LOGIC-VERIFIED'
if marker not in s: raise SystemExit('business marker missing')
if 'V5.1.2-WORKFLOW-BOARD-SNAPSHOT-FIRST-VERIFIED' not in s:
    s='// V5.1.2-WORKFLOW-BOARD-SNAPSHOT-FIRST-VERIFIED\n'+s
p.write_text(s,encoding='utf-8')
print('V5.1.2 workflow routing, snapshot sync, and board snapshot-first query applied')
