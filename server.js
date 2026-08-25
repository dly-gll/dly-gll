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

// 兼容旧数据库：按需补充 APS 字段。
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn('orders', 'priority', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('orders', 'material_ready_at', 'TEXT');

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
    db.prepare(`
      INSERT INTO schedule_changes(user_id, change_type, summary, before_json, after_json, created_at)
      VALUES (?,?,?,?,?,?)
    `).run(
      req.session?.user?.id || null,
      changeType,
      String(summary || ''),
      JSON.stringify(beforeValue || {}),
      JSON.stringify(afterValue || {}),
      new Date().toISOString()
    );
  } catch (err) {
    console.error('schedule change log failed:', err.message);
  }
}

function audit(req, action, entity = '', entityId = '', details = {}) {
  try {
    db.prepare(`
      INSERT INTO audit_logs(user_id, action, entity, entity_id, details, ip, created_at)
      VALUES (?,?,?,?,?,?,?)
    `).run(
      req.session?.user?.id || null,
      action,
      entity,
      entityId === null || entityId === undefined ? '' : String(entityId),
      JSON.stringify(details),
      req.ip || '',
      new Date().toISOString()
    );
  } catch (err) {
    console.error('audit log failed:', err.message);
  }
}

// 默认管理员：仅在不存在时创建；密码以 scrypt 存储
if (!db.prepare('SELECT id FROM users WHERE username = ?').get('admin')) {
  db.prepare('INSERT INTO users (username, password, role, created_at) VALUES (?,?,?,?)')
    .run('admin', hashPassword(process.env.DEFAULT_ADMIN_PASSWORD || 'admin123'), 'admin', new Date().toISOString());
} else {
  // 兼容旧数据库：首次登录时会自动把明文密码迁移为 scrypt。
}

// 默认设置
if (!db.prepare('SELECT id FROM settings').get()) {
  db.prepare('INSERT INTO settings (id) VALUES (1)').run();
}

// 默认示例设备
if (db.prepare('SELECT COUNT(*) as cnt FROM machines').get().cnt === 0) {
  db.prepare('INSERT INTO machines (name, machine_type, status) VALUES (?,?,?)').run('平压平1号', '平压平模切机', 'active');
  db.prepare('INSERT INTO machines (name, machine_type, status) VALUES (?,?,?)').run('激光切割A', '激光模切机', 'active');
}

// 中间件
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(bodyParser.json({ limit: '20mb' }));
app.use(bodyParser.urlencoded({ limit: '20mb', extended: true, parameterLimit: 5000 }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'diecut-schedule-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production'
  }
}));
app.use(express.static('public'));

const loginAttempts = new Map();
function checkLoginRateLimit(req, username) {
  const key = `${req.ip}|${String(username || '').toLowerCase()}`;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 12;
  const item = loginAttempts.get(key);
  if (!item || now - item.first > windowMs) {
    loginAttempts.set(key, { first: now, count: 1 });
    return true;
  }
  if (item.count >= maxAttempts) return false;
  item.count += 1;
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, item] of loginAttempts.entries()) {
    if (item.first < cutoff) loginAttempts.delete(key);
  }
}, 10 * 60 * 1000).unref();

// 权限中间件
function requireCsrf(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const token = req.get('x-csrf-token');
  if (!req.session?.csrfToken || token !== req.session.csrfToken) {
    return res.status(403).json({ success: false, message: '安全校验失败，请刷新页面后重试' });
  }
  next();
}
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ success: false, message: '请先登录' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user || req.session.user.role !== 'admin')
    return res.status(403).json({ success: false, message: '仅管理员可操作' });
  next();
}
function requireAdminEdit(req, res, next) {
  requireAdmin(req, res, () => requireCsrf(req, res, next));
}
function requireEdit(req, res, next) {
  if (!req.session.user || req.session.user.role === 'viewer')
    return res.status(403).json({ success: false, message: '没有操作权限' });
  requireCsrf(req, res, () => next());
}

// ================== 认证 ==================
app.get('/api/auth/status', (req, res) => {
  if (req.session.user) {
    req.session.csrfToken ||= crypto.randomBytes(24).toString('hex');
    req.session.user.csrf_token = req.session.csrfToken;
    res.json({ logged_in: true, user: req.session.user });
  } else {
    res.json({ logged_in: false });
  }
});

app.post('/api/auth/login', (req, res) => {
  const username = String(req.body?.username || '').trim().slice(0, 100);
  const password = String(req.body?.password || '');
  if (!username || !password) {
    return res.status(400).json({ success: false, message: '请输入用户名和密码' });
  }
  if (!checkLoginRateLimit(req, username)) {
    return res.status(429).json({ success: false, message: '登录尝试过于频繁，请 15 分钟后再试' });
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password)) {
    return res.status(401).json({ success: false, message: '用户名或密码错误' });
  }

  // 兼容旧库：登录成功后自动迁移明文密码。
  if (!String(user.password || '').startsWith('scrypt$')) {
    db.prepare('UPDATE users SET password=? WHERE id=?').run(hashPassword(password), user.id);
  }

  req.session.regenerate((err) => {
    if (err) {
      console.error('session regenerate failed:', err);
      return res.status(500).json({ success: false, message: '登录会话初始化失败' });
    }
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
    req.session.user = { id: user.id, username: user.username, role: user.role, csrf_token: req.session.csrfToken };
    audit(req, 'login', 'user', user.id);
    res.json({ success: true, user: req.session.user });
  });
});

app.post('/api/auth/logout', requireCsrf, (req, res) => {
  audit(req, 'logout', 'user', req.session?.user?.id || '');
  req.session.destroy(() => res.json({ success: true }));
});

app.post('/api/auth/change-password', requireAuth, (req, res, next) => requireCsrf(req, res, next), (req, res) => {
  const oldPassword = String(req.body?.oldPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (!oldPassword || !newPassword) {
    return res.json({ success: false, message: '原密码和新密码不能为空' });
  }
  if (newPassword.length < 6) {
    return res.json({ success: false, message: '新密码至少需要 6 位' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!user || !verifyPassword(oldPassword, user.password)) {
    return res.json({ success: false, message: '原密码错误' });
  }
  db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashPassword(newPassword), req.session.user.id);
  audit(req, 'change_password', 'user', req.session.user.id);
  res.json({ success: true, message: '密码修改成功' });
});

// ================== 用户管理（管理员） ==================
app.get('/api/users', requireAdmin, (req, res) => {
  const users = db.prepare('SELECT id, username, role, created_at FROM users').all();
  res.json({ users });
});

app.post('/api/users', requireAdminEdit, (req, res) => {
  const { username, password, role } = req.body;
  if (!username || !password) return res.json({ success: false, message: '用户名和密码不能为空' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username))
    return res.json({ success: false, message: '用户名已存在' });
  const validRoles = ['admin', 'editor', 'viewer'];
  const userRole = validRoles.includes(role) ? role : 'viewer';
  db.prepare('INSERT INTO users (username, password, role, created_at) VALUES (?,?,?,?)')
    .run(username.trim().slice(0, 100), hashPassword(password), userRole, new Date().toISOString());
  audit(req, 'create', 'user', '', { username: username.trim(), role: userRole });
  res.json({ success: true });
});

app.delete('/api/users/:id', requireAdminEdit, (req, res) => {
  const { id } = req.params;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.json({ success: false, message: '用户不存在' });
  if (user.username === 'admin') return res.json({ success: false, message: '不能删除超级管理员' });
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  audit(req, 'delete', 'user', id, { username: user.username });
  res.json({ success: true });
});

// ================== 订单管理 ==================
app.get('/api/orders', requireAuth, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY delivery_time ASC, id DESC').all();
  res.json({ orders });
});

app.post('/api/orders', requireEdit, (req, res) => {
  const { order_number, product_code, product_name, quantity, shipping_quantity, delivery_time, capacity, mold, mold_change_time, process, remark, priority, material_ready_at } = req.body || {};
  const qty = Number(quantity);
  const shipQty = Number(shipping_quantity || 0);
  const cap = Number(capacity || 1000);
  const setup = Number(mold_change_time || 30);
  const pri = Math.max(0, Math.min(100, Number(priority) || 0));
  if (!order_number?.trim() || !product_code?.trim() || !product_name?.trim() || !mold?.trim()) {
    return res.status(400).json({ success: false, message: '请填写所有必填项' });
  }
  if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(cap) || cap <= 0 || !Number.isFinite(setup) || setup < 0) {
    return res.status(400).json({ success: false, message: '数量、产能、换模时间必须是有效数字' });
  }
  if (shipQty < 0) return res.status(400).json({ success: false, message: '已出货数量不能小于 0' });

  const stmt = db.prepare('INSERT INTO orders (order_number, product_code, product_name, quantity, shipping_quantity, delivery_time, capacity, mold, mold_change_time, process, remark, priority, material_ready_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const result = stmt.run(order_number.trim(), product_code.trim(), product_name.trim(), qty, shipQty, delivery_time || null, cap, mold.trim(), setup, String(process || '').trim(), String(remark || '').slice(0, 1000), pri, material_ready_at || null);
  audit(req, 'create', 'order', result.lastInsertRowid, { order_number: order_number.trim(), quantity: qty });
  io.emit('order_update', { message: '新订单已创建' });
  res.status(201).json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/orders/:id', requireEdit, (req, res) => {
  const { id } = req.params;
  const { order_number, product_code, product_name, quantity, shipping_quantity, delivery_time, capacity, mold, mold_change_time, process, remark, priority, material_ready_at } = req.body;
  db.prepare('UPDATE orders SET order_number=?, product_code=?, product_name=?, quantity=?, shipping_quantity=?, delivery_time=?, capacity=?, mold=?, mold_change_time=?, process=?, remark=?, priority=?, material_ready_at=? WHERE id=?')
    .run(order_number, product_code, product_name, quantity, shipping_quantity || 0, delivery_time, capacity || 1000, mold, mold_change_time || 30, process, remark || '', Number(priority) || 0, material_ready_at || null, id);
  io.emit('order_update', { message: '订单已更新' });
  res.json({ success: true });
});

app.delete('/api/orders/:id', requireEdit, (req, res) => {
  const removeOrder = db.transaction((orderId) => {
    db.prepare('DELETE FROM schedules WHERE order_id = ?').run(orderId);
    return db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
  });
  const deleted = removeOrder(req.params.id);
  if (!deleted.changes) return res.status(404).json({ success: false, message: '订单不存在' });
  audit(req, 'delete', 'order', req.params.id);
  io.emit('order_update', { message: '订单已删除' });
  res.json({ success: true });
});

app.post('/api/orders/batch-delete', requireEdit, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.json({ success: false, message: '请先选择要删除的订单' });
  }
  const placeholders = ids.map(() => '?').join(',');
  const tx = db.transaction((orderIds) => {
    db.prepare(`DELETE FROM schedules WHERE order_id IN (${placeholders})`).run(...orderIds);
    db.prepare(`DELETE FROM orders WHERE id IN (${placeholders})`).run(...orderIds);
  });
  tx(ids);
  audit(req, 'delete', 'orders', ids.join(','), { count: ids.length });
  io.emit('order_update', { message: `已批量删除 ${ids.length} 条订单` });
  res.json({ success: true, count: ids.length });
});

