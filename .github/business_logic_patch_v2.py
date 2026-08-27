from pathlib import Path
import re

SERVER = Path('server.js')
PAGE = Path('public/index.html')
MARK = '// V5.1.2-BUSINESS-LOGIC-VERIFIED'

h = PAGE.read_text(encoding='utf-8')
s = SERVER.read_text(encoding='utf-8')

required_ui = [
    'id="scheduleSubnav"',
    'data-workflow-stage="shortage"',
    'data-workflow-stage="available_to_issue"',
    'data-workflow-stage="waiting_schedule"',
    'data-workflow-stage="in_process"',
    'switchWorkflowStageFromSidebar',
    'updateScheduleSidebar',
]

if 'function workflowTabsHtml' in h:
    h = re.sub(
        r"    function workflowTabsHtml\(\)\{.*?\n    \}",
        '''    function workflowTabsHtml(){
      const tabs=[['gantt','甘特图'],['list','列表视图']];
      return `<div class="workflow-tabs">${tabs.map(([k,t])=>`<div class="workflow-tab ${currentSubTab===k?'active':''}" onclick="switchSubTab('${k}')">${t}</div>`).join('')}</div>`;
    }''',
        h, count=1, flags=re.S)

if "currentSubTab = 'gantt';" not in h:
    old = "          navigateTo('schedule');\n        } else {"
    new = "          currentWorkflowStage = null;\n          currentSubTab = 'gantt';\n          updateScheduleSidebar();\n          navigateTo('schedule');\n        } else {"
    if old not in h:
        raise SystemExit('auto schedule success anchor not found')
    h = h.replace(old, new, 1)

oldp = "<td>${escapeHtml(r.workflow_production_progress||'-')}</td><td>${escapeHtml(r.workflow_material_status||'-')}</td>"
newp = "<td>${escapeHtml(r.order_status==='scheduled' ? '已排待制' : (r.workflow_production_progress||'-'))}</td><td>${escapeHtml(r.workflow_material_status||'-')}</td>"
if oldp in h and "r.order_status==='scheduled'" not in h:
    h = h.replace(oldp, newp, 1)
PAGE.write_text(h, encoding='utf-8')

