const assert=require('assert');
function stage(row){
  const p=String(row.progress||'').trim().toLowerCase();
  const m=String(row.material||'').trim().toLowerCase();
  const sd=String(row.shortage||'').trim().toLowerCase();
  const sc=String(row.status||'').trim().toLowerCase();
  if(/成品检验中|成品已完工|已完工|完工|完成|结案/.test(p)) return 'completed';
  if(/车间待排|待排产|待排|等待排产/.test(p)) return 'waiting_schedule';
  if(/车间在制|在制|生产中|生产进行中|已开工|生产执行/.test(p)) return 'in_process';
  if(/仓库有料|有料待发|待发料|待发|待分切|分切/.test(m)) return 'available_to_issue';
  if(/欠料|缺料|缺材料|欠材|待采购回复|待厂商合同|待财务付款|待厂内.*回货|待通知交货|待回复/.test(m)||/欠料|缺料|缺材料|欠材|待采购回复|待厂商合同|待财务付款|待厂内.*回货|待通知交货|待回复/.test(sd)) return 'shortage';
  if(/已发料/.test(sc)&&/齐料/.test(m)) return 'waiting_schedule';
  if(/外发|外购|众鑫源|江杉|美佳信|业健宏|五金冲压|正峰|恒基|泰尔森|英利悦|楚锋|众彩|创智捷/.test(p)) return 'in_process';
  return 'unknown';
}
assert.equal(stage({progress:'车间待排',material:'齐料',shortage:'上机',status:'已发料'}),'waiting_schedule');
assert.equal(stage({progress:'未发料',material:'仓库有料',shortage:'8/21查料',status:'未生产'}),'available_to_issue');
assert.equal(stage({progress:'未发料',material:'欠料，待采购回复',shortage:'#N/A',status:'未生产'}),'shortage');
assert.equal(stage({progress:'车间在制',material:'齐料',shortage:'上机',status:'已发料'}),'in_process');
assert.equal(stage({progress:'成品检验中',material:'成品检验中',shortage:'上机',status:'已发料'}),'completed');
console.log('workflow stage rules ok');