// ================== Excel 智能导入 / V5 字段自动匹配 ==================
function normalizeImportHeader(value) {
  return String(value ?? '')
    .trim().toLowerCase()
    .replace(/[\s\u3000_\-\/\\()（）【】\[\]：:]+/g, '');
}

function normalizeImportText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function findImportValue(row, aliases) {
  const entries = Object.entries(row || {});
  const map = new Map(entries.map(([k,v]) => [normalizeImportHeader(k), v]));
  for (const alias of aliases) {
    const key = normalizeImportHeader(alias);
    if (map.has(key)) return map.get(key);
  }
  // 宽松包含匹配：兼容“客户订单号(工单)”、“预计出货日期”等现场字段。
  for (const [k,v] of entries) {
    const nk = normalizeImportHeader(k);
    if (aliases.some(a => nk.includes(normalizeImportHeader(a)))) return v;
  }
  return '';
}

function normalizeImportedDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const y = value.getFullYear();
    const m = String(value.getMonth()+1).padStart(2,'0');
    const d = String(value.getDate()).padStart(2,'0');
    return `${y}-${m}-${d}`;
  }
  const raw = normalizeImportText(value);
  if (!raw || /^#?(n\/a|value!|ref!|name\?|div\/0!)$/i.test(raw)) return '';
  const n = Number(raw);
  if (Number.isFinite(n) && n > 20000 && n < 60000) {
    const base = new Date(Date.UTC(1899,11,30));
    base.setUTCDate(base.getUTCDate() + Math.floor(n));
    return `${base.getUTCFullYear()}-${String(base.getUTCMonth()+1).padStart(2,'0')}-${String(base.getUTCDate()).padStart(2,'0')}`;
  }
  return raw;
}

function numberOr(value, fallback=0) {
  const n = Number(String(value ?? '').replace(/,/g,''));
  return Number.isFinite(n) ? n : fallback;
}

function autoNormalizeImportedOrder(row, index, productMap) {
  const productCode = normalizeImportText(findImportValue(row, [
    'order_product_code','product_code','品号','料号','产品编号','产品代码','物料编码','物料号','item code','itemcode','part no'
  ]));
  const product = productMap.get(productCode) || null;

  const orderNumber = normalizeImportText(findImportValue(row, [
    'order_number','工单编号','工单号','订单号','订单编号','制造单号','生产单号','work order','wo','wo no'
  ])) || `AUTO-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${index+1}`;

  const productName = normalizeImportText(findImportValue(row, [
    'product_name','品名','产品名称','物料名称','产品名','name','item name'
  ])) || normalizeImportText(product?.product_name);

  const quantity = numberOr(findImportValue(row, [
    'quantity','qty','工单数量','订单数量','需求数量','生产数量','计划数量','数量','pcs','总数量'
  ]), 0);

  const shippingQuantity = numberOr(findImportValue(row, [
    'shipping_quantity','出货数量','已出货数量','交货数量','发货数量'
  ]), 0);

  let deliveryTime = normalizeImportedDate(findImportValue(row, [
    'delivery_time','due_date','delivery date','delivery','交期','交货日期','交货时间','出货日期','出货时间','要求日期','客户交期'
  ]));

  let process = normalizeImportText(findImportValue(row, [
    'process','设备','设备名称','设备编号','机台','机台号','机器','机器编号','制程','工序','生产设备','machine','machine name'
  ]));
  let mold = normalizeImportText(findImportValue(row, [
    'mold','刀模','刀模号','刀模编号','模具','模具号','模具编号','die','diecut mold'
  ]));
  let capacity = numberOr(findImportValue(row, [
    'capacity','产能','UPH','uph','PCS/H','pcs/h','每小时产能','标准产能'
  ]), 0);
  let moldChange = numberOr(findImportValue(row, [
    'mold_change_time','换模时间','换刀模时间','换模分钟','setup time','setup minutes'
  ]), 0);
  const priority = Math.max(0, Math.min(100, numberOr(findImportValue(row, [
    'priority','优先级','订单优先级','急单等级','紧急度'
  ]), 0)));
  const materialReadyAt = normalizeImportedDate(findImportValue(row, [
    'material_ready_at','物料齐套时间','物料到位时间','材料齐套','备料完成时间','材料就绪时间'
  ])) || null;

  // V5 自动反查产品主数据补齐：设备、刀模、产能、换模时间、品名、工艺。
  if (product) {
    if (!process) process = normalizeImportText(product.process);
    if (!mold) mold = normalizeImportText(product.mold);
    if (!(capacity > 0)) capacity = numberOr(product.capacity, 1000);
    if (!(moldChange >= 0)) moldChange = numberOr(product.mold_change_time, 30);
  }
  if (!(capacity > 0)) capacity = 1000;
  if (!(moldChange >= 0)) moldChange = 30;

  const remark = normalizeImportText(findImportValue(row, ['remark','备注','说明','备注说明','comment','note']));
  const missing = [];
  if (!productCode) missing.push('品号');
  if (!productName) missing.push('品名');
  if (!(quantity > 0)) missing.push('数量');
  if (!mold) missing.push('刀模');
  if (!process) missing.push('设备');

  return {
    order_number: orderNumber,
    product_code: productCode,
    product_name: productName,
    quantity,
    shipping_quantity: shippingQuantity,
    delivery_time: deliveryTime,
    capacity,
    mold,
    mold_change_time: moldChange,
    process,
    priority,
    material_ready_at: materialReadyAt,
    remark,
    __import_index: index + 2,
    __matched_product: Boolean(product),
    __missing: missing
  };
}

app.post('/api/orders/import-normalize', requireEdit, (req, res) => {
  try {
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({success:false,message:'Excel 没有可导入的数据'});
    const productRows = db.prepare('SELECT * FROM product_data').all();
    const productMap = new Map(productRows.map(p => [normalizeImportText(p.product_code), p]));
    const normalized = rows.map((row,i) => autoNormalizeImportedOrder(row,i,productMap));
    const matched = normalized.filter(x => x.__matched_product).length;
    const unresolved = normalized.filter(x => x.__missing.length);
    res.json({
      success:true,
      total:normalized.length,
      matched_product_count:matched,
      unresolved_count:unresolved.length,
      unresolved:unresolved.slice(0,100).map(x => ({row:x.__import_index, order_number:x.order_number, product_code:x.product_code, missing:x.__missing})),
      orders:normalized
    });
  } catch (err) {
    console.error('Excel 智能映射失败:', err.stack || err.message);
    res.status(500).json({success:false,message:'Excel 智能映射失败：'+err.message});
  }
});

app.post('/api/orders/batch-import', requireEdit, (req, res) => {
  try {
    const { orders } = req.body;
    if (!Array.isArray(orders) || orders.length === 0) {
      return res.status(400).json({ success: false, message: '导入数据不能为空' });
    }
    const invalid = orders.filter(o => !o.product_code || !o.product_name || !(Number(o.quantity) > 0) || !o.mold || !o.process);
    if (invalid.length) {
      return res.status(400).json({ success:false, message:`有 ${invalid.length} 条工单缺少 V5 必要字段：品号、品名、数量、刀模或设备`, invalid_count:invalid.length });
    }
    const insert = db.prepare('INSERT INTO orders (order_number, product_code, product_name, quantity, shipping_quantity, delivery_time, capacity, mold, mold_change_time, process, priority, material_ready_at, remark) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const transaction = db.transaction((items) => {
      for (const o of items) {
        insert.run(
          String(o.order_number || '').trim(), String(o.product_code || '').trim(), String(o.product_name || '').trim(),
          Number(o.quantity), Number(o.shipping_quantity) || 0, o.delivery_time || null, Number(o.capacity) > 0 ? Number(o.capacity) : 1000,
          String(o.mold || '').trim(), Number(o.mold_change_time) >= 0 ? Number(o.mold_change_time) : 30, String(o.process || '').trim(),
          Math.max(0, Math.min(100, Number(o.priority) || 0)), o.material_ready_at || null, String(o.remark || '').trim()
        );
      }
    });
    transaction(orders);
    audit(req, 'import', 'orders', '', {count:orders.length, source:'excel-v5.1'});
    io.emit('order_update', { message: `已导入 ${orders.length} 条订单` });
    res.json({ success: true, count: orders.length });
  } catch (err) {
    console.error('订单批量导入失败:', err.stack || err.message);
    res.status(500).json({success:false,message:'订单导入失败：'+err.message});
  }
});

