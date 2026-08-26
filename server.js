const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('better-sqlite3');
const bodyParser = require('body-parser');
const session = require('express-session');
const XLSX = require('xlsx');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.disable('x-powered-by');

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.SOCKET_ORIGIN || true,
    methods: ['GET', 'POST'],
    credentials: true
  }
});

const db = new sqlite3('data.db');

// 初始化数据库
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE,
  password TEXT,
  role TEXT DEFAULT 'viewer',
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  machine_type TEXT,
  status TEXT DEFAULT 'active',
  remark TEXT
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_number TEXT,
  product_code TEXT,
  product_name TEXT,
  quantity INTEGER,
  shipping_quantity INTEGER DEFAULT 0,
  delivery_time TEXT,
  capacity INTEGER DEFAULT 1000,
  mold TEXT,
  mold_change_time INTEGER DEFAULT 30,
  process TEXT,
  status TEXT DEFAULT 'pending',
  remark TEXT
);
CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER,
  machine_id INTEGER,
  start_time TEXT,
  end_time TEXT,
  mold_change_start TEXT,
  mold_change_end TEXT,
  planned_quantity INTEGER,
  status TEXT DEFAULT 'scheduled',
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  work_start TEXT DEFAULT '08:00',
  work_end TEXT DEFAULT '20:00',
  break_lunch_start TEXT DEFAULT '12:00',
  break_lunch_end TEXT DEFAULT '13:00',
  break_dinner_start TEXT DEFAULT '17:30',
  break_dinner_end TEXT DEFAULT '18:00'
);
CREATE TABLE IF NOT EXISTS product_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_code TEXT UNIQUE NOT NULL,
  product_name TEXT,
  mold TEXT,
  process TEXT,
  capacity INTEGER DEFAULT 1000,
  mold_change_time INTEGER DEFAULT 30,
  remark TEXT
);
CREATE TABLE IF NOT EXISTS setup_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_family TEXT NOT NULL,
  to_family TEXT NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 30,
  UNIQUE(from_family, to_family)
);
`);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    action TEXT NOT NULL,
    entity TEXT,
    entity_id TEXT,
    details TEXT,
    ip TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_orders_status_delivery ON orders(status, delivery_time);
  CREATE INDEX IF NOT EXISTS idx_schedules_machine_start ON schedules(machine_id, start_time);
  CREATE INDEX IF NOT EXISTS idx_schedules_order_status ON schedules(order_id, status);
  CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
  CREATE TABLE IF NOT EXISTS schedule_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    change_type TEXT NOT NULL,
    summary TEXT,
    before_json TEXT,
    after_json TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_schedule_changes_created_at ON schedule_changes(created_at);
`);

// 兼容旧数据库：按需补充 APS / V5.1 字段。
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('orders', 'priority', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'material_ready_at', 'TEXT');
ensureColumn('orders', 'machine_tokens', 'TEXT');
ensureColumn('orders', 'shipping_required_date', 'TEXT');
ensureColumn('orders', 'delivery_date', 'TEXT');
ensureColumn('orders', 'workflow_stage', 'TEXT');
ensureColumn('orders', 'workflow_status_text', 'TEXT');
ensureColumn('orders', 'workflow_expected_date', 'TEXT');
ensureColumn('orders', 'workflow_last_import_date', 'TEXT');
ensureColumn('orders', 'workflow_actual_ready_date', 'TEXT');
ensureColumn('orders', 'workflow_actual_issue_date', 'TEXT');
ensureColumn('orders', 'workflow_actual_start_date', 'TEXT');
ensureColumn('orders', 'workflow_actual_finish_date', 'TEXT');
ensureColumn('orders', 'workflow_production_progress', 'TEXT');
ensureColumn('orders', 'workflow_material_status', 'TEXT');
ensureColumn('orders', 'workflow_shortage_detail', 'TEXT');
ensureColumn('product_data', 'machines', 'TEXT');
ensureColumn('product_data', 'mold_count', 'REAL');
ensureColumn('product_data', 'jump_distance', 'REAL');

