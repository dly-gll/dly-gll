from pathlib import Path

# The RC branch keeps the runtime page at public/index.html. The patch is intentionally
# idempotent so an already-patched checkout is only verified, not patched a second time.
page = Path('public/index.html')
if not page.exists():
    raise SystemExit('public/index.html not found')

html = page.read_text(encoding='utf-8')
required_ui = {
    '排产二级导航': 'id="scheduleSubnav"',
    '欠料二级菜单': 'data-workflow-stage="shortage"',
    '有料待发二级菜单': 'data-workflow-stage="available_to_issue"',
    '车间待排二级菜单': 'data-workflow-stage="waiting_schedule"',
    '车间在制二级菜单': 'data-workflow-stage="in_process"',
    '侧边栏切换函数': 'switchWorkflowStageFromSidebar',
    '侧边栏更新函数': 'updateScheduleSidebar',
}
missing = [name for name, marker in required_ui.items() if marker not in html]

if missing:
    # Recover from the pre-navigation page only when the target markers are absent.
    old_nav = '''      <a class="nav-link" data-page="schedule" onclick="navigateTo('schedule')"><i class="bi bi-calendar-week"></i> 排产看板（V5 APS）</a>\n      <a class="nav-link" data-page="machines"'''
    new_nav = '''      <a class="nav-link" data-page="schedule" onclick="navigateTo('schedule')"><i class="bi bi-calendar-week"></i> 排产看板（V5 APS）</a>\n      <div class="schedule-subnav" id="scheduleSubnav">\n        <a class="schedule-subnav-link" data-workflow-stage="shortage" onclick="switchWorkflowStageFromSidebar('shortage')"><i class="bi bi-exclamation-triangle"></i><span>欠料</span></a>\n        <a class="schedule-subnav-link" data-workflow-stage="available_to_issue" onclick="switchWorkflowStageFromSidebar('available_to_issue')"><i class="bi bi-box-seam"></i><span>有料待发</span></a>\n        <a class="schedule-subnav-link" data-workflow-stage="waiting_schedule" onclick="switchWorkflowStageFromSidebar('waiting_schedule')"><i class="bi bi-hourglass-split"></i><span>车间待排</span></a>\n        <a class="schedule-subnav-link" data-workflow-stage="in_process" onclick="switchWorkflowStageFromSidebar('in_process')"><i class="bi bi-gear-wide-connected"></i><span>车间在制</span></a>\n      </div>\n      <a class="nav-link" data-page="machines"'''
    if old_nav not in html:
        raise SystemExit('schedule sidebar navigation is missing and no legacy anchor is available')
    html = html.replace(old_nav, new_nav, 1)
    page.write_text(html, encoding='utf-8')
    missing = [name for name, marker in required_ui.items() if marker not in html]
    if missing:
        raise SystemExit('UI patch incomplete: ' + ', '.join(missing))

# Keep the known-good DB initialization fix in the source used by CI.
server = Path('server.js')
s = server.read_text(encoding='utf-8')
# The verified server already creates workflow_snapshots before adding its optional columns.
needle = 'CREATE TABLE IF NOT EXISTS workflow_snapshots ('
anchor = "ensureColumn('workflow_snapshots', 'shipping_required_date', 'TEXT');"
if needle not in s:
    raise SystemExit('workflow_snapshots DDL missing from server.js')
if anchor not in s:
    # No migration block means a future source has diverged; fail closed rather than silently ship it.
    raise SystemExit('workflow_snapshots compatibility migration missing from server.js')

print('RC source verified: public/index.html sidebar navigation markers present; server migration markers present')