  // ===================== LLM 配置管理 =====================
  const cfgApi = {
    list: () => fetch('/api/llm-configs').then(r => { if (!r.ok) throw new Error('读取失败'); return r.json(); }),
    save: (data) => {
      const id = data.id;
      const body = JSON.stringify(data);
      return fetch(id ? `/api/llm-configs/${id}` : '/api/llm-configs', {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }).then(async r => {
        if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || '保存失败'); }
        return r.json();
      });
    },
    del: (id) => fetch(`/api/llm-configs/${id}`, { method: 'DELETE' }).then(r => { if (!r.ok) throw new Error('删除失败'); return r.json(); }),
    toggle: (id) => fetch(`/api/llm-configs/${id}/toggle`, { method: 'POST' }).then(r => r.json()),
    setDefault: (id) => fetch(`/api/llm-configs/${id}/default`, { method: 'POST' }).then(async r => {
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || '设置失败'); }
      return r.json();
    }),
    test: (id) => fetch(`/api/llm-configs/${id}/test`, { method: 'POST' }).then(async r => {
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.detail || '测试失败'); }
      return r.json();
    }),
  };

  const cfgMask = document.getElementById('cfg-mask');
  const cfgTbody = document.getElementById('cfg-tbody');
  const cfgPager = document.getElementById('cfg-pager');
  const cfgForm = document.getElementById('cfg-form');
  const cfgFormMsg = document.getElementById('cfg-form-msg');

  let cfgList = [];
  let cfgPage = 1;
  let cfgTab = 'llm';
  let editingId = null;
  const CFG_PAGE_SIZE = 8;

  function cfgVal(id) { return document.getElementById(id).value.trim(); }
  function cfgChk(id) { return document.getElementById(id).checked; }

  function openCfg() { cfgMask.classList.add('show'); loadCfg(); }
  function closeCfg() { cfgMask.classList.remove('show'); }

  async function loadCfg() {
    try { cfgList = await cfgApi.list(); } catch (e) { cfgList = []; }
    cfgPage = 1;
    renderCfgTable();
  }

  function maskKey(k) {
    if (!k) return '—';
    if (k.includes('*')) return k;         // 后端已脱敏
    return k.length > 8 ? k.slice(0, 4) + '****' + k.slice(-4) : '****';
  }

  function renderCfgTable() {
    const kw = (document.getElementById('cfg-search').value || '').trim().toLowerCase();
    let rows = cfgList.filter(c => !kw || (c.name || '').toLowerCase().includes(kw) || (c.model || '').toLowerCase().includes(kw));
    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / CFG_PAGE_SIZE));
    if (cfgPage > pages) cfgPage = pages;
    const start = (cfgPage - 1) * CFG_PAGE_SIZE;
    const pageRows = rows.slice(start, start + CFG_PAGE_SIZE);

    document.getElementById('cnt-llm').textContent = cfgList.length ? `(${cfgList.length})` : '';

    if (!pageRows.length) {
      cfgTbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:28px;">暂无配置，点击「+ 新增配置」创建。</td></tr>`;
    } else {
      cfgTbody.innerHTML = pageRows.map(c => `
        <tr>
          <td class="model">${escapeHtml(c.name || '未命名')}</td>
          <td>${escapeHtml(c.provider || '自定义')}</td>
          <td>${escapeHtml(c.model || '—')}</td>
          <td class="key" title="${escapeHtml(c.api_key || '')}">${escapeHtml(maskKey(c.api_key))}</td>
          <td class="temp">${c.temperature ?? 0.7}</td>
          <td>${c.thinking ? '开启' : '关闭'}</td>
          <td>${c.is_default ? '<span class="tag">默认</span>' : `<button class="ops-btn" onclick="makeDefault('${c.id}')">设为默认</button>`}</td>
          <td><label class="sw"><input type="checkbox" ${c.enabled ? 'checked' : ''} onchange="toggleCfg('${c.id}')" /><span class="sl"></span></label></td>
          <td>
            <div class="cfg-ops">
              <button class="ops-btn" id="test-${c.id}" onclick="testCfg('${c.id}')">连通性测试</button>
              <button class="ops-btn" onclick="openForm(${JSON.stringify(c).replace(/"/g,'&quot;')})">编辑</button>
              <button class="ops-btn danger" onclick="delCfg('${c.id}')">删除</button>
            </div>
          </td>
        </tr>`).join('');
    }

    // 分页
    let pager = '';
    if (pages > 1) {
      pager = `<button ${cfgPage === 1 ? 'disabled' : ''} onclick="gotoPage(${cfgPage - 1})">‹</button>`;
      for (let p = 1; p <= pages; p++) {
        pager += `<button class="${p === cfgPage ? 'cur' : ''}" onclick="gotoPage(${p})">${p}</button>`;
      }
      pager += `<button ${cfgPage === pages ? 'disabled' : ''} onclick="gotoPage(${cfgPage + 1})">›</button>`;
    }
    cfgPager.innerHTML = pager ? `${pager}<span>共 ${total} 项</span>` : '';
  }

  function gotoPage(p) { cfgPage = p; renderCfgTable(); }

  async function toggleCfg(id) {
    try {
      const c = await cfgApi.toggle(id);
      const i = cfgList.findIndex(x => x.id === id);
      if (i >= 0) cfgList[i] = { ...cfgList[i], enabled: c.enabled, is_default: c.is_default };
      renderCfgTable();
    } catch (e) { alert('操作失败: ' + e.message); loadCfg(); }
  }

  async function makeDefault(id) {
    try {
      await cfgApi.setDefault(id);
      cfgList = cfgList.map(c => ({ ...c, is_default: c.id === id }));
      renderCfgTable();
    } catch (e) { alert(e.message); }
  }

  async function delCfg(id) {
    if (!confirm('确认删除该配置？')) return;
    try { await cfgApi.del(id); loadCfg(); } catch (e) { alert('删除失败: ' + e.message); }
  }

  async function testCfg(id) {
    const btn = document.getElementById('test-' + id);
    const oldText = btn ? btn.textContent : '连通性测试';
    if (btn) { btn.disabled = true; btn.textContent = '测试中…'; }
    try {
      const r = await cfgApi.test(id);
      if (r.ok) {
        alert('✅ 连通性测试成功\n模型: ' + r.model + '\n耗时: ' + r.latency_ms + ' ms\n响应: ' + (r.sample || '—'));
      } else {
        alert('❌ 连通性测试失败 (' + r.latency_ms + ' ms)\n模型: ' + r.model + '\n错误: ' + (r.error || '未知'));
      }
    } catch (e) {
      alert('测试发起失败: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
    }
  }

  function openForm(item) {
    editingId = item && item.id ? item.id : null;
    cfgFormMsg.textContent = '';
    document.getElementById('cfg-form-title').textContent = editingId ? '编辑配置' : '新增配置';
    document.getElementById('f-name').value = item ? (item.name || '') : '';
    document.getElementById('f-provider').value = item ? (item.provider || 'OpenAI') : 'OpenAI';
    document.getElementById('f-model').value = item ? (item.model || '') : '';
    document.getElementById('f-akey').value = item ? (item.api_key || '') : '';
    document.getElementById('f-akey').placeholder = item ? '留空则保留原 Key' : 'sk-...';
    document.getElementById('f-base').value = item ? (item.base_url || '') : '';
    document.getElementById('f-thinking').value = item ? (item.thinking ? 'on' : 'off') : 'off';
    document.getElementById('f-temp').value = item ? (item.temperature ?? 0.7) : 0.7;
    document.getElementById('f-maxtokens').value = item ? (item.max_tokens ?? 8192) : 8192;
    document.getElementById('f-timeout').value = item ? (item.timeout ?? 60) : 60;
    document.getElementById('f-default').checked = item ? !!item.is_default : false;
    document.getElementById('f-enabled').checked = item ? item.enabled !== false : true;
    cfgForm.classList.add('show');
    document.getElementById('f-name').focus();
  }
  function closeForm() { cfgForm.classList.remove('show'); }

  async function saveForm() {
    const name = cfgVal('f-name');
    const model = cfgVal('f-model');
    if (!name) { cfgFormMsg.textContent = '请填写配置名称'; return; }
    if (!model) { cfgFormMsg.textContent = '请填写模型名称'; return; }
    const apiKey = cfgVal('f-akey');
    if (!editingId && !apiKey) { cfgFormMsg.textContent = '请填写 API Key'; return; }
    const data = {
      id: editingId,
      name,
      provider: cfgVal('f-provider'),
      model,
      api_key: apiKey,
      base_url: cfgVal('f-base'),
      thinking: document.getElementById('f-thinking').value === 'on',
      temperature: parseFloat(cfgVal('f-temp')) || 0.7,
      max_tokens: parseInt(cfgVal('f-maxtokens')) || 8192,
      timeout: parseInt(cfgVal('f-timeout')) || 60,
      is_default: cfgChk('f-default'),
      enabled: cfgChk('f-enabled'),
    };
    try {
      await cfgApi.save(data);
      closeForm();
      await loadCfg();
    } catch (e) {
      cfgFormMsg.textContent = e.message;
    }
  }

  // Tab 切换（仅 LLM 实现，其余为占位提示）
  document.querySelectorAll('.cfg-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.cfg-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      cfgTab = tab.dataset.tab;
      if (cfgTab !== 'llm') {
        cfgTbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:28px;">「${tab.textContent.replace(/\s*\(\d+\)$/, '')}」功能规划中，敬请期待。</td></tr>`;
        cfgPager.innerHTML = '';
      } else {
        renderCfgTable();
      }
    });
  });

  // Esc 关闭
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeForm(); } });

  // (已改为固定三列布局：左=会话列表 / 中=对话 / 右=执行观测，移除左右分栏与浮窗拖拽)

  // 浏览器前进/后退：按 URL 同步当前会话
  window.addEventListener('popstate', () => {
    const sid = sidFromUrl();
    if (sid && sid !== sessionId) openSession(sid);
  });