db.exec(`
CREATE TABLE IF NOT EXISTS workflow_import_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  filename TEXT,
  row_count INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_workflow_batch_snapshot ON workflow_import_batches(snapshot_date);
CREATE TABLE IF NOT EXISTS workflow_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER,
  snapshot_date TEXT NOT NULL,
  work_order_number TEXT,
  product_code TEXT,
  product_name TEXT,
  stage TEXT,
  status_text TEXT,
  expected_date TEXT,
  quantity REAL DEFAULT 0,
  sheet_name TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_snapshot_date_stage ON workflow_snapshots(snapshot_date, stage);
CREATE TABLE IF NOT EXISTS workflow_daily_kpi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kpi_date TEXT NOT NULL,
  stage TEXT NOT NULL,
  expected_count INTEGER DEFAULT 0,
  actual_count INTEGER DEFAULT 0,
  rate REAL DEFAULT 0,
  alert_count INTEGER DEFAULT 0,
  UNIQUE(kpi_date, stage)
);
CREATE TABLE IF NOT EXISTS product_supply (
  product_code TEXT PRIMARY KEY,
  inventory_qty REAL DEFAULT 0,
  inspection_qty REAL DEFAULT 0,
  sales_qty REAL DEFAULT 0,
  delivery_qty REAL DEFAULT 0,
  shipping_gap REAL DEFAULT 0,
  shortage_qty REAL DEFAULT 0,
  updated_at TEXT
);
`);

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt}$${derived.toString('hex')}`;
}
function verifyPassword(password, stored) {
  const raw = String(stored || '');
  if (!raw.startsWith('scrypt$')) return raw === String(password);
  const [, salt, hex] = raw.split('$');
  if (!salt || !hex) return false;
  const actual = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hex, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function recordScheduleChange(req, changeType, summary, beforeValue = {}, afterValue = {}) {
  try {
    db.prepare(`INSERT INTO schedule_changes(user_id, change_type, summary, before_json, after_json, created_at) VALUES (?,?,?,?,?,?)`)
      .run(req.session?.user?.id || null, changeType, String(summary || ''), JSON.stringify(beforeValue || {}), JSON.stringify(afterValue || {}), new Date().toISOString());
  } catch (err) { console.error('schedule change log failed:', err.message); }
}
function audit(req, action, entity = '', entityId = '', details = {}) {
  try {
    db.prepare(`INSERT INTO audit_logs(user_id, action, entity, entity_id, details, ip, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(req.session?.user?.id || null, action, entity, entityId == null ? '' : String(entityId), JSON.stringify(details), req.ip || '', new Date().toISOString());
  } catch (err) { console.error('audit log failed:', err.message); }
}
if (!db.prepare('SELECT id FROM users WHERE username=?').get('admin')) {
  db.prepare('INSERT INTO users(username,password,role,created_at) VALUES (?,?,?,?)').run('admin', hashPassword(process.env.DEFAULT_ADMIN_PASSWORD || 'admin123'), 'admin', new Date().toISOString());
}
if (!db.prepare('SELECT id FROM settings').get()) db.prepare('INSERT INTO settings(id) VALUES (1)').run();
if (db.prepare('SELECT COUNT(*) cnt FROM machines').get().cnt === 0) {
  db.prepare('INSERT INTO machines(name,machine_type,status) VALUES (?,?,?)').run('平压平1号','平压平模切机','active');
  db.prepare('INSERT INTO machines(name,machine_type,status) VALUES (?,?,?)').run('激光切割A','激光模切机','active');
}

app.use((req,res,next)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','SAMEORIGIN');res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');next();});
app.use(bodyParser.json({limit:'20mb'}));
app.use(bodyParser.urlencoded({limit:'20mb',extended:true,parameterLimit:5000}));
app.use(session({secret:process.env.SESSION_SECRET||'diecut-schedule-secret-change-me',resave:false,saveUninitialized:false,cookie:{maxAge:24*60*60*1000,httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production'}}));
app.use(express.static('public'));

function requireCsrf(req,res,next){if(!['POST','PUT','PATCH','DELETE'].includes(req.method))return next();const token=req.get('x-csrf-token');if(!req.session?.csrfToken||token!==req.session.csrfToken)return res.status(403).json({success:false,message:'安全校验失败，请刷新页面后重试'});next();}
function requireAuth(req,res,next){if(!req.session.user)return res.status(401).json({success:false,message:'请先登录'});next();}
function requireAdmin(req,res,next){if(!req.session.user||req.session.user.role!=='admin')return res.status(403).json({success:false,message:'仅管理员可操作'});next();}
function requireAdminEdit(req,res,next){requireAdmin(req,res,()=>requireCsrf(req,res,next));}
function requireEdit(req,res,next){if(!req.session.user||req.session.user.role==='viewer')return res.status(403).json({success:false,message:'没有操作权限'});requireCsrf(req,res,()=>next());}

app.get('/api/auth/status',(req,res)=>{if(req.session.user){req.session.csrfToken ||= crypto.randomBytes(24).toString('hex');req.session.user.csrf_token=req.session.csrfToken;res.json({logged_in:true,user:req.session.user});}else res.json({logged_in:false});});
app.post('/api/auth/login',(req,res)=>{const username=String(req.body?.username||'').trim();const password=String(req.body?.password||'');if(!username||!password)return res.status(400).json({success:false,message:'请输入用户名和密码'});const user=db.prepare('SELECT * FROM users WHERE username=?').get(username);if(!user||!verifyPassword(password,user.password))return res.status(401).json({success:false,message:'用户名或密码错误'});req.session.regenerate(err=>{if(err)return res.status(500).json({success:false,message:'登录会话初始化失败'});req.session.csrfToken=crypto.randomBytes(24).toString('hex');req.session.user={id:user.id,username:user.username,role:user.role,csrf_token:req.session.csrfToken};res.json({success:true,user:req.session.user});});});
app.post('/api/auth/logout',requireCsrf,(req,res)=>req.session.destroy(()=>res.json({success:true})));
app.get('/api/health',(req,res)=>{try{const x=db.prepare('SELECT 1 ok').get();res.json({ok:x?.ok===1,service:'diecut-schedule',time:new Date().toISOString()});}catch(err){res.status(503).json({ok:false});}});

function normalizeImportHeader(value){return String(value??'').replace(/[\u200B-\u200D\uFEFF]/g,'').replace(/[（）]/g,m=>m==='（'?'(' : ')').replace(/[\s\u3000]+/g,'').toLowerCase();}
function normalizeImportText(value){if(value===null||value===undefined)return '';return String(value).replace(/[\u200B-\u200D\uFEFF]/g,'').trim();}
function normalizeProductCode(value){return normalizeImportText(value).replace(/[\s\u3000]/g,'').toUpperCase();}
function findImportValue(row,aliases){const entries=Object.entries(row||{});const map=new Map(entries.map(([k,v])=>[normalizeImportHeader(k),v]));for(const alias of aliases){const key=normalizeImportHeader(alias);if(map.has(key))return map.get(key);}for(const [k,v] of entries){const nk=normalizeImportHeader(k);if(aliases.some(a=>nk.includes(normalizeImportHeader(a))))return v;}return '';}
function normalizeImportedDate(value){
  if(value instanceof Date&&!Number.isNaN(value.getTime())){const y=value.getFullYear();const m=String(value.getMonth()+1).padStart(2,'0');const d=String(value.getDate()).padStart(2,'0');return `${y}-${m}-${d}`;}
  const raw=normalizeImportText(value);if(!raw||/^#?(n\/a|value!|ref!|name\?|div\/0!)$/i.test(raw))return '';
  let m=raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);if(m)return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
  m=raw.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})/);if(m)return `${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}`;
  m=raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})/);if(m)return `${m[3]}-${String(m[1]).padStart(2,'0')}-${String(m[2]).padStart(2,'0')}`;
  const n=Number(raw);if(Number.isFinite(n)&&n>20000&&n<60000){const base=new Date(Date.UTC(1899,11,30));base.setUTCDate(base.getUTCDate()+Math.floor(n));return `${base.getUTCFullYear()}-${String(base.getUTCMonth()+1).padStart(2,'0')}-${String(base.getUTCDate()).padStart(2,'0')}`;}return raw;
}
function numberOr(value,fallback=0){const n=Number(String(value??'').replace(/,/g,''));return Number.isFinite(n)?n:fallback;}
function parseTextDateFromString(text){const raw=String(text||'').trim();const m=raw.match(/(\d{1,2})\s*[\/\-月]\s*(\d{1,2})\s*日?/);if(!m)return null;const y=new Date().getFullYear();return `${y}-${String(Number(m[1])).padStart(2,'0')}-${String(Number(m[2])).padStart(2,'0')}`;}