if MARK not in s:
    detect = re.compile(r"function detectWorkflowStage\(row\) \{.*?\n\}\n\nfunction extractWorkflowRow", re.S)
    detect_new = r'''function detectWorkflowStage(row) {
  const progress = normalizeImportText(findImportValue(row, ['生产进度','生产状态','生产阶段','production progress','progress']));
  const material = normalizeImportText(findImportValue(row, ['是否齐料','齐料状态','物料状态','材料状态','material status']));
  const shortageDetail = normalizeImportText(findImportValue(row, ['欠料明细','欠料原因','缺料明细','缺料原因','shortage detail']));
  const statusCode = normalizeImportText(findImportValue(row, ['状态码','状态','工单状态','订单状态','status']));
  const p = progress.toLowerCase(), m = material.toLowerCase(), sd = shortageDetail.toLowerCase(), sc = statusCode.toLowerCase();
  if (/成品检验中|成品已完工|已完工|完工|结案/.test(p)) return 'completed';
  if (/欠料|缺料|缺材料|欠材|待采购回复|待厂商合同|待财务付款|待厂内.*回货|待通知交货|待回复|未齐|不齐|不全|不够|^(否|no)$/i.test(m) || /欠料|缺料|缺材料|欠材|待采购回复|待厂商合同|待财务付款|待厂内.*回货|待通知交货|待回复/.test(sd)) return 'shortage';
  if (/车间在制|在制|生产中|生产进行中|已开工|生产执行/.test(p)) return 'in_process';
  if (/车间待排|待排产|待排|等待排产|已发料|已排待制|待制/.test(p) || /已发料/.test(sc)) return 'waiting_schedule';
  if (/齐料|已齐料|物料齐套/.test(m) && !/车间在制|在制|生产中|已开工/.test(p)) return 'waiting_schedule';
  if (/仓库有料|有料待发|有料|待发料|待发|待分切|分切/.test(m) || /有料待发|待发料|待发/.test(p)) return 'available_to_issue';
  if (/外发|外购|众鑫源|江杉|美佳信|业健宏|五金冲压|正峰|恒基|泰尔森|英利悦|楚锋|众彩|创智捷/.test(p)) return 'in_process';
  return 'unknown';
}

function extractWorkflowRow'''
    if not detect.search(s): raise SystemExit('detectWorkflowStage not found')
    s = detect.sub(detect_new, s, 1)

    product_block = re.compile(r"  if \(product\) \{.*?  if \(!\(moldChange >= 0\)\) moldChange = 30;", re.S)
    product_new = '''  const excelMaster = excelContext.products?.get(productCode) || null;
  if (product) {
    if (normalizeImportText(product.mold)) mold=normalizeImportText(product.mold); else if (!mold && normalizeImportText(excelMaster?.mold)) mold=normalizeImportText(excelMaster.mold);
    if (normalizeImportText(product.process)) process=normalizeImportText(product.process); else if (!process && normalizeImportText(excelMaster?.process)) process=normalizeImportText(excelMaster.process);
    if (normalizeImportText(product.machines)) machineTokens=normalizeImportText(product.machines); else if (!machineTokens && normalizeImportText(excelMaster?.machines)) machineTokens=normalizeImportText(excelMaster.machines);
    if (Number(product.capacity)>0) capacity=Number(product.capacity); else if (!(capacity>0) && Number(excelMaster?.capacity)>0) capacity=Number(excelMaster.capacity);
    if (Number.isFinite(Number(product.mold_change_time)) && Number(product.mold_change_time)>=0) moldChange=Number(product.mold_change_time); else if (Number.isFinite(Number(excelMaster?.mold_change_time)) && Number(excelMaster?.mold_change_time)>=0) moldChange=Number(excelMaster.mold_change_time);
  } else if (excelMaster) {
    if (!mold && normalizeImportText(excelMaster.mold)) mold=normalizeImportText(excelMaster.mold);
    if (!process && normalizeImportText(excelMaster.process)) process=normalizeImportText(excelMaster.process);
    if (!machineTokens && normalizeImportText(excelMaster.machines)) machineTokens=normalizeImportText(excelMaster.machines);
    if (!(capacity>0) && Number(excelMaster.capacity)>0) capacity=Number(excelMaster.capacity);
    if (!(moldChange>=0) && Number.isFinite(Number(excelMaster.mold_change_time))) moldChange=Number(excelMaster.mold_change_time);
  }
  if (!(capacity > 0)) capacity = 1000;
  if (!(moldChange >= 0)) moldChange = 30;'''
    if not product_block.search(s): raise SystemExit('product matching block not found')
    s = product_block.sub(product_new, s, 1)

    up_old = '''      ON CONFLICT(product_code) DO UPDATE SET
        product_name=CASE WHEN excluded.product_name<>'' THEN excluded.product_name ELSE product_data.product_name END,
        mold=CASE WHEN excluded.mold<>'' THEN excluded.mold ELSE product_data.mold END,
        process=CASE WHEN excluded.process<>'' THEN excluded.process ELSE product_data.process END,
        machines=CASE WHEN excluded.machines<>'' THEN excluded.machines ELSE product_data.machines END,
        mold_count=COALESCE(excluded.mold_count,product_data.mold_count),
        jump_distance=COALESCE(excluded.jump_distance,product_data.jump_distance)'''
    up_new = '''      ON CONFLICT(product_code) DO UPDATE SET
        product_name=CASE WHEN NULLIF(product_data.product_name,'') IS NULL AND excluded.product_name<>'' THEN excluded.product_name ELSE product_data.product_name END,
        mold=CASE WHEN NULLIF(product_data.mold,'') IS NULL AND excluded.mold<>'' THEN excluded.mold ELSE product_data.mold END,
        process=CASE WHEN NULLIF(product_data.process,'') IS NULL AND excluded.process<>'' THEN excluded.process ELSE product_data.process END,
        machines=CASE WHEN NULLIF(product_data.machines,'') IS NULL AND excluded.machines<>'' THEN excluded.machines ELSE product_data.machines END,
        mold_count=COALESCE(product_data.mold_count,excluded.mold_count),
        jump_distance=COALESCE(product_data.jump_distance,excluded.jump_distance)'''
    if up_old not in s: raise SystemExit('product master upsert block not found')
    s = s.replace(up_old, up_new, 1)

    pri = re.compile(r"function getSchedulePriority\(order\) \{.*?\n\}", re.S)
    pri_new = r'''function getSchedulePriority(order) {
  const shipping = parseDueDate(order?.shipping_required_date);
  if (shipping) return { level: 0, label: '一级：要求出货时间', date: shipping, source: 'shipping_required_date' };
  const delivery = parseDueDate(order?.delivery_date);
  if (delivery) return { level: 0, label: '一级：交货日期', date: delivery, source: 'delivery_date' };
  const expectedStart = parseDueDate(order?.workflow_expected_date);
  if (expectedStart) return { level: 0, label: '一级：预计开工前一天交货', date: new Date(expectedStart.getTime() - 86400000), source: 'workflow_expected_date_minus_1_day' };
  return { level: 2, label: '三级：无交期后置', date: null, source: null };
}'''
    if not pri.search(s): raise SystemExit('getSchedulePriority not found')
    s = pri.sub(pri_new, s, 1)

    cmp = re.compile(r"function compareScheduleCandidates\(a, b\) \{.*?\n\}", re.S)
    cmp_new = r'''function compareScheduleCandidates(a, b) {
  if (a.priorityLevel !== b.priorityLevel) return a.priorityLevel - b.priorityLevel;
  if (a.priorityLevel < 2 && b.priorityLevel < 2) {
    const at = a.priorityDate ? a.priorityDate.getTime() : Number.POSITIVE_INFINITY;
    const bt = b.priorityDate ? b.priorityDate.getTime() : Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
  }
  const aUrgent = Math.max(0, Number(a.shortageQty) || 0), bUrgent = Math.max(0, Number(b.shortageQty) || 0);
  if (aUrgent !== bUrgent) return bUrgent - aUrgent;
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.workflowStagePriority !== b.workflowStagePriority) return a.workflowStagePriority - b.workflowStagePriority;
  if (a.score !== b.score) return a.score - b.score;
  return a.endTime.getTime() - b.endTime.getTime();
}'''
    if not cmp.search(s): raise SystemExit('compareScheduleCandidates not found')
    s = cmp.sub(cmp_new, s, 1)

    s = s.replace('''  const candidates = [
    order?.machine_tokens,
    product?.machines,
    order?.machine,
    order?.equipment
  ];''', '''  const candidates = [
    product?.machines,
    order?.machine_tokens,
    order?.machine,
    order?.equipment
  ];''', 1)
    s = s.replace('''function resolveOrderCapacity(order, productMap) {
  if (isNumericCapacity(order.capacity)) return Number(order.capacity);
  const p = productMap.get(String(order.product_code || '').trim());
  if (p && isNumericCapacity(p.capacity)) return Number(p.capacity);
  return 1000;
}''', '''function resolveOrderCapacity(order, productMap) {
  const p = productMap.get(String(order.product_code || '').trim());
  if (p && isNumericCapacity(p.capacity)) return Number(p.capacity);
  if (isNumericCapacity(order.capacity)) return Number(order.capacity);
  return 1000;
}''', 1)
    s = s.replace('''function resolveMoldChangeTime(order, productMap) {
  const n = Number(order.mold_change_time);
  if (Number.isFinite(n) && n >= 0) return n;
  const p = productMap.get(String(order.product_code || '').trim());
  const pn = p ? Number(p.mold_change_time) : NaN;
  return Number.isFinite(pn) && pn >= 0 ? pn : 30;
}''', '''function resolveMoldChangeTime(order, productMap) {
  const p = productMap.get(String(order.product_code || '').trim());
  const pn = p ? Number(p.mold_change_time) : NaN;
  if (Number.isFinite(pn) && pn >= 0) return pn;
  const n = Number(order.mold_change_time);
  if (Number.isFinite(n) && n >= 0) return n;
  return 30;
}''', 1)
    s = s.replace('const updateOrderStatus = db.prepare("UPDATE orders SET status=\'scheduled\' WHERE id=?");', 'const updateOrderStatus = db.prepare("UPDATE orders SET status=\'scheduled\', workflow_production_progress=\'已排待制\' WHERE id=?");', 1)
    s = s.replace("const issueDate = normalizeImportedDate(findImportValue(row, [\n    '发料日期','预计发料日期','实发料日期','应发料日期'\n  ])) || null;", "const issueDate = normalizeImportedDate(findImportValue(row, [\n    '发料日期','预计发料日期','实发料日期','应发料日期'\n  ])) || (stage === 'available_to_issue' ? importSnapshotDate : null);")