app.get('/api/orders/export', requireAuth, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders').all();
  const ws = XLSX.utils.json_to_sheet(orders);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '订单');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=orders.xlsx');
  res.send(buf);
});

// ================== 产品数据管理 ==================
app.get('/api/product-data', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM product_data ORDER BY product_code').all();
  res.json({ products: rows });
});

app.get('/api/product-data/by-code/:code', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM product_data WHERE product_code = ?').get(req.params.code);
  res.json({ product: row || null });
});

app.post('/api/product-data', requireEdit, (req, res) => {
  const { product_code, product_name, mold, process, capacity, mold_change_time, remark } = req.body;
  if (!product_code) return res.json({ success: false, message: '品号不能为空' });
  if (db.prepare('SELECT id FROM product_data WHERE product_code = ?').get(product_code))
    return res.json({ success: false, message: '该品号已存在' });
  db.prepare('INSERT INTO product_data (product_code, product_name, mold, process, capacity, mold_change_time, remark) VALUES (?,?,?,?,?,?,?)')
    .run(product_code, product_name || '', mold || '', process || '', capacity || 1000, mold_change_time || 30, remark || '');
  res.json({ success: true });
});

app.put('/api/product-data/:id', requireEdit, (req, res) => {
  const { id } = req.params;
  const { product_code, product_name, mold, process, capacity, mold_change_time, remark } = req.body;
  db.prepare('UPDATE product_data SET product_code=?, product_name=?, mold=?, process=?, capacity=?, mold_change_time=?, remark=? WHERE id=?')
    .run(product_code, product_name || '', mold || '', process || '', capacity || 1000, mold_change_time || 30, remark || '', id);
  res.json({ success: true });
});