const WORKFLOW_STAGES={shortage:'欠料',available_to_issue:'有料待发',waiting_schedule:'车间待排',in_process:'车间在制',completed:'已完工',unknown:'未识别'};
const WORKFLOW_STAGE_ORDER=['shortage','available_to_issue','waiting_schedule','in_process','completed'];
function todayISO(){return new Date().toISOString().slice(0,10);}
function detectWorkflowStage(row){
  const progress=normalizeImportText(findImportValue(row,['生产进度','生产状态','生产阶段','production progress','progress']));
  const material=normalizeImportText(findImportValue(row,['是否齐料','齐料状态','物料状态','材料状态','material status']));
  const shortageDetail=normalizeImportText(findImportValue(row,['欠料明细','欠料原因','缺料明细','缺料原因','shortage detail']));
  const statusCode=normalizeImportText(findImportValue(row,['状态码','状态','工单状态','订单状态','status']));
  const p=progress.toLowerCase(),m=material.toLowerCase(),sd=shortageDetail.toLowerCase(),sc=statusCode.toLowerCase();
  if(/成品检验中|成品已完工|已完工|完工|结案/.test(p))return 'completed';
  if(/车间在制|在制|生产中|生产进行中|已开工|生产执行/.test(p))return 'in_process';
  if(/车间待排|待排产|待排|等待排产/.test(p))return 'waiting_schedule';
  if(/已发料/.test(sc)&&/齐料/.test(m))return 'waiting_schedule';
  if(/仓库有料|有料待发|待发料|待发|待分切|分切/.test(m)||/有料待发|待发料|待发/.test(p))return 'available_to_issue';
  if(/欠料|缺料|缺材料|欠材|待采购回复|待厂商合同|待财务付款|待厂内.*回货|待通知交货|待回复/.test(m)||/欠料|缺料|缺材料|欠材|待采购回复|待厂商合同|待财务付款|待厂内.*回货|待通知交货|待回复/.test(sd))return 'shortage';
  if(/外发|外购|众鑫源|江杉|美佳信|业健宏|五金冲压|正峰|恒基|泰尔森|英利悦|楚锋|众彩|创智捷/.test(p))return 'in_process';
  return 'unknown';
}
function isWorkOrderSheetName(name){return /在制工单明细|生产工单明细/i.test(String(name||''));}

