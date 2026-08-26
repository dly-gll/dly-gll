from pathlib import Path

p = Path('server.js')
s = p.read_text(encoding='utf-8')

old = '''ensureColumn('workflow_snapshots', 'shipping_required_date', 'TEXT');
ensureColumn('workflow_snapshots', 'delivery_date', 'TEXT');
ensureColumn('workflow_snapshots', 'expected_ready_date', 'TEXT');
ensureColumn('workflow_snapshots', 'expected_issue_date', 'TEXT');
ensureColumn('workflow_snapshots', 'expected_start_date', 'TEXT');
ensureColumn('workflow_snapshots', 'expected_finish_date', 'TEXT');
ensureColumn('workflow_snapshots', 'production_progress', 'TEXT');
ensureColumn('workflow_snapshots', 'material_status', 'TEXT');
ensureColumn('workflow_snapshots', 'shortage_detail', 'TEXT');


// V5.1 生产四板块/每日快照
'''

s2 = s.replace(old, '\n\n// V5.1 生产四板块/每日快照\n', 1)
if s2 == s:
    raise SystemExit('fresh-db source block not found')

anchor = '''  CREATE TABLE IF NOT EXISTS workflow_daily_kpi (
    kpi_date TEXT NOT NULL,
    stage TEXT NOT NULL,
    expected_count INTEGER DEFAULT 0,
    actual_count INTEGER DEFAULT 0,
    rate REAL DEFAULT 0,
    alert_count INTEGER DEFAULT 0,
    notes TEXT,
    PRIMARY KEY(kpi_date, stage)
  );
`);

function hashPassword'''

insert = '''  CREATE TABLE IF NOT EXISTS workflow_daily_kpi (
    kpi_date TEXT NOT NULL,
    stage TEXT NOT NULL,
    expected_count INTEGER DEFAULT 0,
    actual_count INTEGER DEFAULT 0,
    rate REAL DEFAULT 0,
    alert_count INTEGER DEFAULT 0,
    notes TEXT,
    PRIMARY KEY(kpi_date, stage)
  );
`);

// workflow_snapshots 表创建完成后再补充兼容字段。
ensureColumn('workflow_snapshots', 'shipping_required_date', 'TEXT');
ensureColumn('workflow_snapshots', 'delivery_date', 'TEXT');
ensureColumn('workflow_snapshots', 'expected_ready_date', 'TEXT');
ensureColumn('workflow_snapshots', 'expected_issue_date', 'TEXT');
ensureColumn('workflow_snapshots', 'expected_start_date', 'TEXT');
ensureColumn('workflow_snapshots', 'expected_finish_date', 'TEXT');
ensureColumn('workflow_snapshots', 'production_progress', 'TEXT');
ensureColumn('workflow_snapshots', 'material_status', 'TEXT');
ensureColumn('workflow_snapshots', 'shortage_detail', 'TEXT');

function hashPassword'''

if anchor not in s2:
    raise SystemExit('workflow ddl anchor not found')

s2 = s2.replace(anchor, insert, 1)
p.write_text(s2, encoding='utf-8')
Path('public').mkdir(exist_ok=True)
Path('public/index.html').write_text(Path('index.html').read_text(encoding='utf-8'), encoding='utf-8')
print('patched server.js and created public/index.html')
