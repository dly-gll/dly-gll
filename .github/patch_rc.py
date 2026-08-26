from pathlib import Path

p = Path('server.js')
s = p.read_text(encoding='utf-8')

old_stage = '''  // 以 Excel 的“生产进度(Q)”为第一来源，避免 S 列“欠料明细”中的“上机”把待排工单误判为在制。
  if (/成品检验中|成品已完工|已完工|完工|结案/.test(p)) return 'completed';
  if (/车间在制|在制|生产中|生产进行中|已开工|生产执行/.test(p)) return 'in_process';
  if (/车间待排|待排产|待排|等待排产/.test(p));

  // 车间待排的兜底：已发料+齐料。
  if (/已发料/.test(sc) && /齐料/.test(m)) return 'waiting_schedule';

  // 欠料只看物料状态/欠料明细，不把其他列的普通说明误判为欠料。
  if (/欠料|缺料|缺材料|欠材|待采购回复|待厂商合同|待财务付款|待厂内.*回货|待通知交货|待回复/.test(m) ||
      /欠料|缺料|缺材料|欠材|待采购回复|待厂商合同|待财务付款|待厂内.*回货|待通知交货|待回复/.test(sd)) {
    return 'shortage';
  }

  // “仓库有料 / 仓库有料，分切 / 仓库有料，待分切”等统一归入有料待发。
  if (/仓库有料|有料待发|待发料|待发|待分切|分切/.test(m) || /有料待发|待发料|待发/.test(p)) {
    return 'available_to_issue';
  }
'''

# exact source block as shipped in the verified candidate
old_stage = '''  // 以 Excel 的“生产进度(Q)”为第一来源，避免 S 列“欠料明细”中的“上机”把待排工单误判为在制。
  if (/成品检验中|成品已完工|已完工|完工|结案/.test(p)) return 'completed';
  if (/车间在制|在制|生产中|生产进行中|已开工|生产执行/.test(p)) return 'in_process';
  if (/车间待排|待排产|待排|等待排产/.test(p)) return 'waiting_schedule';

  // 车间待排的兜底：已发料+齐料。
  if (/已发料/.test(sc) && /齐料/.test(m)) return 'waiting_schedule';

  // 欠料只看物料状态/欠料明细，不把其他列的普通说明误判成欠料。
  if (/欠料|缺料|缺材料|欠材|待采购回复|待厂商合同|待财务付款|待厂内.*回货|待通知交货|待回复/.test(m) ||
      /欠料|缺料|缺材料|欠材|待采购回复|待厂商合同|待财务付款|待厂内.*回货|待通知交货|待回复/.test(sd)) {
    return 'shortage';
  }

  // “仓库有料 / 仓库有料，分切 / 仓库有料，待分切”等统一归入有料待发。
  if (/仓库有料|有料待发|待发料|待发|待分切|分切/.test(m) || /有料待发|待发料|待发/.test(p)) {
    return 'available_to_issue';
  }
'''
new_stage = '''  // 先处理明确完工；完工工单不再进入其他板块。
  if (/成品检验中|成品已完工|已完工|完工|结案/.test(p)) return 'completed';

  // 欠料优先级高于生产进度：只要“是否齐料/欠料明细”明确表示欠料，就进入欠料板块。
  if (/欠料|缺料|缺材料|欠材|待采购回复|待厂商合同|待财务付款|待厂内.*回货|待通知交货|待回复|未齐|不齐|不全|不够|^(否|no)$/i.test(m) ||
      /欠料|缺料|缺材料|欠材|待采购回复|待厂商合同|待财务付款|待厂内.*回货|待通知交货|待回复/.test(sd)) {
    return 'shortage';
  }

  // 生产进度栏是“车间在制”时进入在制。
  if (/车间在制|在制|生产中|生产进行中|已开工|生产执行/.test(p)) return 'in_process';

  // 生产进度栏明确为“车间待排”时进入待排；不能被“有料”状态抢走。
  if (/车间待排|待排产|待排|等待排产/.test(p)) return 'waiting_schedule';

  // 车间待排的兜底：已发料+齐料。
  if (/已发料/.test(sc) && /齐料/.test(m)) return 'waiting_schedule';

  // “仓库有料 / 有料 / 待发料 / 待分切”等统一归入有料待发；“齐料”本身不作为有料待发条件。
  if (/仓库有料|有料待发|有料|待发料|待发|待分切|分切/.test(m) || /有料待发|待发料|待发/.test(p)) {
    return 'available_to_issue';
  }
'''
if old_stage not in s:
    raise SystemExit('stage detection block not found')
s = s.replace(old_stage, new_stage, 1)

old_return = '''  const note = normalizeImportText(findImportValue(row, ['备注','说明','原因','备注说明','comment','note'])) || fullText.slice(0,500);
  return {
'''
new_return = '''  // 看板/KPI 的阶段计划日期必须跟随当前板块：欠料=预计齐料，有料待发=预计发料，待排=预计开工，在制=预计完工。
  // 不再把整行泛化的“计划日期”带到所有板块，避免历史计划日期污染当前阶段。
  const stageExpectedDate = stage === 'shortage' ? (readyDate || null)
    : stage === 'available_to_issue' ? (issueDate || null)
    : stage === 'waiting_schedule' ? (startDate || null)
    : stage === 'in_process' ? (finishDate || null)
    : stage === 'completed' ? (finishDate || expectedDate || null)
    : (expectedDate || null);

  const note = normalizeImportText(findImportValue(row, ['备注','说明','原因','备注说明','comment','note'])) || fullText.slice(0,500);
  return {
'''
if old_return not in s:
    raise SystemExit('extract return anchor not found')
s = s.replace(old_return, new_return, 1)

old_expected = '    expected_date: expectedDate,\n'
new_expected = '    expected_date: stageExpectedDate,\n'
if old_expected not in s:
    raise SystemExit('expected_date assignment not found')
s = s.replace(old_expected, new_expected, 1)

old_alert = '''    const alerts=rows.filter(r=>r.workflow_expected_date && r.workflow_expected_date < todayISO() && !['completed'].includes(stage))
      .map(r=>({order_number:r.order_number,product_code:r.product_code,reason:`计划日期 ${r.workflow_expected_date} 已过，当前仍在${WORKFLOW_STAGES[stage]}`}));
'''
new_alert = '''    const alertDateLabel = stage === 'shortage' ? '预计齐料日期'
      : stage === 'available_to_issue' ? '预计发料日期'
      : stage === 'waiting_schedule' ? '预计开工日期'
      : stage === 'in_process' ? '预计完工日期'
      : '计划日期';
    const alerts=rows.filter(r=>r.workflow_expected_date && r.workflow_expected_date < todayISO() && !['completed'].includes(stage))
      .map(r=>({order_number:r.order_number,product_code:r.product_code,reason:`${alertDateLabel} ${r.workflow_expected_date} 已过，当前仍在${WORKFLOW_STAGES[stage]}`}));
'''
if old_alert not in s:
    raise SystemExit('alert block not found')
s = s.replace(old_alert, new_alert, 1)

p.write_text(s, encoding='utf-8')
Path('public').mkdir(exist_ok=True)
if not Path('public/index.html').exists():
    Path('public/index.html').write_text(Path('index.html').read_text(encoding='utf-8'), encoding='utf-8')
print('patched server.js and created public/index.html')