function aggregateSheet(rows,sheetRegex,codeAliases,valueAliases){const out=new Map();for(const r of rows){if(!sheetRegex.test(String(r.__sheet_name||'')))continue;const code=normalizeProductCode(findImportValue(r,codeAliases));if(!code)continue;const value=numberOr(findImportValue(r,valueAliases),NaN);if(Number.isFinite(value))out.set(code,(out.get(code)||0)+value);}return out;}
function buildWorkflowExcelContext(rows){
  const inventory=aggregateSheet(rows,/库存明细/i,['品号','产品品号','product_code'],['库存数量','库存','在库数量','求和项:库存数量']);
  const inspection=aggregateSheet(rows,/待检产品/i,['品号','产品品号','product_code'],['待检数量','待检','检验中数量','求和项:待检数量']);
  const sales=aggregateSheet(rows,/销货明细/i,['品号','产品品号','product_code'],['销货数量','求和项:销货数量','已销货数量']);
  const delivery=aggregateSheet(rows,/每日急件满足进度/i,['品号','产品品号','product_code'],['交货数量','出货数量','已出货数量']);
  const urgentGap=new Map(),urgentShippingDate=new Map(),urgentDeliveryDate=new Map(),productNames=new Map(),products=new Map();
  for(const r of rows){const sheet=String(r.__sheet_name||'');if(/每日急件满足进度/i.test(sheet)){const code=normalizeProductCode(findImportValue(r,['品号','产品品号','product_code']));const gap=numberOr(findImportValue(r,['出货欠数']),NaN);if(code&&Number.isFinite(gap))urgentGap.set(code,gap);const shipDate=normalizeImportedDate(findImportValue(r,['要求出货时间','要求出货日期','出货需求日期','出货日期']));const delDate=normalizeImportedDate(findImportValue(r,['交货日期','要求交货日期','要求交货时间']));if(code&&shipDate&&!urgentShippingDate.has(code))urgentShippingDate.set(code,shipDate);if(code&&delDate&&!urgentDeliveryDate.has(code))urgentDeliveryDate.set(code,delDate);const nm=normalizeImportText(findImportValue(r,['品名','产品名称']));if(code&&nm)productNames.set(code,nm);}}
  // 产品/设备主数据从真正工单行和刀模基表补齐。
  for(const r of rows){if(/刀模基表/i.test(String(r.__sheet_name||''))){const code=normalizeProductCode(findImportValue(r,['品号','产品品号','product_code']));if(code){const old=products.get(code)||{};products.set(code,{...old,product_code:code,mold:normalizeImportText(findImportValue(r,['刀模号','刀模','mold']))||old.mold||'',product_name:old.product_name||normalizeImportText(findImportValue(r,['品名','产品名称']))||'',process:old.process||normalizeImportText(findImportValue(r,['工艺','制程']))||''});}}
    if(/模数跳距/i.test(String(r.__sheet_name||''))){const code=normalizeProductCode(findImportValue(r,['内部料号','品号','产品品号','product_code']));if(code){const old=products.get(code)||{};const mc=numberOr(findImportValue(r,['模数']),NaN),jump=numberOr(findImportValue(r,['跳距']),NaN);products.set(code,{...old,product_code:code,mold_count:Number.isFinite(mc)?mc:old.mold_count,jump_distance:Number.isFinite(jump)?jump:old.jump_distance});}}
  }
  const machineByProduct=new Map();for(const r of rows){if(!isWorkOrderSheetName(r.__sheet_name))continue;const code=normalizeProductCode(findImportValue(r,['品号','产品品号','product_code']));const machine=normalizeImportText(findImportValue(r,['机台配置','设备','设备名称','设备编号','机台','机台号','机器','生产设备']));if(code&&machine){const list=machineByProduct.get(code)||[];list.push(machine);machineByProduct.set(code,[...new Set(list)]);}}
  for(const [code,list] of machineByProduct){const old=products.get(code)||{product_code:code};products.set(code,{...old,machines:list.join(',')});}
  return {inventory,inspection,sales,delivery,urgentGap,urgentShippingDate,urgentDeliveryDate,products,productNames};
}
function extractWorkflowRow(row,index,productMap,excelContext){
  const productCode=normalizeProductCode(findImportValue(row,['品号','产品品号','料号','产品编号','产品代码','物料编码','物料号','product_code','item code','itemcode','part no']));
  const product=productMap.get(productCode)||null;const orderNumber=normalizeImportText(findImportValue(row,['工单编号','工单号','订单号','订单编号','制造单号','生产单号','work order','wo','wo no','生产工单']));
  const productName=normalizeImportText(findImportValue(row,['品名','产品名称','物料名称','产品名','product_name','item name']))||normalizeImportText(product?.product_name)||normalizeImportText(excelContext.productNames?.get(productCode));
  const quantity=numberOr(findImportValue(row,['工单数量','订单数量','需求数量','生产数量','计划数量','数量','qty','pcs','预计产量']),0);
  const stage=detectWorkflowStage(row),productionProgress=normalizeImportText(findImportValue(row,['生产进度','生产状态','生产阶段','production progress','progress'])),materialStatus=normalizeImportText(findImportValue(row,['是否齐料','齐料状态','物料状态','材料状态','material status'])),shortageDetail=normalizeImportText(findImportValue(row,['欠料明细','欠料原因','缺料明细','缺料原因','shortage detail']));
  const fullText=Object.values(row||{}).map(v=>normalizeImportText(v)).join(' | ');
  const shippingRequiredDate=normalizeImportedDate(findImportValue(row,['要求出货时间','出货需求日期','出货需求时间','客户出货需求日期','客户要求出货日期','要求出货日期','ship date','requested ship date']))||excelContext.urgentShippingDate?.get(productCode)||null;
  const deliveryDate=normalizeImportedDate(findImportValue(row,['交货日期','交货时间','客户交货日期','要求交货日期','要求交货时间','delivery_date','delivery date']))||excelContext.urgentDeliveryDate?.get(productCode)||null;
  const expectedDate=normalizeImportedDate(findImportValue(row,['预计日期','计划日期','应齐料日期','齐料日期','到料日期','发料日期','预计发料日期','预计开工日期','开工日期','计划开工日期','预计完工日期','应完工日期','expected date']))||null;
  const materialText=`${materialStatus} ${shortageDetail}`.trim();
  const readyDate=normalizeImportedDate(findImportValue(row,['齐料日期','应齐料日期','到料日期','预计齐料日期','预计到料日期']))||parseTextDateFromString(materialText)||null;
  const startDate=normalizeImportedDate(findImportValue(row,['预计开工','预计开工日期','开工日期','计划开工日期','预计上线日期']))||(stage==='waiting_schedule'?expectedDate:null);
  const issueDate=normalizeImportedDate(findImportValue(row,['发料日期','预计发料日期','实发料日期','应发料日期']))||null;
  const finishDate=normalizeImportedDate(findImportValue(row,['预计完工日期','完工日期','计划完工日期','应完工日期']))||(stage==='in_process'?expectedDate:null);
  let mold=normalizeImportText(findImportValue(row,['刀模','刀模号','刀模编号','模具','模具号','模具编号','mold','die']));let process=normalizeImportText(findImportValue(row,['工艺','制程','工序','process']));let machineTokens=normalizeImportText(findImportValue(row,['机台配置','设备','设备名称','设备编号','机台','机台号','机器','生产设备','machine','machine name']));let capacity=numberOr(findImportValue(row,['产能','UPH','uph','PCS/H','pcs/h','每小时产能','标准产能']),0);let moldChange=numberOr(findImportValue(row,['换模时间','换刀模时间','换模分钟','setup time','setup minutes']),0);
  const master=excelContext.products?.get(productCode);if(master){if(!mold)mold=normalizeImportText(master.mold);if(!process)process=normalizeImportText(master.process);if(!machineTokens)machineTokens=normalizeImportText(master.machines);if(!(capacity>0))capacity=numberOr(master.capacity,0);if(!(moldChange>=0))moldChange=numberOr(master.mold_change_time,0);}if(product){if(!mold)mold=normalizeImportText(product.mold);if(!process)process=normalizeImportText(product.process);if(!machineTokens)machineTokens=normalizeImportText(product.machines);if(!(capacity>0))capacity=numberOr(product.capacity,1000);if(!(moldChange>=0))moldChange=numberOr(product.mold_change_time,30);}if(!(capacity>0))capacity=1000;if(!(moldChange>=0))moldChange=30;
  const inventoryQty=excelContext.inventory?.get(productCode)??numberOr(findImportValue(row,['库存数量','库存','在库数量','inventory']),NaN),inspectionQty=excelContext.inspection?.get(productCode)??numberOr(findImportValue(row,['待检数量','待检','检验中数量','inspection','pending inspection']),NaN),salesQty=excelContext.sales?.get(productCode)??numberOr(findImportValue(row,['销货数量','销售数量','已销货数量','sales quantity']),NaN),deliveryQty=excelContext.delivery?.get(productCode)??numberOr(findImportValue(row,['交货数量','已交货数量','出货数量','已出货数量','delivery quantity']),NaN);
  const precomputedGap=excelContext.urgentGap?.get(productCode),computedGap=(Number.isFinite(inventoryQty)||Number.isFinite(inspectionQty)||Number.isFinite(salesQty)||Number.isFinite(deliveryQty))?(Number.isFinite(inventoryQty)?inventoryQty:0)+(Number.isFinite(inspectionQty)?inspectionQty:0)+(Number.isFinite(salesQty)?salesQty:0)-(Number.isFinite(deliveryQty)?deliveryQty:0):NaN,shippingGap=Number.isFinite(precomputedGap)?precomputedGap:(Number.isFinite(computedGap)?computedGap:null);
  return {work_order_number:orderNumber||null,product_code:productCode,product_name:productName,quantity,stage,status_text:fullText.slice(0,1000),production_progress:productionProgress,material_status:materialStatus,shortage_detail:shortageDetail,expected_date:expectedDate,expected_ready_date:readyDate,expected_issue_date:issueDate,expected_start_date:startDate,expected_finish_date:finishDate,shipping_required_date:shippingRequiredDate,delivery_date:deliveryDate,shipping_gap:shippingGap,mold,process,machine_tokens,capacity,mold_change_time:moldChange,note:shortageDetail||productionProgress||materialStatus||'Excel工作流自动导入',sheet_name:row.__sheet_name||'',import_row_index:row.__row_index||index+2};
}
function workflowStageRank(stage){return {unknown:0,shortage:1,available_to_issue:2,waiting_schedule:3,in_process:4,completed:5}[stage]||0;}
function getWorkflowOrderRow(workOrderNumber,productCode){if(workOrderNumber){const row=db.prepare("SELECT * FROM orders WHERE order_number=? ORDER BY id DESC LIMIT 1").get(workOrderNumber);if(row)return row;}if(productCode)return db.prepare("SELECT * FROM orders WHERE product_code=? ORDER BY CASE WHEN workflow_stage='waiting_schedule' THEN 0 WHEN workflow_stage='in_process' THEN 1 ELSE 2 END,id ASC LIMIT 1").get(productCode);return null;}
function updateWorkflowTransition(order,stage,snapshotDate,expectedDate=null,statusText=''){
  if(!order)return;const prev=order.workflow_stage||'unknown',patch={stage,workflow_status_text:statusText||null,workflow_expected_date:expectedDate||null};
  if(stage!==prev){const to=workflowStageRank(stage);if(to>=workflowStageRank('available_to_issue')&&!order.workflow_actual_ready_date)patch.workflow_actual_ready_date=snapshotDate;if(to>=workflowStageRank('waiting_schedule')&&!order.workflow_actual_issue_date)patch.workflow_actual_issue_date=snapshotDate;if(to>=workflowStageRank('in_process')&&!order.workflow_actual_start_date)patch.workflow_actual_start_date=snapshotDate;if(to>=workflowStageRank('completed')&&!order.workflow_actual_finish_date)patch.workflow_actual_finish_date=snapshotDate;}
  db.prepare(`UPDATE orders SET workflow_stage=?,workflow_status_text=COALESCE(NULLIF(?,''),workflow_status_text),workflow_expected_date=?,workflow_last_import_date=?,workflow_actual_ready_date=COALESCE(?,workflow_actual_ready_date),workflow_actual_issue_date=COALESCE(?,workflow_actual_issue_date),workflow_actual_start_date=COALESCE(?,workflow_actual_start_date),workflow_actual_finish_date=COALESCE(?,workflow_actual_finish_date) WHERE id=?`).run(stage,patch.workflow_status_text,patch.workflow_expected_date,snapshotDate,patch.workflow_actual_ready_date||null,patch.workflow_actual_issue_date||null,patch.workflow_actual_start_date||null,patch.workflow_actual_finish_date||null,order.id);
}
function recalcWorkflowDailyKpi(kpiDate){const target=String(kpiDate||todayISO()).slice(0,10);const expected={shortage:0,available_to_issue:0,waiting_schedule:0,in_process:0},actual={shortage:0,available_to_issue:0,waiting_schedule:0,in_process:0},alerts={shortage:0,available_to_issue:0,waiting_schedule:0,in_process:0};const prev=new Date(`${target}T00:00:00`);prev.setDate(prev.getDate()-1);const prevDate=prev.toISOString().slice(0,10);const prevRows=db.prepare('SELECT * FROM workflow_snapshots WHERE snapshot_date=?').all(prevDate);for(const r of prevRows){if(r.stage==='shortage'&&r.expected_date&&r.expected_date<=prevDate)expected.shortage++;if(r.stage==='available_to_issue'&&r.expected_date&&r.expected_date<=prevDate)expected.available_to_issue++;if(r.stage==='waiting_schedule'&&r.expected_date&&r.expected_date<=prevDate)expected.waiting_schedule++;if(r.stage==='in_process'&&r.expected_date&&r.expected_date<=prevDate)expected.in_process++;}const current=db.prepare('SELECT workflow_stage,COUNT(*) cnt FROM orders WHERE workflow_last_import_date=? GROUP BY workflow_stage').all(target);for(const r of current){if(Object.prototype.hasOwnProperty.call(actual,r.workflow_stage))actual[r.workflow_stage]=Number(r.cnt)||0;}for(const stage of Object.keys(expected)){const rate=expected[stage]>0?actual[stage]/expected[stage]*100:100;db.prepare(`INSERT INTO workflow_daily_kpi(kpi_date,stage,expected_count,actual_count,rate,alert_count) VALUES (?,?,?,?,?,?) ON CONFLICT(kpi_date,stage) DO UPDATE SET expected_count=excluded.expected_count,actual_count=excluded.actual_count,rate=excluded.rate,alert_count=excluded.alert_count`).run(target,stage,expected[stage],actual[stage],rate,alerts[stage]);}return db.prepare('SELECT * FROM workflow_daily_kpi WHERE kpi_date=?').all(target);}

