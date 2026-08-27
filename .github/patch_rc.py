from pathlib import Path

# Patch the committed runtime page directly. The previous helper copied a root index.html,
# but the verified branch now keeps the runtime page at public/index.html.
p = Path('public/index.html')
if not p.exists():
    raise SystemExit('public/index.html not found')
s = p.read_text(encoding='utf-8')

# 1) Add second-level navigation beneath the APS schedule menu.
old_nav = '''      <a class="nav-link" data-page="schedule" onclick="navigateTo('schedule')"><i class="bi bi-calendar-week"></i> 排产看板（V5 APS）</a>\n      <a class="nav-link" data-page="machines"'''
new_nav = '''      <a class="nav-link" data-page="schedule" onclick="navigateTo('schedule')"><i class="bi bi-calendar-week"></i> 排产看板（V5 APS）</a>\n      <div class="schedule-subnav" id="scheduleSubnav">\n        <a class="schedule-subnav-link" data-workflow-stage="shortage" onclick="switchWorkflowStageFromSidebar('shortage')"><i class="bi bi-exclamation-triangle"></i><span>欠料</span></a>\n        <a class="schedule-subnav-link" data-workflow-stage="available_to_issue" onclick="switchWorkflowStageFromSidebar('available_to_issue')"><i class="bi bi-box-seam"></i><span>有料待发</span></a>\n        <a class="schedule-subnav-link" data-workflow-stage="waiting_schedule" onclick="switchWorkflowStageFromSidebar('waiting_schedule')"><i class="bi bi-hourglass-split"></i><span>车间待排</span></a>\n        <a class="schedule-subnav-link" data-workflow-stage="in_process" onclick="switchWorkflowStageFromSidebar('in_process')"><i class="bi bi-gear-wide-connected"></i><span>车间在制</span></a>\n      </div>\n      <a class="nav-link" data-page="machines"'''
if old_nav not in s:
    raise SystemExit('schedule nav anchor not found')
s = s.replace(old_nav, new_nav, 1)

# 2) Add styles for a true second-level navigation.
old_css = '.nav-link.active { background: rgba(26,115,232,0.25); color: #6db3ff; }\n'
new_css = old_css + '''    .schedule-subnav { margin: 2px 12px 8px 42px; padding-left: 10px; border-left: 1px solid rgba(255,255,255,0.12); }\n    .schedule-subnav-link { color: #8f98a8; padding: 8px 10px; border-radius: 8px; display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; margin: 2px 0; transition: all .2s; }\n    .schedule-subnav-link:hover { background: rgba(255,255,255,0.05); color: #fff; }\n    .schedule-subnav-link.active { background: rgba(26,115,232,0.22); color: #6db3ff; }\n    .schedule-subnav-link i { width: 15px; text-align: center; }\n'''
if old_css not in s:
    raise SystemExit('nav css anchor not found')
s = s.replace(old_css, new_css, 1)

# 3) Replace the six-button workflow row with only the local Gantt/List controls.
old_tabs = '''    function workflowTabsHtml(){\n      const tabs=[['shortage','欠料'],['available_to_issue','有料待发'],['waiting_schedule','车间待排'],['in_process','车间在制'],['gantt','甘特图'],['list','列表视图']];\n      return `<div class="workflow-tabs">${tabs.map(([k,t])=>`<div class="workflow-tab ${((k==='gantt'||k==='list')?currentSubTab===k:currentSubTab==='workflow'&&currentWorkflowStage===k)?'active':''}" onclick="${k==='gantt'||k==='list'?`switchSubTab('${k}')`:`switchWorkflowStage('${k}')`}">${t}</div>`).join('')}</div>`;\n    }'''
new_tabs = '''    function workflowTabsHtml(){\n      const tabs=[['gantt','甘特图'],['list','列表视图']];\n      return `<div class="workflow-tabs">${tabs.map(([k,t])=>`<div class="workflow-tab ${currentSubTab===k?'active':''}" onclick="switchSubTab('${k}')">${t}</div>`).join('')}</div>`;\n    }'''
if old_tabs not in s:
    raise SystemExit('workflow tabs function not found')
s = s.replace(old_tabs, new_tabs, 1)

