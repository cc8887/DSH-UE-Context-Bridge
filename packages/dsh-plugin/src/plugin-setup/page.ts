/**
 * Setup page. Rendered on the server so the first paint already shows the
 * install button, the engine, and the blocker. Script only posts the action
 * the user clicked; loading the page never installs.
 */

import type { SetupView } from './service.ts';

export function renderPage(view: SetupView, token: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GeneralBlueprint 初始化</title>
<style>
  :root { color-scheme: dark; --bg:#14181c; --panel:#1e252b; --ink:#e7e1d5; --muted:#a39886; --line:#3a342b; --amber:#e0a045; --green:#8fbf7f; --red:#e07a68; --blue:#8eb4c8; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.45 "Segoe UI", "Source Han Sans SC", "Noto Sans SC", sans-serif; }
  header { padding:28px 32px 8px; display:flex; justify-content:space-between; gap:24px; align-items:flex-end; }
  h1 { font-size:28px; font-weight:650; margin:0; letter-spacing:-0.03em; }
  h1 span { color:var(--amber); }
  .lede { color:var(--muted); margin:8px 0 0; max-width:46rem; }
  main { padding:12px 32px 48px; display:grid; grid-template-columns:minmax(0,1.4fr) minmax(280px,.8fr); gap:18px; }
  section { background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:18px 18px 16px; }
  h2 { margin:0 0 12px; font-size:15px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
  dl { display:grid; grid-template-columns:8.5rem 1fr; gap:6px 10px; margin:0; }
  dt { color:var(--muted); }
  dd { margin:0; overflow-wrap:anywhere; font-variant-numeric:tabular-nums; }
  .status { display:inline-block; padding:2px 8px; border-radius:999px; background:#2a241c; color:var(--amber); }
  .status.match { background:#1d2a1d; color:var(--green); }
  .status.bad { background:#2c1c1a; color:var(--red); }
  button, .ghost { font:inherit; border-radius:10px; border:1px solid var(--line); background:#2a3138; color:var(--ink); padding:10px 14px; cursor:pointer; }
  button.primary { background:var(--amber); color:#1b1408; border-color:#9a6a22; font-weight:650; }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .row { display:flex; flex-wrap:wrap; gap:8px; margin-top:14px; }
  label.chk { display:flex; gap:8px; align-items:flex-start; margin-top:10px; color:var(--muted); }
  pre { white-space:pre-wrap; background:#12171b; border-radius:10px; padding:10px; max-height:220px; overflow:auto; color:var(--blue); }
  ol.steps { list-style:none; padding:0; margin:0; }
  ol.steps li { padding:6px 0; border-top:1px solid var(--line); }
  ol.steps li:first-child { border-top:0; }
  .pending { color:var(--muted); } .active { color:var(--amber); } .done { color:var(--green); } .error { color:var(--red); } .skipped { color:#6d675e; }
  .modal { position:fixed; inset:0; background:rgba(8,10,12,.72); display:flex; align-items:center; justify-content:center; padding:24px; }
  .modal article { width:min(560px,100%); background:#242017; border:1px solid #6d542c; border-radius:16px; padding:22px; box-shadow:0 24px 80px rgba(0,0,0,.45); }
  .modal h3 { margin:0 0 8px; font-size:22px; }
  .errorbox { color:var(--red); margin-top:10px; }
  @media (max-width:900px) { main { grid-template-columns:1fr; padding:12px; } header { padding:20px 12px 8px; } }
</style>
</head>
<body>
<header>
  <div>
    <h1>初始化 <span>GeneralBlueprint</span></h1>
    <p class="lede">打开这个页面不会下载或编译。只有按下安装按钮才会写入磁盘。来源只限 github.com/cc8887/GeneralBlueprint 的发布包，或固定提交 ${escapeText(view.plan.sourceCommit)}。</p>
  </div>
</header>
<main id="app">${renderPanel(view)}</main>
<script>
const token = ${JSON.stringify(token)};
async function api(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ue-bridge-token': token }, body: JSON.stringify(body || {}) });
  const text = await res.text();
  if (!res.ok) throw new Error(text || res.statusText);
  return text;
}
async function refresh() {
  const res = await fetch('/api/panel', { headers: { 'x-ue-bridge-token': token } });
  const app = document.getElementById('app');
  app.innerHTML = await res.text();
  const flag = app.querySelector('[data-live-flag]');
  document.body.dataset.live = flag ? flag.getAttribute('data-live-flag') : '0';
}
document.body.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  const root = document.getElementById('app');
  const read = (id) => document.getElementById(id);
  try {
    if (action === 'set-project') await api('/api/project', { projectRoot: read('project-root').value });
    else if (action === 'select-engine') await api('/api/engine', { choice: button.dataset.choice });
    else if (action === 'choose-kind') await api('/api/kind', { kind: button.dataset.kind });
    else if (action === 'dismiss') await api('/api/dismiss', {});
    else if (action === 'cancel') await api('/api/cancel', {});
    else if (action === 'install') {
      const replace = Boolean((read('replace') && read('replace').checked) || (read('modal-replace') && read('modal-replace').checked));
      const unverified = Boolean((read('unverified') && read('unverified').checked) || (read('modal-unverified') && read('modal-unverified').checked));
      const engineWrite = Boolean(read('engine-write') && read('engine-write').checked);
      if (button.dataset.needsReplace === 'true' && !replace) throw new Error('覆盖已有插件之前需要勾选确认。');
      if (button.dataset.needsUnverified === 'true' && !unverified) throw new Error('BuildId 未能核对，需要勾选确认才会安装。');
      await api('/api/install', { target: button.dataset.target || 'project', replace, allowUnverifiedBuildId: unverified, confirmEngineWrite: button.dataset.target === 'engine' ? engineWrite : false });
    }
    await refresh();
  } catch (error) {
    const box = document.getElementById('action-error');
    if (box) box.textContent = error instanceof Error ? error.message : String(error);
  }
});
setInterval(() => { if (document.body.dataset.live === '1') refresh(); }, 800);
</script>
</body>
</html>`;
}

export function renderPanel(view: SetupView): string {
  const status = view.installed.status;
  const statusClass = status === 'match' ? 'match' : status === 'missing' || status === 'staged' ? '' : 'bad';
  const live = view.job?.phase === 'running' ? '1' : '0';
  const needsReplace = view.form.needsReplace ? 'true' : 'false';
  const needsUnverified = view.form.needsUnverifiedConfirm ? 'true' : 'false';
  const installDisabled = !view.form.canInstall;
  return `<div data-live-flag="${live}">
<section>
  <h2>当前判断</h2>
  <dl>
    <dt>项目</dt><dd>${view.projectRoot ? escapeText(view.projectRoot) : projectField()}</dd>
    <dt>安装状态</dt><dd><span class="status ${statusClass}">${escapeText(statusLabel(status))}</span> ${escapeText(view.installed.detail)}</dd>
    <dt>引擎</dt><dd>${view.engine?.root ? escapeText(view.engine.root) : '未确定'}${view.engine?.version ? ` · ${escapeText(view.engine.version)}` : ''}</dd>
    <dt>如何确定</dt><dd>${view.engine ? escapeText(view.engine.resolution) : '—'}${view.engine?.decided ? '' : ' · 还不能安装'}</dd>
    <dt>检测类型</dt><dd>${view.engine ? escapeText(kindLabel(view.engine.detectedKind)) : '—'}，采用 ${view.engine?.effectiveKind ? escapeText(kindLabel(view.engine.effectiveKind)) : '尚未选择'}</dd>
    <dt>信号</dt><dd>${view.engine?.signals.length ? escapeText(view.engine.signals.join('；')) : '—'}</dd>
    <dt>Changelist</dt><dd>${view.engine?.changelist ?? '—'} / CompatibleChangelist ${view.engine?.compatibleChangelist ?? '—'}（这两项不是 BuildId）</dd>
    <dt>发布包</dt><dd>${view.plan.assetName ? `${escapeText(view.plan.assetTag ?? '')} / ${escapeText(view.plan.assetName)} · ${escapeText(view.plan.match ?? '')}` : '不使用发布包'}</dd>
    <dt>SHA-256</dt><dd>${view.plan.sha256 ? `${escapeText(view.plan.sha256)}（${escapeText(view.plan.sha256From ?? '')}）` : '—'}</dd>
    <dt>源码</dt><dd>${escapeText(view.plan.sourceTag)} · ${escapeText(view.plan.sourceCommit)}<br>${escapeText(view.plan.sourceRepo)}</dd>
    <dt>项目目标</dt><dd>${view.plan.targetDir ? escapeText(view.plan.targetDir) : '—'}</dd>
    <dt>引擎目标</dt><dd>${view.plan.engineTargetDir ? escapeText(view.plan.engineTargetDir) : '—'}</dd>
    <dt>BuildId</dt><dd>${buildIdLine(view)}</dd>
  </dl>
  <p>${escapeText(view.plan.reason)}</p>
  ${view.form.blockReason ? `<p class="errorbox" id="block-reason">${escapeText(view.form.blockReason)}</p>` : ''}
  ${engineChoices(view)}
  ${kindChoices(view)}
  ${view.form.needsReplace ? '<label class="chk"><input id="replace" type="checkbox"> 覆盖已有插件。原目录会先复制到安装器的备份目录，不留在 Plugins 里以免被引擎当成另一个插件。</label>' : ''}
  ${view.form.needsUnverifiedConfirm ? '<label class="chk"><input id="unverified" type="checkbox"> 引擎没有 UnrealEditor.modules，无法核对 BuildId。我仍要安装这个发布包。</label>' : ''}
  <div class="row">
    <button class="primary" id="install-project" data-action="install" data-target="project" data-needs-replace="${needsReplace}" data-needs-unverified="${needsUnverified}" ${installDisabled ? 'disabled' : ''}>${escapeText(view.form.installLabel)}</button>
    ${view.job?.phase === 'running' ? '<button id="cancel-install" data-action="cancel">取消</button>' : ''}
    ${view.job?.phase === 'failed' ? '<button id="retry-install" data-action="install" data-target="project" data-needs-replace="' + needsReplace + '" data-needs-unverified="' + needsUnverified + '">重试</button>' : ''}
  </div>
  <details>
    <summary>安装到引擎目录（默认不会走这里）</summary>
    <p>这会写入上面的引擎目标。初始化不会静默写引擎树。目录不可写时会停在权限错误。</p>
    <label class="chk"><input id="engine-write" type="checkbox"> 我确认写入引擎目录，而不是项目 Plugins。</label>
    <div class="row"><button id="install-engine" data-action="install" data-target="engine" data-needs-replace="${needsReplace}" data-needs-unverified="${needsUnverified}" ${installDisabled ? 'disabled' : ''}>安装到引擎目录</button></div>
  </details>
  <p class="errorbox" id="action-error">${view.job?.error ? escapeText(view.job.error) : ''}</p>
</section>
<section>
  <h2>步骤</h2>
  <ol class="steps" id="steps">${(view.job?.steps ?? []).map((step) => `<li class="${step.state}" id="step-${escapeText(step.id)}"><strong>${escapeText(step.label)}</strong> ${escapeText(step.state)}${step.detail ? ` — ${escapeText(step.detail)}` : ''}</li>`).join('') || '<li class="pending">还没有开始。</li>'}</ol>
  <h2>日志</h2>
  <pre id="log">${escapeText((view.job?.logTail ?? []).join('\n'))}</pre>
  ${view.job?.backupPath ? `<p>备份：${escapeText(view.job.backupPath)}</p>` : ''}
</section>
</div>
${view.prompt.show ? modal(view, installDisabled, needsReplace, needsUnverified) : ''}
<script>document.body.dataset.live=${JSON.stringify(live)};</script>`;
}

function modal(view: SetupView, installDisabled: boolean, needsReplace: string, needsUnverified: string): string {
  return `<div class="modal" id="setup-modal" role="dialog" aria-modal="true" aria-labelledby="setup-title">
<article>
  <h3 id="setup-title">${escapeText(view.prompt.title)}</h3>
  <p>${escapeText(view.prompt.reason)}</p>
  <p>目标目录：${view.plan.targetDir ? escapeText(view.plan.targetDir) : '尚未确定'}</p>
  ${!view.engine?.decided ? engineChoices(view, 'modal-engine') : ''}
  ${view.engine?.decided && !view.engine.effectiveKind ? kindChoices(view, 'modal-') : ''}
  ${view.form.needsReplace ? '<label class="chk"><input id="modal-replace" type="checkbox"> 覆盖已有插件</label>' : ''}
  ${view.form.needsUnverifiedConfirm ? '<label class="chk"><input id="modal-unverified" type="checkbox"> 无法核对 BuildId，仍要安装</label>' : ''}
  <div class="row">
    <button class="primary" id="modal-install" data-action="install" data-target="project" data-needs-replace="${needsReplace}" data-needs-unverified="${needsUnverified}" ${installDisabled ? 'disabled' : ''}>${escapeText(view.form.installLabel)}</button>
    <button class="ghost" id="modal-dismiss" data-action="dismiss" type="button">稍后</button>
  </div>
</article>
</div>`;
}

function projectField(): string {
  return '<input id="project-root" placeholder="项目根目录，内含 .uproject" style="width:min(100%,28rem);padding:8px;border-radius:8px;border:1px solid var(--line);background:#12171b;color:inherit"> <button data-action="set-project" id="set-project" type="button">使用这个项目</button>';
}

function engineChoices(view: SetupView, idPrefix = 'engine'): string {
  if (!view.engine || view.engine.decided || view.engine.options.length === 0) return '';
  return `<div class="row">${view.engine.options
    .map(
      (option) =>
        `<button type="button" data-action="select-engine" data-choice="${escapeText(option.identifier)}" id="${idPrefix}-${escapeText(option.identifier)}">${escapeText(option.identifier)}${option.version ? ` · ${escapeText(option.version)}` : ''}</button>`,
    )
    .join('')}</div>`;
}

function kindChoices(view: SetupView, idPrefix = ''): string {
  if (!view.engine?.decided) return '';
  return `<div class="row">
    <button type="button" id="${idPrefix}choose-launcher" data-action="choose-kind" data-kind="launcher">这是公版 / Launcher 引擎</button>
    <button type="button" id="${idPrefix}choose-source" data-action="choose-kind" data-kind="source">这是源码引擎</button>
  </div>`;
}

function buildIdLine(view: SetupView): string {
  if (view.installed.pluginBuildId || view.installed.engineBuildId) {
    return escapeText(`插件 ${view.installed.pluginBuildId ?? '—'}，编辑器 ${view.installed.engineBuildId ?? '—'}`);
  }
  return escapeText(view.plan.buildIdNote ?? view.plan.buildIdStatus ?? '尚未对照');
}

function statusLabel(status: SetupView['installed']['status']): string {
  switch (status) {
    case 'match':
      return '已安装';
    case 'missing':
      return '未安装';
    case 'mismatch':
      return '版本不匹配';
    case 'user-owned':
      return '已有插件，未由安装器记录';
    case 'staged':
      return '源码已就位，未编译完成';
    default:
      return status;
  }
}

function kindLabel(kind: string): string {
  if (kind === 'launcher') return '公版';
  if (kind === 'source') return '源码版';
  if (kind === 'ambiguous') return '无法判断';
  return kind;
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