app.post('/api/workflow/import',requireEdit,(req,res)=>{try{const rows=Array.isArray(req.body?.rows)?req.body.rows:[];if(!rows.length)return res.status(400).json({success:false,message:'Excel没有可导入的数据'});const snapshotDate=String(req.body?.snapshot_date||todayISO()).slice(0,10),filename=String(req.body?.filename||'workflow.xlsx').slice(0,200);const excelContext=buildWorkflowExcelContext(rows);const workRows=rows.filter(r=>isWorkOrderSheetName(r.__sheet_name));if(!workRows.length)return res.status(400).json({success:false,message:'未识别到“在制工单明细/生产工单明细”工作表，请检查Excel'});const productRows=db.prepare('SELECT * FROM product_data').all();const productMap=new Map(productRows.map(p=>[normalizeProductCode(p.product_code),p]));for(const [code,p] of excelContext.products){productMap.set(code,{...productMap.get(code),...p});}
  const upsertProduct=db.prepare(`INSERT INTO product_data(product_code,product_name,mold,process,capacity,mold_change_time,remark,machines,mold_count,jump_distance) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(product_code) DO UPDATE SET product_name=CASE WHEN excluded.product_name<>'' THEN excluded.product_name ELSE product_data.product_name END,mold=CASE WHEN excluded.mold<>'' THEN excluded.mold ELSE product_data.mold END,process=CASE WHEN excluded.process<>'' THEN excluded.process ELSE product_data.process END,machines=CASE WHEN excluded.machines<>'' THEN excluded.machines ELSE product_data.machines END,mold_count=COALESCE(excluded.mold_count,product_data.mold_count),jump_distance=COALESCE(excluded.jump_distance,product_data.jump_distance)`);
  db.transaction(()=>{for(const [code,p] of excelContext.products)upsertProduct.run(code,p.product_name||'',p.mold||'',p.process||'',Number(p.capacity)>0?Number(p.capacity):1000,Number(p.mold_change_time)>=0?Number(p.mold_change_time):30,'Excel自动识别',p.machines||'',Number.isFinite(p.mold_count)?p.mold_count:null,Number.isFinite(p.jump_distance)?p.jump_distance:null);})();
  const mergedRows=db.prepare('SELECT * FROM product_data').all(),mergedMap=new Map(mergedRows.map(p=>[normalizeProductCode(p.product_code),p])),normalized=workRows.map((r,i)=>extractWorkflowRow(r,i,mergedMap,excelContext));
  const batch=db.prepare('INSERT INTO workflow_import_batches(snapshot_date,imported_at,filename,row_count) VALUES (?,?,?,?)').run(snapshotDate,new Date().toISOString(),filename,normalized.length),insertSnap=db.prepare(`INSERT INTO workflow_snapshots(batch_id,snapshot_date,work_order_number,product_code,product_name,stage,status_text,expected_date,quantity,sheet_name,raw_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  db.transaction(items=>{for(const item of items){insertSnap.run(batch.lastInsertRowid,snapshotDate,item.work_order_number,item.product_code,item.product_name,item.stage,item.status_text,item.stage==='shortage'?item.expected_ready_date:item.stage==='available_to_issue'?item.expected_issue_date:item.stage==='waiting_schedule'?item.expected_start_date:item.stage==='in_process'?item.expected_finish_date:null,item.quantity,item.sheet_name,JSON.stringify(item),new Date().toISOString());let order=getWorkflowOrderRow(item.work_order_number,item.product_code);if(item.work_order_number&&!order&&item.quantity>0){const r=db.prepare(`INSERT INTO orders(order_number,product_code,product_name,quantity,shipping_quantity,shipping_required_date,delivery_date,delivery_time,capacity,mold,mold_change_time,process,machine_tokens,priority,material_ready_at,remark,workflow_stage,workflow_status_text,workflow_expected_date,workflow_last_import_date,workflow_production_progress,workflow_material_status,workflow_shortage_detail) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(item.work_order_number,item.product_code,item.product_name,item.quantity,0,item.shipping_required_date||null,item.delivery_date||null,null,Number(item.capacity)||1000,item.mold||'',Number(item.mold_change_time)||30,item.process||'',item.machine_tokens||'',item.shipping_gap>0?90:0,item.expected_ready_date||null,item.note||'Excel工作流自动导入',item.stage,item.status_text,item.stage==='shortage'?item.expected_ready_date:item.stage==='available_to_issue'?item.expected_issue_date:item.stage==='waiting_schedule'?item.expected_start_date:item.stage==='in_process'?item.expected_finish_date:null,snapshotDate,item.production_progress||'',item.material_status||'',item.shortage_detail||'');order=db.prepare('SELECT * FROM orders WHERE id=?').get(r.lastInsertRowid);}if(order){const expectedStageDate=item.stage==='shortage'?item.expected_ready_date:item.stage==='available_to_issue'?item.expected_issue_date:item.stage==='waiting_schedule'?item.expected_start_date:item.expected_finish_date;updateWorkflowTransition(order,item.stage,snapshotDate,expectedStageDate,item.status_text);db.prepare(`UPDATE orders SET product_name=COALESCE(NULLIF(?,''),product_name),quantity=CASE WHEN ?>0 THEN ? ELSE quantity END,shipping_required_date=COALESCE(?,shipping_required_date),delivery_date=COALESCE(?,delivery_date),capacity=CASE WHEN ?>0 THEN ? ELSE capacity END,mold=COALESCE(NULLIF(?,''),mold),mold_change_time=CASE WHEN ?>=0 THEN ? ELSE mold_change_time END,process=COALESCE(NULLIF(?,''),process),machine_tokens=COALESCE(NULLIF(?,''),machine_tokens),material_ready_at=COALESCE(?,material_ready_at),workflow_status_text=?,workflow_expected_date=?,workflow_last_import_date=?,workflow_production_progress=?,workflow_material_status=?,workflow_shortage_detail=? WHERE id=?`).run(item.product_name||'',Number(item.quantity)||0,Number(item.quantity)||0,item.shipping_required_date||null,item.delivery_date||null,Number(item.capacity)||0,Number(item.capacity)||0,item.mold||'',Number(item.mold_change_time),Number(item.mold_change_time)||0,item.process||'',item.machine_tokens||'',item.expected_ready_date||null,item.status_text,item.stage==='shortage'?item.expected_ready_date:item.stage==='available_to_issue'?item.expected_issue_date:item.stage==='waiting_schedule'?item.expected_start_date:item.expected_finish_date,item.snapshot_date||snapshotDate,item.production_progress||'',item.material_status||'',item.shortage_detail||'',order.id);if(item.stage==='waiting_schedule')db.prepare("UPDATE orders SET status=CASE WHEN status='running' THEN status ELSE 'pending' END WHERE id=?").run(order.id);}}})(normalized);
  const supplyCodes=new Set([...excelContext.inventory.keys(),...excelContext.inspection.keys(),...excelContext.sales.keys(),...excelContext.urgentGap.keys()]);const upSupply=db.prepare(`INSERT INTO product_supply(product_code,inventory_qty,inspection_qty,sales_qty,delivery_qty,shipping_gap,shortage_qty,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(product_code) DO UPDATE SET inventory_qty=excluded.inventory_qty,inspection_qty=excluded.inspection_qty,sales_qty=excluded.sales_qty,delivery_qty=excluded.delivery_qty,shipping_gap=excluded.shipping_gap,shortage_qty=excluded.shortage_qty,updated_at=excluded.updated_at`);db.transaction(()=>{for(const code of supplyCodes){const inv=Number(excelContext.inventory.get(code)||0),insp=Number(excelContext.inspection.get(code)||0),sales=Number(excelContext.sales.get(code)||0),del=Number(excelContext.delivery.get(code)||0),fallback=inv+insp+sales-del,gap=excelContext.urgentGap.has(code)?Number(excelContext.urgentGap.get(code)||0):fallback;upSupply.run(code,inv,insp,sales,del,gap,Math.max(0,gap),new Date().toISOString());}})();
  const kpi=recalcWorkflowDailyKpi(snapshotDate);audit(req,'workflow_import','workflow',batch.lastInsertRowid,{filename,snapshot_date:snapshotDate,count:normalized.length,work_order_rows:workRows.length});io.emit('workflow_update',{message:`四板块Excel已导入 ${normalized.length} 条工单；供应数据按品号同步更新`});res.json({success:true,batch_id:batch.lastInsertRowid,count:normalized.length,kpi,stages:normalized.reduce((m,x)=>(m[x.stage]=(m[x.stage]||0)+1,m),{}),supply_products:supplyCodes.size,message:`已识别 ${normalized.length} 条在制工单；库存/待检/销货/出货欠数已按品号同步`});
}catch(err){console.error('工作流Excel导入失败:',err.stack||err.message);res.status(500).json({success:false,message:'工作流Excel导入失败：'+err.message});}});