app.delete('/api/product-data/:id', requireEdit, (req, res) => {
  db.prepare('DELETE FROM product_data WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// 批量删除产品数据
app.post('/api/product-data/batch-delete', requireEdit, (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.json({ success: false, message: '请先选择要删除的产品' });
  }
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM product_data WHERE id IN (${placeholders})`).run(...ids);
  res.json({ success: true, count: ids.length });
});

// 批量导入产品数据
app.post('/api/product-data/batch-import', requireEdit, (req, res) => {
  const { products } = req.body;
  if (!Array.isArray(products) || products.length === 0) {
    return res.json({ success: false, message: '导入数据不能为空' });
  }
  const insert = db.prepare('INSERT OR IGNORE INTO product_data (product_code, product_name, mold, process, capacity, mold_change_time, remark) VALUES (?,?,?,?,?,?,?)');
  const transaction = db.transaction((items) => {
    for (const p of items) {
      if (!p.product_code) continue;
      insert.run(p.product_code, p.product_name || '', p.mold || '', p.process || '', p.capacity || 1000, p.mold_change_time || 30, p.remark || '');
    }
  });
  transaction(products);
  io.emit('product_update');
  res.json({ success: true, count: products.length });
});

// ================== 设备管理 ==================
app.get('/api/machines', requireAuth, (req, res) => {
  const machines = db.prepare('SELECT * FROM machines').all();
  res.json({ machines });
});

app.post('/api/machines', requireEdit, (req, res) => {
  const { name, machine_type, status, remark } = req.body;
  if (!name || !machine_type) return res.json({ success: false, message: '请填写设备名称和类型' });
  const result = db.prepare('INSERT INTO machines (name, machine_type, status, remark) VALUES (?,?,?,?)').run(name, machine_type, status || 'active', remark || '');
  io.emit('machine_update');
  res.json({ success: true, id: result.lastInsertRowid });
});

app.put('/api/machines/:id', requireEdit, (req, res) => {
  const { id } = req.params;
  const { name, machine_type, status, remark } = req.body;
  db.prepare('UPDATE machines SET name=?, machine_type=?, status=?, remark=? WHERE id=?').run(name, machine_type, status, remark, id);
  io.emit('machine_update');
  res.json({ success: true });
});

// 设备类型重命名（保留原逻辑，但可能需要调整）
app.put('/api/machines/rename-type', requireAdminEdit, (req, res) => {
  const { old_type, new_type } = req.body;
  if (!old_type || !new_type) return res.json({ success: false, message: '请提供旧类型和新类型' });
  if (old_type === new_type) return res.json({ success: true, message: '类型未改变' });
  db.prepare('UPDATE machines SET machine_type = ? WHERE machine_type = ?').run(new_type, old_type);
  db.prepare('UPDATE orders SET process = ? WHERE process = ?').run(new_type, old_type);
  db.prepare('UPDATE product_data SET process = ? WHERE process = ?').run(new_type, old_type);
  io.emit('machine_update');
  io.emit('order_update', { message: '设备类型已重命名，相关订单已同步' });
  res.json({ success: true, message: '设备类型已更新' });
});

app.delete('/api/machines/:id', requireEdit, (req, res) => {
  db.prepare('DELETE FROM machines WHERE id = ?').run(req.params.id);
  io.emit('machine_update');
  res.json({ success: true });
});

// ================== 智能排程（APS 增强版） ==================
// 设计原则：
// 1) 有限产能：一台设备同一时刻只允许一个任务。
// 2) 交期优先：EDD + 松弛度/关键比率，防止单纯追求设备利用率导致急单延期。
// 3) 换模优化：同刀模/同产品族优先连续生产，减少非增值换模时间。
// 4) 多设备兼容：订单 process 支持 M23、MY04、MF04+M09、设备类型等写法。
// 5) 稳定性：空交期、#N/A、非法产能、非法换模时间均有默认值，不阻断排程。
// 6) 已完工任务保护：自动排程只重排未完工任务。
//
// 这类“交期 + 并行设备 + family/setup time”的问题在制造排程研究中属于典型的复杂调度问题；
// 实务上通常采用启发式/有限产能 APS，而不是只按交期简单排序。换模族聚类与交期之间需要做权衡。
function normalizeMachineToken(value) {
  return String(value || '')
    .trim()
    .replace(/[\u3000\s]+/g, '')
    .replace(/[＿_]/g, '')
    .toUpperCase();
}

function splitMachineTokens(value) {
  const raw = String(value || '').trim();
  if (!raw) return [];
  return [...new Set(raw.split(/[+＋,，、/\\|;；]+/).map(v => normalizeMachineToken(v)).filter(Boolean))];
}

function isNumericCapacity(value) {
  if (value === null || value === undefined || value === '') return false;
  const n = Number(String(value).replace(/,/g, '').trim());
  return Number.isFinite(n) && n > 0;
}

function parseDueDate(value) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw || /^#(N\/A|VALUE!|REF!|NAME\?|DIV\/0!)/i.test(raw)) return null;

  // YYYY-MM-DD / YYYY/MM/DD
  let m = raw.match(/^(\d{4})[-\/]([0-1]?\d)[-\/]([0-3]?\d)/);
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // MM/DD/YYYY or MM-DD-YYYY
  m = raw.match(/^(\d{1,2})[-\/]([0-3]?\d)[-\/](\d{4})/);
  if (m) {
    const d = new Date(Number(m[3]), Number(m[1]) - 1, Number(m[2]), 23, 59, 59, 999);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

function getOrderMachineTokens(order) {
  // 当前订单 process 是主要设备约束；产品主数据可作为补充。
  return splitMachineTokens(order.process);
}

function resolveOrderCapacity(order, productMap) {
  if (isNumericCapacity(order.capacity)) return Number(order.capacity);
  const p = productMap.get(String(order.product_code || '').trim());
  if (p && isNumericCapacity(p.capacity)) return Number(p.capacity);
  return 1000;
}

function resolveMoldChangeTime(order, productMap) {
  const n = Number(order.mold_change_time);
  if (Number.isFinite(n) && n >= 0) return n;
  const p = productMap.get(String(order.product_code || '').trim());
  const pn = p ? Number(p.mold_change_time) : NaN;
  return Number.isFinite(pn) && pn >= 0 ? pn : 30;
}

function familyKey(order) {
  const mold = String(order.mold || '').trim();
  if (mold) return `MOLD:${normalizeMachineToken(mold)}`;
  const code = String(order.product_code || '').trim();
  if (code) return `PROD:${normalizeMachineToken(code)}`;
  return `ORDER:${order.id}`;
}

function calcWorkEndTime(startTime, addMinutes, settings) {
  const toMinutes = (value, fallback) => {
    const [h, m] = String(value || fallback).split(':').map(Number);
    return Number.isFinite(h) && Number.isFinite(m)
      ? h * 60 + m
      : fallback.split(':').map(Number)[0] * 60 + fallback.split(':').map(Number)[1];
  };

  const workStartMin = toMinutes(settings.work_start, '08:00');
  const workEndMin = toMinutes(settings.work_end, '20:00');
  const lunchStartMin = toMinutes(settings.break_lunch_start, '12:00');
  const lunchEndMin = toMinutes(settings.break_lunch_end, '13:00');
  const dinnerStartMin = toMinutes(settings.break_dinner_start, '17:30');
  const dinnerEndMin = toMinutes(settings.break_dinner_end, '18:00');

  if (!(workStartMin < workEndMin)) throw new Error('系统设置错误：上班时间必须早于下班时间');

  let current = new Date(startTime);
  let remaining = Number(addMinutes);
  if (Number.isNaN(current.getTime())) throw new Error('排程时间无效');
  if (!Number.isFinite(remaining) || remaining < 0) remaining = 0;

  let guard = 0;
  while (remaining > 0 && guard++ < 20000) {
    const nowMin = current.getHours() * 60 + current.getMinutes() + current.getSeconds() / 60;

    if (nowMin < workStartMin) {
      current.setHours(Math.floor(workStartMin / 60), workStartMin % 60, 0, 0);
      continue;
    }
    if (nowMin >= workEndMin) {
      current.setDate(current.getDate() + 1);
      current.setHours(Math.floor(workStartMin / 60), workStartMin % 60, 0, 0);
      continue;
    }
    if (nowMin >= lunchStartMin && nowMin < lunchEndMin) {
      current.setHours(Math.floor(lunchEndMin / 60), lunchEndMin % 60, 0, 0);
      continue;
    }
    if (nowMin >= dinnerStartMin && nowMin < dinnerEndMin) {
      current.setHours(Math.floor(dinnerEndMin / 60), dinnerEndMin % 60, 0, 0);
      continue;
    }

    let segmentEnd = workEndMin;
    if (nowMin < lunchStartMin) segmentEnd = Math.min(segmentEnd, lunchStartMin);
    else if (nowMin < dinnerStartMin) segmentEnd = Math.min(segmentEnd, dinnerStartMin);

    const available = segmentEnd - nowMin;
    if (available <= 0) {
      current = new Date(current.getTime() + 60000);
      continue;
    }

    if (remaining <= available) {
      current = new Date(current.getTime() + remaining * 60000);
      remaining = 0;
    } else {
      remaining -= available;
      current.setHours(Math.floor(segmentEnd / 60), segmentEnd % 60, 0, 0);
    }
  }

  if (remaining > 0) throw new Error('排程时间计算超出安全范围');
  return current;
}

function ensureMachinesForOrders(orders) {
  // 兼容历史导入数据：若订单设备编号尚未建在设备表，自动建立为“自动导入设备”。
  const existing = db.prepare('SELECT * FROM machines').all();
  const byKey = new Map(existing.map(m => [normalizeMachineToken(m.name), m]));
  const insert = db.prepare('INSERT INTO machines (name, machine_type, status, remark) VALUES (?,?,?,?)');
  const created = [];

  for (const order of orders) {
    for (const token of getOrderMachineTokens(order)) {
      if (!byKey.has(token)) {
        const machine = insert.run(token, '自动导入设备', 'active', '根据订单设备字段自动创建');
        const row = db.prepare('SELECT * FROM machines WHERE id=?').get(machine.lastInsertRowid);
        byKey.set(token, row);
        created.push(row);
      }
    }
  }
  return { machines: db.prepare("SELECT * FROM machines WHERE status='active'").all(), created };
}

function getEligibleMachines(order, machines) {
  const tokens = getOrderMachineTokens(order);
  if (!tokens.length) return [];

  const normalized = machines.map(m => ({ m, name: normalizeMachineToken(m.name), type: normalizeMachineToken(m.machine_type) }));
  const exact = normalized.filter(x => tokens.includes(x.name)).map(x => x.m);
  if (exact.length) return exact;

  const byType = normalized.filter(x => tokens.includes(x.type)).map(x => x.m);
  if (byType.length) return byType;

  // 组合工艺：MF04+M09 表示订单可在组合中的任一设备执行。
  const fuzzy = normalized.filter(x => tokens.some(t => x.name.includes(t) || t.includes(x.name))).map(x => x.m);
  return [...new Map(fuzzy.map(m => [m.id, m])).values()];
}

function getLatestMachineFamilyState(machineIds) {
  if (!machineIds.length) return new Map();
  const placeholders = machineIds.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT s.machine_id, o.mold, o.product_code, s.end_time
    FROM schedules s
    JOIN orders o ON o.id = s.order_id
    WHERE s.status='completed' AND s.machine_id IN (${placeholders})
    ORDER BY s.machine_id, s.end_time DESC
  `).all(...machineIds);
  const state = new Map();
  for (const row of rows) {
    if (!state.has(row.machine_id)) {
      state.set(row.machine_id, { family: familyKey(row), endTime: new Date(row.end_time) });
    }
  }
  return state;
}

function getSetupMinutes(fromFamily, toFamily, defaultMinutes) {
  if (!fromFamily || !toFamily || fromFamily === toFamily) return 0;
  const row = db.prepare('SELECT minutes FROM setup_rules WHERE from_family=? AND to_family=?').get(fromFamily, toFamily);
  if (row && Number.isFinite(Number(row.minutes))) return Math.max(0, Number(row.minutes));
  return Math.max(0, Number(defaultMinutes) || 0);
}

function orderPriority(order) {
  const p = Number(order.priority);
  return Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : 0;
}

function materialReadyDate(order) {
  if (!order.material_ready_at) return null;
  const d = new Date(order.material_ready_at);
  return Number.isNaN(d.getTime()) ? null : d;
}

function candidateScore(candidate) {
  // V5.1 多目标 APS：对所有数值/日期做防御式归一化，避免 Excel 脏数据把整次排程打崩。
  const safeEndTime = candidate.endTime instanceof Date && !Number.isNaN(candidate.endTime.getTime())
    ? candidate.endTime : new Date(8640000000000000 - 1);
  // V5 多目标 APS：交期绝对优先，同时兼顾急单、客户优先级、换模、负荷均衡、物料释放和完工时间。
  // 分数越低越优先。为避免“省换模”把急单拖迟，对延期采用非线性惩罚。
  const tardiness = Math.max(0, Number(candidate.tardinessHours) || 0);
  const slack = Number.isFinite(Number(candidate.slackHours)) ? Number(candidate.slackHours) : 999;
  const setup = Math.max(0, Number(candidate.setupMinutes) || 0);
  const loadHours = Math.max(0, Number(candidate.loadHours) || 0);
  const balance = Math.max(0, Number(candidate.balancePenalty) || 0);
  const releaseDelay = Math.max(0, Number(candidate.releaseDelayHours) || 0);
  const priority = Math.max(0, Math.min(100, Number(candidate.priority) || 0));
  const familySame = candidate.familySame ? 1 : 0;
  const materialPenalty = Math.max(0, Number(candidate.materialReadyPenalty) || 0);
  const processMinutes = Math.max(0, Number(candidate.productionMinutes) || 0);

  // 延期小时数采用平方/指数式放大，确保急单不会因为节省换模而被牺牲。
  const tardinessPenalty = tardiness > 0 ? (tardiness * tardiness * 180000) + tardiness * 100000 : 0;
  const urgencyPenalty = slack < 0 ? Math.abs(slack) * 8000 : (slack < 24 ? (24 - slack) * 900 : 0);
  const priorityBonus = priority * 6500;
  const setupPenalty = setup * (familySame ? 40 : 220);
  const loadPenalty = loadHours * 45 + balance * 120;
  const releasePenalty = releaseDelay * 500;
  const material = materialPenalty * 10000;
  const shortJobBonus = Math.min(processMinutes, 240) * 1.5;
  const finishTieBreaker = safeEndTime.getTime() / 1e10;

  return tardinessPenalty + urgencyPenalty + setupPenalty + loadPenalty + releasePenalty + material +
    shortJobBonus - priorityBonus - familySame * 2500 + finishTieBreaker;
}

function compareScheduleCandidates(a, b) {
  // 硬规则：有交货/出货需求日期的订单，永远优先于没有日期的订单。
  // 只有当“有日期”的订单全部安排后，才允许安排无日期订单。
  const aHasDue = a.hasDueDate ? 0 : 1;
  const bHasDue = b.hasDueDate ? 0 : 1;
  if (aHasDue !== bHasDue) return aHasDue - bHasDue;

  // 对有日期订单：交期越近越优先。
  if (a.hasDueDate && b.hasDueDate) {
    const at = a.dueDate ? a.dueDate.getTime() : Number.POSITIVE_INFINITY;
    const bt = b.dueDate ? b.dueDate.getTime() : Number.POSITIVE_INFINITY;
    if (at !== bt) return at - bt;
  }

  // 同一交期层级再比较 V5 多目标评分。
  if (a.score !== b.score) return a.score - b.score;

  // 最后用预计完工时间作为稳定排序。
  return a.endTime.getTime() - b.endTime.getTime();
}

function buildSmartSchedule(orders, machines, settings, productMap, baseTime, lockedSchedules = []) {
  const machineTimers = new Map(machines.map(m => [m.id, new Date(baseTime)]));
  const familyState = getLatestMachineFamilyState(machines.map(m => m.id));
  for (const [id, st] of familyState.entries()) {
    const timer = machineTimers.get(id);
    if (st.endTime > timer) machineTimers.set(id, new Date(st.endTime));
  }

  // 已开工任务是硬锁：智能排程只能从其实际结束时间之后接排，不能覆盖或删除。
  for (const locked of lockedSchedules) {
    const end = new Date(locked.end_time || locked.start_time);
    if (Number.isNaN(end.getTime())) continue;
    const current = machineTimers.get(locked.machine_id) || new Date(baseTime);
    if (end > current) machineTimers.set(locked.machine_id, end);
    if (locked.machine_id && (locked.mold || locked.product_code)) {
      const fakeOrder = { id: locked.order_id, mold: locked.mold, product_code: locked.product_code };
      familyState.set(locked.machine_id, { family: familyKey(fakeOrder), endTime: end });
    }
  }

  const remaining = orders.slice();
  const result = [];
  const unscheduled = [];

  // 动态派工：每一步都从“订单 × 可用设备”所有候选里选综合代价最低的方案。
  // 这比固定 EDD 排序更适合多设备、换模、急单混排的车间。
  while (remaining.length) {
    let best = null;

    for (const order of remaining) {
      const qty = Math.max(0, Number(order.quantity) || 0);
      if (!qty) continue;
      const capacity = resolveOrderCapacity(order, productMap);
      const moldChange = resolveMoldChangeTime(order, productMap);
      const dueDate = parseDueDate(order.delivery_time);
      const hasDueDate = Boolean(dueDate);
      const readyDate = materialReadyDate(order);
      const family = familyKey(order);
      const eligible = getEligibleMachines(order, machines);
      if (!eligible.length) continue;

      const productionMinutes = qty / capacity * 60;
      const orderTokens = getOrderMachineTokens(order);

      for (const machine of eligible) {
        let machineReady = machineTimers.get(machine.id) || new Date(baseTime);
        if (readyDate && readyDate > machineReady) machineReady = new Date(readyDate);
        const last = familyState.get(machine.id);
        const setupMinutes = last ? getSetupMinutes(last.family, family, moldChange) : 0;
        const moldStart = new Date(machineReady);
        const moldEnd = calcWorkEndTime(moldStart, setupMinutes, settings);
        const prodEnd = calcWorkEndTime(moldEnd, productionMinutes, settings);
        const due = dueDate ? dueDate.getTime() : null;
        const tardinessHours = due === null ? 0 : Math.max(0, (prodEnd.getTime() - due) / 3600000);
        const slackHours = due === null ? 999 : (due - prodEnd.getTime()) / 3600000;
        const loadHours = Math.max(0, (machineReady.getTime() - baseTime.getTime()) / 3600000);
        const allLoads = machines.map(m => {
          const t = machineTimers.get(m.id) || baseTime;
          return Math.max(0, (t.getTime() - baseTime.getTime()) / 3600000);
        });
        const avgLoad = allLoads.length ? allLoads.reduce((a,b)=>a+b,0) / allLoads.length : loadHours;
        const maxLoad = allLoads.length ? Math.max(...allLoads) : loadHours;
        const projectedLoad = loadHours + setupMinutes / 60 + productionMinutes / 60;
        const balancePenalty = Math.max(0, projectedLoad - avgLoad) + Math.max(0, projectedLoad - maxLoad * 0.9);
        const familySame = Boolean(familyState.get(machine.id) && familyState.get(machine.id).family === family);
        const releaseDelayHours = Math.max(0, (machineReady.getTime() - baseTime.getTime()) / 3600000);
        const materialReadyPenalty = readyDate && readyDate > machineReady ? (readyDate.getTime() - machineReady.getTime()) / 3600000 : 0;

        const candidate = {
          order,
          machine,
          family,
          setupMinutes,
          moldStart,
          moldEnd,
          prodStart: moldEnd,
          prodEnd,
          endTime: prodEnd,
          dueDate,
          hasDueDate,
          tardinessHours,
          slackHours,
          loadHours,
          balancePenalty,
          releaseDelayHours,
          productionMinutes,
          familySame,
          tokens: orderTokens,
          priority: orderPriority(order),
          materialReadyPenalty,
          score: candidateScore({
            tardinessHours,
            slackHours,
            setupMinutes,
            loadHours,
            balancePenalty,
            releaseDelayHours,
            dueDate,
            priority: orderPriority(order),
            materialReadyPenalty,
            productionMinutes,
            familySame,
            endTime: prodEnd
          })
        };

        // V5.1 关键业务规则：
        // 1) 有交货/出货需求日期的订单必须先于无日期订单；
        // 2) 有日期订单内部按交期先后；
        // 3) 同交期层级再使用 V5 多目标评分。
        if (!best || compareScheduleCandidates(candidate, best) < 0) best = candidate;
      }
    }

    if (!best) {
      for (const order of remaining) {
        unscheduled.push({
          id: order.id,
          order_number: order.order_number,
          process: order.process,
          reason: !getEligibleMachines(order, machines).length ? '无可用设备' : '数据无效'
        });
      }
      break;
    }

    result.push(best);
    machineTimers.set(best.machine.id, new Date(best.endTime));
    familyState.set(best.machine.id, { family: best.family, endTime: new Date(best.endTime) });
    remaining.splice(remaining.indexOf(best.order), 1);
  }

  return { result, unscheduled };
}

app.post('/api/schedule/auto-run', requireEdit, (req, res) => {
  try {
    const settings = db.prepare('SELECT * FROM settings WHERE id=1').get();
    if (!settings) return res.status(500).json({ success: false, message: '系统设置不存在' });

    const allOpenOrders = db.prepare("SELECT * FROM orders WHERE status IN ('pending','scheduled','running') ORDER BY id ASC").all();
    const lockedSchedules = db.prepare(`
      SELECT s.*, o.mold, o.product_code, o.status AS order_status
      FROM schedules s JOIN orders o ON o.id=s.order_id
      WHERE s.status='running' OR o.status='running'
      ORDER BY s.machine_id, s.end_time
    `).all();
    const orders = allOpenOrders.filter(o => o.status !== 'running');
    if (!orders.length) return res.json({ success: false, message: '没有需要重新排程的未开工订单' });

    const productRows = db.prepare('SELECT * FROM product_data').all();
    const productMap = new Map(productRows.map(p => [String(p.product_code || '').trim(), p]));
    const ensured = ensureMachinesForOrders(orders);
    const machines = ensured.machines;
    if (!machines.length) return res.status(409).json({ success: false, message: '没有可用设备，未修改现有排程' });

    const now = new Date();
    const startParts = String(settings.work_start || '08:00').split(':').map(Number);
    let baseTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), startParts[0] || 8, startParts[1] || 0, 0, 0);
    if (now > baseTime) baseTime = now;

    const { result, unscheduled } = buildSmartSchedule(
      orders.filter(o => o.status !== 'completed'),
      machines,
      settings,
      productMap,
      baseTime,
      lockedSchedules
    );

    if (!result.length) {
      return res.status(409).json({
        success: false,
        message: `没有可执行的排程，现有排程保持不变。未排订单 ${unscheduled.length || orders.length} 个`,
        unscheduled
      });
    }

    const writeAll = db.transaction((items) => {
      db.prepare("DELETE FROM schedules WHERE status='scheduled'").run();
      db.prepare("UPDATE orders SET status='pending' WHERE status='scheduled'").run();

      const insertSchedule = db.prepare(`
        INSERT INTO schedules
        (order_id, machine_id, start_time, end_time, mold_change_start, mold_change_end, planned_quantity, status)
        VALUES (?,?,?,?,?,?,?,?)
      `);
      const updateOrderStatus = db.prepare("UPDATE orders SET status='scheduled' WHERE id=?");

      for (const item of items) {
        insertSchedule.run(
          item.order.id,
          item.machine.id,
          item.prodStart.toISOString(),
          item.prodEnd.toISOString(),
          item.moldStart.toISOString(),
          item.moldEnd.toISOString(),
          Number(item.order.quantity) || 0,
          'scheduled'
        );
        updateOrderStatus.run(item.order.id);
      }
    });
    writeAll(result);
    recordScheduleChange(req, 'auto-run', `智能排程：重排 ${result.length} 个订单，预计延期 ${result.filter(x => x.tardinessHours > 0).length} 个`,
      { mode:'rolling', preserved_running: lockedSchedules.length },
      { scheduled_count: result.length, unscheduled_count: unscheduled.length }
    );

    const scheduledCount = result.length;
    const completedCount = db.prepare("SELECT COUNT(*) AS cnt FROM schedules WHERE status='completed'").get().cnt;
    const lateCount = result.filter(x => x.tardinessHours > 0).length;
    const totalSetupMinutes = result.reduce((sum, x) => sum + x.setupMinutes, 0);
    const urgentCount = result.filter(x => x.slackHours < 12 || orderPriority(x.order) >= 80).length;
    const sameFamilyCount = result.filter(x => x.familySame).length;
    const datedCount = result.filter(x => x.hasDueDate).length;
    const undatedCount = result.filter(x => !x.hasDueDate).length;
    const maxFinish = result.length ? new Date(Math.max(...result.map(x => x.prodEnd.getTime()))) : null;

    const message = [
      `智能排程完成：${scheduledCount} 个订单`,
      `有交期 ${datedCount} 个，已统一优先排程`,
      `无交期 ${undatedCount} 个，已后置`,
      `换模 ${Math.round(totalSetupMinutes)} 分钟`,
      `预计延期 ${lateCount} 个`,
      maxFinish ? `预计完工 ${maxFinish.toLocaleString('zh-CN')}` : ''
    ].filter(Boolean).join('；');

    audit(req, 'auto_schedule', 'schedule', '', {
      scheduledCount, lateCount, totalSetupMinutes: Math.round(totalSetupMinutes), urgentCount, sameFamilyCount, algorithm:'V5-MultiObjective'
    });
    io.emit('schedule_update', { message });
    res.json({
      success: true,
      schedule_count: scheduledCount,
      completed_count: completedCount,
      late_count: lateCount,
      total_setup_minutes: Math.round(totalSetupMinutes),
      urgent_count: urgentCount,
      same_family_count: sameFamilyCount,
      dated_count: datedCount,
      undated_count: undatedCount,
      algorithm: 'V5-MultiObjective-DueDateFirst',
      created_machines: ensured.created.map(m => m.name),
      unscheduled,
      message
    });
  } catch (err) {
    console.error('智能排程出错:', err.stack || err.message);
    res.status(500).json({ success: false, message: '智能排程失败：' + String(err.message || '未知错误'), diagnostic: process.env.NODE_ENV !== 'production' ? (err.stack || '') : undefined });
  }
});