# 4) Make sidebar state follow the current page/stage.
old_nav_fn = '''    function navigateTo(page, silent=false) {\n      currentPage = page;\n      document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));\n      document.querySelector(`[data-page="${page}"]`)?.classList.add('active');\n      const titleMap = {dashboard:'仪表盘',orders:'订单管理',schedule:'排产看板',machines:'设备管理',products:'产品数据',users:'用户管理',settings:'系统设置'};\n      document.getElementById('pageTitle').textContent = titleMap[page] || '';\n      if(!silent) showLoading();\n      closeSidebar();\n      switch(page) {\n        case 'dashboard': loadDashboard(); break;\n        case 'orders': loadOrders(); break;\n        case 'schedule': loadSchedule(); break;\n        case 'machines': loadMachines(); break;\n        case 'products': loadProducts(); break;\n        case 'users': loadUsers(); break;\n        case 'settings': loadSettings(); break;\n      }\n    }'''
new_nav_fn = '''    function updateScheduleSidebar() {\n      const sub = document.getElementById('scheduleSubnav');\n      if (!sub) return;\n      sub.style.display = currentPage === 'schedule' ? 'block' : 'none';\n      sub.querySelectorAll('.schedule-subnav-link').forEach(el => {\n        el.classList.toggle('active', currentSubTab === 'workflow' && el.dataset.workflowStage === currentWorkflowStage);\n      });\n    }\n\n    function switchWorkflowStageFromSidebar(stage) {\n      if (currentPage !== 'schedule') currentPage = 'schedule';\n      currentSubTab = 'workflow';\n      currentWorkflowStage = stage;\n      navigateTo('schedule', true);\n    }\n\n    function navigateTo(page, silent=false) {\n      currentPage = page;\n      document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));\n      document.querySelector(`[data-page="${page}"]`)?.classList.add('active');\n      const titleMap = {dashboard:'仪表盘',orders:'订单管理',schedule:'排产看板',machines:'设备管理',products:'产品数据',users:'用户管理',settings:'系统设置'};\n      document.getElementById('pageTitle').textContent = titleMap[page] || '';\n      updateScheduleSidebar();\n      if(!silent) showLoading();\n      closeSidebar();\n      switch(page) {\n        case 'dashboard': loadDashboard(); break;\n        case 'orders': loadOrders(); break;\n        case 'schedule': loadSchedule(); break;\n        case 'machines': loadMachines(); break;\n        case 'products': loadProducts(); break;\n        case 'users': loadUsers(); break;\n        case 'settings': loadSettings(); break;\n      }\n    }'''
if old_nav_fn not in s:
    raise SystemExit('navigateTo function not found')
s = s.replace(old_nav_fn, new_nav_fn, 1)

# 5) Keep active state synchronized after workflow switching.
old_switch = '''    function switchSubTab(sub) {\n      currentSubTab = sub;\n      if(sub==='gantt'||sub==='list') currentWorkflowStage=null;\n      renderScheduleView();\n    }'''
new_switch = '''    function switchSubTab(sub) {\n      currentSubTab = sub;\n      if(sub==='gantt'||sub==='list') currentWorkflowStage=null;\n      updateScheduleSidebar();\n      renderScheduleView();\n    }'''
if old_switch not in s:
    raise SystemExit('switchSubTab function not found')
s = s.replace(old_switch, new_switch, 1)

old_stage = '''    function switchWorkflowStage(stage){ currentWorkflowStage=stage; currentSubTab='workflow'; loadWorkflowData(stage); }'''
new_stage = '''    function switchWorkflowStage(stage){ currentWorkflowStage=stage; currentSubTab='workflow'; updateScheduleSidebar(); loadWorkflowData(stage); }'''
if old_stage not in s:
    raise SystemExit('switchWorkflowStage function not found')
s = s.replace(old_stage, new_stage, 1)

# 6) Add a current-stage label to the board header so the user always knows which board is open.
old_header = '''      c.innerHTML=`<div class="card-custom"><div class="card-header d-flex justify-content-between align-items-center"><div>${workflowTabsHtml()}${latest}</div><div>${importBtn} ${currentUser.role!=='viewer'?`<button class="btn btn-sm btn-outline-success ms-1" onclick="runAutoSchedule()">对待排工单排程</button>`:''}</div></div><div class="card-body">'''
new_header = '''      const stageTitle = workflowStageLabel(stage);\n      c.innerHTML=`<div class="card-custom"><div class="card-header d-flex justify-content-between align-items-center"><div class="d-flex align-items-center gap-2"><span class="fw-semibold">${escapeHtml(stageTitle)}</span>${workflowTabsHtml()}${latest}</div><div>${importBtn} ${currentUser.role!=='viewer'?`<button class="btn btn-sm btn-outline-success ms-1" onclick="runAutoSchedule()">对待排工单排程</button>`:''}</div></div><div class="card-body">'''
if old_header not in s:
    raise SystemExit('workflow board header anchor not found')
s = s.replace(old_header, new_header, 1)

# 7) Regression markers for CI.
checks = [
    ('排产二级导航', 'id="scheduleSubnav"'),
    ('欠料二级菜单', 'data-workflow-stage="shortage"'),
    ('有料待发二级菜单', 'data-workflow-stage="available_to_issue"'),
    ('车间待排二级菜单', 'data-workflow-stage="waiting_schedule"'),
    ('车间在制二级菜单', 'data-workflow-stage="in_process"'),
    ('侧边栏切换函数', 'switchWorkflowStageFromSidebar')
]
for label, marker in checks:
    if marker not in s:
        raise SystemExit(f'missing UI marker: {label}')

p.write_text(s, encoding='utf-8')
print('patched public/index.html with schedule second-level navigation')