app.get('/api/workflow/board',requireAuth,(req,res)=>{try{const stage=WORKFLOW_STAGE_ORDER.includes(String(req.query?.stage))?String(req.query.stage):'shortage';const rows=db.prepare(`SELECT o.id order_id,o.order_number,o.product_code,o.product_name,o.quantity,o.status order_status,o.shipping_required_date,o.delivery_date,o.delivery_time,o.priority,o.mold,o.process,o.capacity,o.mold_change_time,o.workflow_stage,o.workflow_status_text,o.workflow_expected_date,o.workflow_actual_ready_date,o.workflow_actual_issue_date,o.workflow_actual_start_date,o.workflow_actual_finish_date,o.workflow_production_progress,o.workflow_material_status,o.workflow_shortage_detail,ps.inventory_qty,ps.inspection_qty,ps.sales_qty,ps.delivery_qty,ps.shipping_gap,ps.shortage_qty,s.start_time scheduled_start,s.end_time scheduled_end,s.status schedule_status FROM orders o LEFT JOIN product_supply ps ON ps.product_code=o.product_code LEFT JOIN schedules s ON s.order_id=o.id AND s.status IN ('scheduled','running') WHERE o.workflow_stage=? ORDER BY CASE WHEN NULLIF(TRIM(o.shipping_required_date),'') IS NULL THEN 1 ELSE 0 END,CASE WHEN NULLIF(TRIM(o.shipping_required_date),'') IS NULL THEN 1 ELSE 0 END ASC,datetime(o.shipping_required_date),CASE WHEN NULLIF(TRIM(o.delivery_date),'') IS NULL THEN 1 ELSE 0 END,datetime(o.delivery_date),CASE WHEN NULLIF(TRIM(o.workflow_expected_date),'') IS NULL THEN 1 ELSE 0 END,datetime(o.workflow_expected_date),o.id ASC`).all(stage);const productRows=db.prepare('SELECT * FROM product_supply ORDER BY shortage_qty DESC').all();const shortageByProduct=new Map(productRows.map(x=>[x.product_code,Math.max(0,Number(x.shortage_qty)||0)]));const grouped=new Map();for(const r of rows){if(!grouped.has(r.product_code))grouped.set(r.product_code,[]);grouped.get(r.product_code).push(r);}for(const [code,list] of grouped){let remain=shortageByProduct.get(code)||0;for(const r of list){const take=Math.max(0,Math.min(remain,Number(r.quantity)||0));r.allocated_shortage_qty=take;remain-=take;}}const alerts=rows.filter(r=>r.workflow_expected_date&&r.workflow_expected_date<todayISO()&&stage!=='completed').map(r=>({order_number:r.order_number,product_code:r.product_code,reason:`计划日期 ${r.workflow_expected_date} 已过，当前仍在${WORKFLOW_STAGES[stage]}`}));res.json({success:true,stage,label:WORKFLOW_STAGES[stage],count:rows.length,alerts,rows,product_shortages:stage==='shortage'?[]:productRows});}catch(err){console.error('workflow board error:',err.stack||err.message);res.status(500).json({success:false,message:'读取车间板块失败：'+err.message});}});
app.get('/api/workflow/kpi',requireAuth,(req,res)=>{try{const date=String(req.query?.date||todayISO()).slice(0,10);const kpi=db.prepare('SELECT * FROM workflow_daily_kpi WHERE kpi_date=? ORDER BY stage').all(date);const latest=db.prepare('SELECT MAX(snapshot_date) snapshot_date FROM workflow_import_batches').get();res.json({success:true,date,kpi,latest_import_date:latest?.snapshot_date||null});}catch(err){res.status(500).json({success:false,message:'读取四板块KPI失败'});}});

// ================== 订单管理与 APS 其余接口 ==================
// 下面保留既有 V5.1 业务接口；为避免此验证版被错误替换，正式更新时必须基于完整现网 server.js 合并。
app.get('/api/orders',requireAuth,(req,res)=>{const orders=db.prepare('SELECT * FROM orders ORDER BY id DESC').all();res.json({orders});});
app.get('/api/machines',requireAuth,(req,res)=>res.json({machines:db.prepare('SELECT * FROM machines').all()}));
app.get('/api/schedules',requireAuth,(req,res)=>res.json({schedules:db.prepare('SELECT * FROM schedules ORDER BY start_time').all()}));
app.post('/api/schedule/auto-run',requireEdit,(req,res)=>res.json({success:false,message:'此验证分支暂不执行实际排产，先通过 Excel/四板块验收'}));

app.use((err,req,res,next)=>{console.error('全局错误:',err.stack||err);res.status(500).json({success:false,message:'服务器内部错误，请查看服务器日志'});});
const PORT=process.env.PORT||3000;server.listen(PORT,'0.0.0.0',()=>console.log(`✅ 服务器已启动，访问地址: http://localhost:${PORT}`));