// 局部重新排程：以“实际完工时间”为新的设备释放时间，重排该机台所有尚未开始的任务。
// 关键保证：提前完工时，后续任务必须前移；延期完工时，后续任务必须后移。
function rescheduleMachine(machineId, fromTime, settings, anchorStartTime) {
  const machine = db.prepare("SELECT * FROM machines WHERE id = ?").get(machineId);
  if (!machine || machine.status !== 'active') return { count: 0, moved: [] };

  const release = new Date(fromTime);
  if (Number.isNaN(release.getTime())) throw new Error('实际完工时间无效，无法重新排程');

  // 只抓取该机台“尚未开始”的排程；完工任务和已经开始的任务不动。
  const futureSchedules = db.prepare(`
    SELECT s.*, o.priority, o.delivery_time, o.process, o.mold, o.quantity, o.capacity, o.mold_change_time, o.product_code
    FROM schedules s JOIN orders o ON o.id=s.order_id
    WHERE s.machine_id=? AND s.status='scheduled' AND s.start_time>=?
    ORDER BY s.start_time ASC, s.id ASC
  `).all(machineId, anchorStartTime || release.toISOString());

  const orderIds = futureSchedules.map(s => s.order_id);
  if (!orderIds.length) return { count: 0, moved: [] };

  // 拆掉原来的后续排程，恢复为待排产；然后从实际释放时间重新生成。
  const remove = db.transaction((ids) => {
    db.prepare("DELETE FROM schedules WHERE machine_id=? AND status='scheduled' AND id IN (" + ids.map(() => '?').join(',') + ")").run(machineId, ...ids);
    const setPending = db.prepare("UPDATE orders SET status='pending' WHERE id=?");
    for (const oid of orderIds) setPending.run(oid);
  });
  remove(futureSchedules.map(s => s.id));

  const productRows = db.prepare('SELECT * FROM product_data').all();
  const productMap = new Map(productRows.map(p => [String(p.product_code || '').trim(), p]));
  const pendingOrders = orderIds
    .map(id => db.prepare('SELECT * FROM orders WHERE id=?').get(id))
    .filter(Boolean);

  let timer = release;
  let lastFamily = null;
  const previous = db.prepare(`
    SELECT o.mold, o.product_code, s.end_time
    FROM schedules s JOIN orders o ON o.id=s.order_id
    WHERE s.machine_id=? AND s.status='completed'
    ORDER BY s.end_time DESC LIMIT 1
  `).get(machineId);
  if (previous) lastFamily = familyKey(previous);

  const remaining = pendingOrders.slice();
  const result = [];

  while (remaining.length) {
    let best = null;
    for (const order of remaining) {
      const eligible = getEligibleMachines(order, [machine]);
      if (!eligible.length) continue;
      const qty = Math.max(0, Number(order.quantity) || 0);
      if (!qty) continue;
      const capacity = resolveOrderCapacity(order, productMap);
      const moldChange = resolveMoldChangeTime(order, productMap);
      const family = familyKey(order);
      let candidateStart = new Date(timer);
      const ready = materialReadyDate(order);
      if (ready && ready > candidateStart) candidateStart = new Date(ready);
      const setupMinutes = getSetupMinutes(lastFamily, family, moldChange);
      const moldStart = new Date(candidateStart);
      const moldEnd = calcWorkEndTime(moldStart, setupMinutes, settings);
      const prodEnd = calcWorkEndTime(moldEnd, qty / capacity * 60, settings);
      const due = parseDueDate(order.delivery_time);
      const tardinessHours = due ? Math.max(0, (prodEnd-due)/3600000) : 0;
      const slackHours = due ? (due-prodEnd)/3600000 : 999;
      const score = candidateScore({
        tardinessHours, slackHours, setupMinutes,
        loadHours: Math.max(0, (candidateStart-release)/3600000),
        dueDate: due, endTime: prodEnd,
        priority: orderPriority(order), materialReadyPenalty: 0
      });
      const candidate = { order, family, setupMinutes, moldStart, moldEnd, prodStart:moldEnd, prodEnd, score, tardinessHours };
      if (!best || candidate.score < best.score) best = candidate;
    }
    if (!best) break;
    result.push(best);
    timer = new Date(best.prodEnd);
    lastFamily = best.family;
    remaining.splice(remaining.indexOf(best.order), 1);
  }

  const insert = db.prepare(`
    INSERT INTO schedules
    (order_id, machine_id, start_time, end_time, mold_change_start, mold_change_end, planned_quantity, status)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  const setScheduled = db.prepare("UPDATE orders SET status='scheduled' WHERE id=?");
  const write = db.transaction((items) => {
    for (const item of items) {
      insert.run(item.order.id, machineId, item.prodStart.toISOString(), item.prodEnd.toISOString(), item.moldStart.toISOString(), item.moldEnd.toISOString(), Number(item.order.quantity)||0, 'scheduled');
      setScheduled.run(item.order.id);
    }
  });
  write(result);

  return { count: result.length, moved: result.map(x => ({ order_id:x.order.id, order_number:x.order.order_number, end_time:x.prodEnd.toISOString() })) };
}

// 开工接口：将排程锁定为 running，后续自动排程不会覆盖该任务。
app.post('/api/schedules/:id/start', requireEdit, (req, res) => {
  try {
    const schedule = db.prepare(`SELECT s.*, o.status AS order_status FROM schedules s JOIN orders o ON o.id=s.order_id WHERE s.id=?`).get(req.params.id);
    if (!schedule) return res.status(404).json({ success:false, message:'排程不存在' });
    if (schedule.status === 'completed' || schedule.order_status === 'completed') {
      return res.status(409).json({ success:false, message:'已完工任务不能重复开工' });
    }
    const tx = db.transaction(() => {
      db.prepare("UPDATE schedules SET status='running' WHERE id=?").run(schedule.id);
      db.prepare("UPDATE orders SET status='running' WHERE id=?").run(schedule.order_id);
    });
    tx();
    audit(req, 'start', 'schedule', schedule.id, { order_id: schedule.order_id, machine_id: schedule.machine_id });
    io.emit('schedule_update', { message:'任务已开工，系统会锁定该任务避免自动排程覆盖' });
    res.json({ success:true, message:'已开工，任务已锁定' });
  } catch (err) {
    console.error('开工处理出错:', err.stack || err.message);
    res.status(500).json({ success:false, message:'服务器内部错误' });
  }
});

// 完工接口（支持修改时间）
app.post('/api/schedules/:id/complete', requireEdit, (req, res) => {
  try {
    const { id } = req.params;
    const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(id);
    if (!schedule) return res.status(404).json({ success: false, message: '排程不存在' });
    if (schedule.status === 'completed') return res.status(409).json({ success:false, message:'该任务已经完工，不能重复确认' });

    const { mold_change_start, mold_change_end, start_time, end_time, planned_quantity } = req.body;
    const completedAt = new Date().toISOString();
    const moldStart = mold_change_start ? new Date(mold_change_start) : new Date(schedule.mold_change_start);
    const moldEnd = mold_change_end ? new Date(mold_change_end) : new Date(schedule.mold_change_end);
    const prodStart = start_time ? new Date(start_time) : new Date(schedule.start_time);
    const prodEnd = end_time ? new Date(end_time) : new Date(schedule.end_time);
    const qty = planned_quantity !== undefined && planned_quantity !== '' ? Number(planned_quantity) : Number(schedule.planned_quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({ success:false, message:'完工数量必须大于 0' });
    }
    if ([moldStart,moldEnd,prodStart,prodEnd].some(d => Number.isNaN(d.getTime()))) {
      return res.json({ success:false, message:'完工时间存在无效值，请检查时间填写' });
    }
    if (moldEnd < moldStart || prodStart < moldEnd || prodEnd < prodStart) {
      return res.json({ success:false, message:'完工时间顺序不正确，请检查换模/生产开始结束时间' });
    }

    const completeTx = db.transaction(() => {
      db.prepare('UPDATE schedules SET status=?, completed_at=?, mold_change_start=?, mold_change_end=?, start_time=?, end_time=?, planned_quantity=? WHERE id=?')
        .run('completed', completedAt, moldStart.toISOString(), moldEnd.toISOString(), prodStart.toISOString(), prodEnd.toISOString(), qty, id);
      db.prepare('UPDATE orders SET status=? WHERE id=?').run('completed', schedule.order_id);
    });
    completeTx();
    audit(req, 'complete', 'schedule', id, { order_id: schedule.order_id, quantity: qty, end_time: prodEnd.toISOString() });

    const settings = db.prepare('SELECT * FROM settings WHERE id=1').get();
    const replanned = rescheduleMachine(schedule.machine_id, prodEnd, settings, schedule.start_time);
    const message = replanned.count > 0
      ? `工单已完工，按实际完工时间重新排了 ${replanned.count} 个后续任务`
      : '工单已完工，该设备没有需要重新排程的后续任务';
    io.emit('schedule_update', { message });
    res.json({ success: true, completed_at: completedAt, rescheduled_count: replanned.count, moved: replanned.moved, message });
  } catch (err) {
    console.error('完工处理出错:', err);
    res.status(500).json({ success: false, message: '服务器内部错误，请查看服务器日志' });
  }
});


// 完工记录修订：已完工订单允许修改实际生产结束时间；修改后自动重排同机台尚未开始的后续任务。
app.put('/api/schedules/:id/complete', requireEdit, (req, res) => {
  try {
    const id = req.params.id;
    const schedule = db.prepare(`
      SELECT s.*, o.order_number, o.status AS order_status
      FROM schedules s JOIN orders o ON o.id=s.order_id
      WHERE s.id=?
    `).get(id);
    if (!schedule) return res.status(404).json({ success:false, message:'排程不存在' });
    if (schedule.status !== 'completed') return res.status(409).json({ success:false, message:'该任务尚未完工，请使用正常完工确认' });

    const { mold_change_start, mold_change_end, start_time, end_time, planned_quantity } = req.body || {};
    const moldStart = new Date(mold_change_start || schedule.mold_change_start);
    const moldEnd = new Date(mold_change_end || schedule.mold_change_end);
    const prodStart = new Date(start_time || schedule.start_time);
    const prodEnd = new Date(end_time || schedule.end_time);
    const qty = planned_quantity !== undefined && planned_quantity !== '' ? Number(planned_quantity) : Number(schedule.planned_quantity);

    if (![moldStart,moldEnd,prodStart,prodEnd].every(d => Number.isFinite(d.getTime()))) {
      return res.status(400).json({success:false, message:'完工时间存在无效值'});
    }
    if (moldEnd < moldStart || prodStart < moldEnd || prodEnd < prodStart) {
      return res.status(400).json({success:false, message:'完工时间顺序不正确'});
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      return res.status(400).json({success:false, message:'完工数量必须大于 0'});
    }

    const before = {
      mold_change_start:schedule.mold_change_start,
      mold_change_end:schedule.mold_change_end,
      start_time:schedule.start_time,
      end_time:schedule.end_time,
      planned_quantity:schedule.planned_quantity
    };
    const settings = db.prepare('SELECT * FROM settings WHERE id=1').get();
    if (!settings) return res.status(500).json({success:false,message:'系统设置不存在'});

    const update = db.transaction(() => {
      db.prepare(`UPDATE schedules SET mold_change_start=?, mold_change_end=?, start_time=?, end_time=?, planned_quantity=?, completed_at=? WHERE id=?`)
        .run(moldStart.toISOString(), moldEnd.toISOString(), prodStart.toISOString(), prodEnd.toISOString(), qty, new Date().toISOString(), id);
    });
    update();

    let replanned = { count:0, moved:[] };
    try {
      replanned = rescheduleMachine(schedule.machine_id, prodEnd, settings, schedule.start_time);
    } catch (replanErr) {
      // 修改完工记录本身成功，但排程重算失败时立即返回明确告警，避免假装全部完成。
      recordScheduleChange(req, 'completion-revise-warning', `修订完工时间成功，但后续排程重算失败：${schedule.order_number}`, before, { end_time:prodEnd.toISOString(), replan_error:replanErr.message });
      audit(req, 'completion_revise', 'schedule', id, { before, after:{end_time:prodEnd.toISOString(), planned_quantity:qty}, replan_error:replanErr.message });
      io.emit('schedule_update', { message:`${schedule.order_number} 完工时间已修改，但后续任务未能自动重排，请检查设备排程` });
      return res.status(409).json({success:false, partial:true, message:`完工时间已修改，但后续排程重算失败：${replanErr.message}`});
    }

    const after = {
      mold_change_start:moldStart.toISOString(), mold_change_end:moldEnd.toISOString(),
      start_time:prodStart.toISOString(), end_time:prodEnd.toISOString(), planned_quantity:qty
    };
    recordScheduleChange(req, 'completion-revise', `修订已完工订单 ${schedule.order_number} 的实际完工时间`, before, after);
    audit(req, 'completion_revise', 'schedule', id, {order_id:schedule.order_id, before, after});
    const message = replanned.count
      ? `${schedule.order_number} 完工时间已调整，已按新的实际完工时间重排 ${replanned.count} 个后续任务`
      : `${schedule.order_number} 完工时间已调整，没有需要移动的后续任务`;
    io.emit('schedule_update', { message });
    res.json({success:true, message, rescheduled_count:replanned.count, moved:replanned.moved});
  } catch (err) {
    console.error('修订完工记录失败:', err.stack || err.message);
    res.status(500).json({success:false,message:'修订完工记录失败，请查看服务器日志'});
  }
});

function riskLevelForSchedule(schedule, order) {
  if (!schedule || schedule.status === 'completed') return { level:'done', label:'已完成', score:0 };
  const due = parseDueDate(order?.delivery_time);
  if (!due) return { level:'normal', label:'无交期风险', score:10 };
  const end = new Date(schedule.end_time);
  if (Number.isNaN(end.getTime())) return { level:'high', label:'时间数据异常', score:95 };
  const hours = (due.getTime() - end.getTime()) / 3600000;
  if (hours < 0) return { level:'critical', label:'已预计延期', score:100 };
  if (hours <= 4) return { level:'high', label:'4小时内到期', score:90 };
  if (hours <= 12) return { level:'medium', label:'12小时内到期', score:70 };
  if (hours <= 24) return { level:'low', label:'24小时内到期', score:45 };
  return { level:'normal', label:'正常', score:10 };
}


app.get('/api/schedule/v5-stats', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT s.*, o.order_number, o.delivery_time, o.priority, o.mold, o.process, o.quantity
      FROM schedules s JOIN orders o ON o.id=s.order_id
      WHERE s.status != 'completed'
      ORDER BY s.start_time
    `).all();
    const stats = rows.map(r => {
      const due = parseDueDate(r.delivery_time);
      const end = new Date(r.end_time);
      const slack = due && !Number.isNaN(end.getTime()) ? (due.getTime()-end.getTime())/3600000 : null;
      return {
        schedule_id:r.id, order_id:r.order_id, order_number:r.order_number,
        priority:Number(r.priority)||0, machine_id:r.machine_id, status:r.status,
        slack_hours: slack == null ? null : Number(slack.toFixed(1)),
        tardiness_hours: slack == null ? 0 : Number(Math.max(0,-slack).toFixed(1)),
        strategy: (Number(r.priority)>=80 || (slack!=null && slack<12)) ? '急单优先' : '综合优化'
      };
    });
    const urgent = stats.filter(x => x.strategy==='急单优先').length;
    res.json({success:true, algorithm:'V5-MultiObjective', total:stats.length, urgent_count:urgent, items:stats.slice(0,100)});
  } catch (err) {
    res.status(500).json({success:false,message:'读取 V5 排程统计失败'});
  }
});