# These two date rules are required even on reruns where the main marker already exists.
if "const importSnapshotDate = excelContext.snapshotDate || todayISO();" not in s:
    s=s.replace('  const product = productMap.get(productCode) || null;\n', '  const product = productMap.get(productCode) || null;\n  const importSnapshotDate = excelContext.snapshotDate || todayISO();\n', 1)
    s=s.replace("    const excelContext=buildWorkflowExcelContext(rows);\n", "    const excelContext=buildWorkflowExcelContext(rows);\n    excelContext.snapshotDate = snapshotDate;\n", 1)

s = MARK + '\n' + s if MARK not in s else s
SERVER.write_text(s, encoding='utf-8')

h = PAGE.read_text(encoding='utf-8')
s = SERVER.read_text(encoding='utf-8')
for marker in required_ui:
    if marker not in h: raise SystemExit('UI validation failed: ' + marker)
for marker in [MARK, "source: 'workflow_expected_date_minus_1_day'", 'product?.machines', "workflow_production_progress='已排待制'", "const importSnapshotDate = excelContext.snapshotDate || todayISO();"]:
    if marker not in s: raise SystemExit('server validation failed: ' + marker)
if "const issueDate = normalizeImportedDate(findImportValue(row, [\n    '发料日期','预计发料日期','实发料日期','应发料日期'\n  ])) || (stage === 'available_to_issue' ? importSnapshotDate : null);" not in s:
    raise SystemExit('available_to_issue expected issue date rule missing')
if "currentSubTab = 'gantt';" not in h: raise SystemExit('schedule result view validation failed')
print('V5.1.2 business logic patch v2 applied and verified')