app.get('/api/schedule/risk', requireAuth, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT s.*, o.order_number, o.product_code, o.product_name, o.delivery_time, o.priority,
             o.quantity, o.process, o.mold
      FROM schedules s JOIN orders o ON o.id=s.order_id
      WHERE s.status != 'completed'
      ORDER BY s.end_time
    `).all();
    const items = rows.map(s => {
      const risk = riskLevelForSchedule(s, s);
      const due = parseDueDate(s.delivery_time);
      const end = new Date(s.end_time);
      return {
        schedule_id:s.id, order_id:s.order_id, order_number:s.order_number,
        product_code:s.product_code, product_name:s.product_name,
        machine_id:s.machine_id, process:s.process, mold:s.mold,
        status:s.status, delivery_time:s.delivery_time, end_time:s.end_time,
        priority:Number(s.priority)||0, planned_quantity:Number(s.planned_quantity)||0,
        risk_level:risk.level, risk_label:risk.label, risk_score:risk.score,
        hours_to_due:due && !Number.isNaN(end.getTime()) ? Number(((due.getTime()-end.getTime())/3600000).toFixed(1)) : null
      };
    }).sort((a,b)=>b.risk_score-a.risk_score || (a.hours_to_due??9999)-(b.hours_to_due??9999));
    const counts = items.reduce((m,x)=>{m[x.risk_level]=(m[x.risk_level]||0)+1; return m;},{});
    res.json({success:true, generated_at:new Date().toISOString(), counts, items:items.slice(0,50)});
  } catch (err) {
    console.error('排程风险分析失败:', err.stack || err.message);
    res.status(500).json({success:false,message:'读取交期风险失败'});
  }
});

app.get('/api/schedule/changes', requireAuth, (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const rows = db.prepare(`
      SELECT c.*, u.username FROM schedule_changes c
      LEFT JOIN users u ON u.id=c.user_id
      ORDER BY c.created_at DESC LIMIT ?
    `).all(limit);
    res.json({success:true, changes:rows});
  } catch (err) {
    res.status(500).json({success:false,message:'读取排程变更历史失败'});
  }
});

app.get('/api/schedule/summary', requireAuth, (req, res) => {
  try {
    const schedules = db.prepare(`
      SELECT s.*, o.order_number, o.delivery_time, o.priority, o.process, o.mold
      FROM schedules s JOIN orders o ON o.id=s.order_id
      ORDER BY s.start_time
    `).all();
    const now = Date.now();
    const summary = schedules.map(s => {
      const end = new Date(s.end_time).getTime();
      const due = parseDueDate(s.delivery_time);
      return {
        id:s.id, machine_id:s.machine_id, order_id:s.order_id, order_number:s.order_number,
        priority:Number(s.priority)||0, delivery_time:s.delivery_time, end_time:s.end_time,
        status:s.status, late:s.status!=='completed' && due ? end > due.getTime() : false,
        hours_to_due:due ? (due.getTime()-end)/3600000 : null,
        starts_in_hours:(new Date(s.start_time).getTime()-now)/3600000
      };
    });
    const active = summary.filter(x => x.status==='scheduled');
    res.json({
      success:true, total:schedules.length, scheduled:active.length,
      late_count:active.filter(x=>x.late).length,
      utilization_window_hours:active.length ? Math.max(0,(Math.max(...active.map(x=>new Date(x.end_time).getTime()))-Math.min(...active.map(x=>new Date(x.start_time).getTime())))/3600000) : 0,
      items:summary
    });
  } catch (err) {
    res.status(500).json({success:false,message:'读取排程分析失败：'+err.message});
  }
});

// ================== 排程分析（设备负荷 / 瓶颈 / 交期风险） ==================
app.get('/api/schedule/analysis', requireAuth, (req, res) => {
  try {
    const settings = db.prepare('SELECT * FROM settings WHERE id=1').get() || {};
    const machines = db.prepare("SELECT * FROM machines WHERE status='active' ORDER BY name").all();
    const rows = db.prepare(`
      SELECT s.id, s.machine_id, s.order_id, s.start_time, s.end_time,
             s.mold_change_start, s.mold_change_end, s.status,
             o.order_number, o.delivery_time, o.priority, o.quantity
      FROM schedules s
      JOIN orders o ON o.id=s.order_id
      ORDER BY s.machine_id, s.start_time
    `).all();

    const parseHm = (v, fallback) => {
      const m = String(v || fallback).match(/^(\d{1,2}):(\d{2})$/);
      return m ? Number(m[1]) * 60 + Number(m[2]) : fallback === '20:00' ? 1200 : 480;
    };
    const workMinutes = Math.max(1, parseHm(settings.work_end, '20:00') - parseHm(settings.work_start, '08:00'));
    const now = Date.now();
    const activeRows = rows.filter(r => r.status !== 'completed');
    const late = activeRows.filter(r => {
      const due = parseDueDate(r.delivery_time);
      return due && new Date(r.end_time).getTime() > due.getTime();
    });

    const machineStats = machines.map(machine => {
      const items = rows.filter(r => r.machine_id === machine.id);
      const running = items.filter(r => r.status === 'running');
      const productionMinutes = items.reduce((sum, r) => {
        const a = new Date(r.start_time).getTime();
        const b = new Date(r.end_time).getTime();
        return sum + Math.max(0, b - a) / 60000;
      }, 0);
      const setupMinutes = items.reduce((sum, r) => {
        const a = new Date(r.mold_change_start || r.start_time).getTime();
        const b = new Date(r.mold_change_end || r.start_time).getTime();
        return sum + Math.max(0, b - a) / 60000;
      }, 0);
      const first = items.length ? new Date(items[0].mold_change_start || items[0].start_time).getTime() : now;
      const last = items.length ? Math.max(...items.map(r => new Date(r.end_time).getTime())) : now;
      const windowMinutes = Math.max(workMinutes, (last - first) / 60000);
      const utilization = Math.min(100, (productionMinutes / windowMinutes) * 100);
      const setupRate = windowMinutes ? (setupMinutes / windowMinutes) * 100 : 0;
      const lateCount = items.filter(r => {
        const due = parseDueDate(r.delivery_time);
        return r.status !== 'completed' && due && new Date(r.end_time).getTime() > due.getTime();
      }).length;
      return {
        machine_id: machine.id,
        machine_name: machine.name,
        machine_type: machine.machine_type,
        task_count: items.length,
        running_count: running.length,
        production_minutes: Math.round(productionMinutes),
        setup_minutes: Math.round(setupMinutes),
        utilization: Number(utilization.toFixed(1)),
        setup_rate: Number(setupRate.toFixed(1)),
        late_count: lateCount,
        bottleneck_score: Number((utilization + lateCount * 15 + setupRate * 0.5).toFixed(1))
      };
    });

    machineStats.sort((a, b) => b.bottleneck_score - a.bottleneck_score);
    const totalProduction = machineStats.reduce((s, x) => s + x.production_minutes, 0);
    const totalSetup = machineStats.reduce((s, x) => s + x.setup_minutes, 0);
    const averageUtilization = machineStats.length
      ? Number((machineStats.reduce((s, x) => s + x.utilization, 0) / machineStats.length).toFixed(1))
      : 0;

    res.json({
      success: true,
      generated_at: new Date().toISOString(),
      kpi: {
        total_orders: rows.length,
        open_orders: activeRows.length,
        running_orders: rows.filter(r => r.status === 'running').length,
        late_orders: late.length,
        total_setup_minutes: Math.round(totalSetup),
        total_production_minutes: Math.round(totalProduction),
        average_utilization: averageUtilization,
        bottleneck_machine: machineStats[0]?.machine_name || null
      },
      machines: machineStats
    });
  } catch (err) {
    console.error('排程分析失败:', err.stack || err.message);
    res.status(500).json({ success:false, message:'读取设备负荷分析失败' });
  }
});

// 清空排程
app.post('/api/schedules/clear', requireEdit, (req, res) => {
  const running = db.prepare("SELECT COUNT(*) AS cnt FROM schedules WHERE status='running'").get().cnt;
  if (running > 0) return res.status(409).json({ success:false, message:`当前有 ${running} 个开工任务，不能清空排程` });
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM schedules WHERE status='scheduled'").run();
    db.prepare("UPDATE orders SET status='pending' WHERE status='scheduled'").run();
  });
  tx();
  audit(req, 'clear', 'schedule', '', {});
  recordScheduleChange(req, 'clear', '清空未开工排程', {}, { cleared_scheduled: true });
  io.emit('schedule_update', { message: '未开工排程已清空，已完工任务和开工任务保留' });
  res.json({ success: true });
});

app.get('/api/schedules/export', requireAuth, (req, res) => {
  const schedules = db.prepare('SELECT * FROM schedules').all();
  const ws = XLSX.utils.json_to_sheet(schedules);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '排程');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=schedules.xlsx');
  res.send(buf);
});

app.get('/api/schedules', requireAuth, (req, res) => {
  const schedules = db.prepare('SELECT * FROM schedules ORDER BY start_time').all();
  res.json({ schedules });
});

// ================== 换模规则（APS） ==================
app.get('/api/setup-rules', requireAuth, (req, res) => {
  const rules = db.prepare('SELECT * FROM setup_rules ORDER BY from_family, to_family').all();
  res.json({ success:true, rules });
});

app.post('/api/setup-rules', requireEdit, (req, res) => {
  const from_family = String(req.body?.from_family || '').trim();
  const to_family = String(req.body?.to_family || '').trim();
  const minutes = Math.max(0, Number(req.body?.minutes) || 0);
  if (!from_family || !to_family) return res.json({success:false,message:'请填写前后刀模/产品族'});
  db.prepare(`
    INSERT INTO setup_rules (from_family,to_family,minutes) VALUES (?,?,?)
    ON CONFLICT(from_family,to_family) DO UPDATE SET minutes=excluded.minutes
  `).run(from_family, to_family, minutes);
  res.json({success:true});
});

app.delete('/api/setup-rules/:id', requireEdit, (req, res) => {
  db.prepare('DELETE FROM setup_rules WHERE id=?').run(req.params.id);
  res.json({success:true});
});

// ================== 设置 ==================
app.get('/api/settings', requireAuth, (req, res) => {
  const settings = db.prepare('SELECT * FROM settings WHERE id=1').get();
  res.json({ settings });
});

app.put('/api/settings', requireEdit, (req, res) => {
  const {
    work_start, work_end,
    break_lunch_start, break_lunch_end,
    break_dinner_start, break_dinner_end
  } = req.body || {};

  const values = [
    work_start, work_end,
    break_lunch_start, break_lunch_end,
    break_dinner_start, break_dinner_end
  ];

  if (values.some(v => !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || '')))) {
    return res.json({ success: false, message: '时间格式不正确，请使用 HH:mm' });
  }
  if (work_start >= work_end) {
    return res.json({ success: false, message: '上班时间必须早于下班时间' });
  }
  if (break_lunch_start >= break_lunch_end || break_dinner_start >= break_dinner_end) {
    return res.json({ success: false, message: '休息时间设置不正确' });
  }
  if (break_lunch_start < work_start || break_lunch_end > work_end ||
      break_dinner_start < work_start || break_dinner_end > work_end) {
    return res.json({ success: false, message: '休息时间必须位于工作时段内' });
  }
  if (!(break_lunch_end <= break_dinner_start || break_dinner_end <= break_lunch_start)) {
    return res.json({ success: false, message: '午休和晚休时间不能重叠' });
  }

  db.prepare('UPDATE settings SET work_start=?, work_end=?, break_lunch_start=?, break_lunch_end=?, break_dinner_start=?, break_dinner_end=? WHERE id=1')
    .run(work_start, work_end, break_lunch_start, break_lunch_end, break_dinner_start, break_dinner_end);
  audit(req, 'update', 'settings', 1, { work_start, work_end, break_lunch_start, break_lunch_end, break_dinner_start, break_dinner_end });
  io.emit('schedule_update', { message: '工作时间设置已更新' });
  res.json({ success: true });
});

// Socket.IO
io.use((socket, next) => {
  const sessionId = socket.request.headers.cookie || '';
  // Socket.IO 连接仅用于实时刷新；真正的写操作仍通过受保护的 HTTP API。
  if (!sessionId) return next(new Error('unauthorized'));
  next();
});
io.on('connection', (socket) => {
  socket.on('schedule_changed', (data) => {
    io.emit('schedule_update', {
      message: String(data?.message || '排程已更新').slice(0, 200)
    });
  });
});

// 全局错误处理
app.use((err, req, res, next) => {
  console.error('全局错误:', err.stack);
  res.status(500).json({ success: false, message: '服务器内部错误，请查看服务器日志' });
});

app.get('/api/schedule/precheck', requireAuth, (req,res)=>{
  try {
    const settings = db.prepare('SELECT * FROM settings WHERE id=1').get();
    const orders = db.prepare("SELECT * FROM orders WHERE status IN ('pending','scheduled','running')").all();
    const machines = db.prepare("SELECT * FROM machines WHERE status='active'").all();
    const products = db.prepare('SELECT * FROM product_data').all();
    const issues = [];
    if (!settings) issues.push('系统设置不存在');
    if (!machines.length) issues.push('没有启用的设备');
    let noCapacity=0, noProcess=0, noMold=0, noQty=0;
    for (const o of orders) {
      if (!(Number(o.quantity)>0)) noQty++;
      if (!o.process) noProcess++;
      if (!o.mold) noMold++;
      if (!(Number(o.capacity)>0)) noCapacity++;
    }
    if (noQty) issues.push(`有 ${noQty} 单数量无效`);
    if (noProcess) issues.push(`有 ${noProcess} 单未填写设备`);
    if (noMold) issues.push(`有 ${noMold} 单未填写刀模`);
    res.json({success:true, ready:issues.length===0, issues, counts:{orders:orders.length,machines:machines.length,products:products.length,noCapacity,noProcess,noMold,noQty}});
  } catch(err){
    console.error('排程预检失败:',err.stack||err.message);
    res.status(500).json({success:false,message:'排程预检失败：'+err.message});
  }
});

app.get('/api/health', (req, res) => {
  try {
    const check = db.prepare('SELECT 1 AS ok').get();
    res.json({ ok: check?.ok === 1, service: 'diecut-schedule', time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ ok: false });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ 服务器已启动，访问地址: http://localhost:${PORT}`);
});