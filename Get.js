// ==UserScript==
// @name         正方教务抢课助手
// @namespace    http://tampermonkey.net/
// @version      1.1.0
// @description  正方教务系统自动选课辅助脚本，支持课程精准识别、自动选课、弹窗处理
// @author       You
// @grant        none
// @run-at       document-end
注意 本项目仅供学习研究使用
// ==/UserScript==

(function () {
  'use strict';

  // 配置项
  const CONFIG = {
    queryInterval: 3500,     // 基础轮询间隔(ms)
    randomDelay: true,       // 启用随机延时波动(±500ms)，降低风控概率
    stepDelay: 900,          // 单步操作延时
    afterEnrollWait: 1600,   // 选课点击后等待弹窗时间
    onlyChaoxing: false,     // 仅抢名称含"超星"的课程
    chaoxingFirst: true,     // 超星课程优先处理
    retryFailed: true,       // 失败课程下一轮继续重试
    autoConfirmSuccess: true,// 自动确认选课成功弹窗
    autoCollapse: true,      // 操作完成后自动收起课程面板
  };

  // 运行状态
  const state = {
    running: false,
    paused: false,
    loop: 0,
    stat: { ok: 0, fail: 0, skip: 0 },
    successSet: new Set(),  // 已成功课程，不再重复操作
    triedSet: new Set()     // 本轮已尝试课程
  };

  // 工具函数
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const $ = selector => document.querySelector(selector);
  const $$ = selector => document.querySelectorAll(selector);
  const now = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const cleanText = str => (str || '').replace(/\s+/g, '');
  const truncate = text => cleanText(text).slice(0, 60);

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getRandomInterval() {
    const base = CONFIG.queryInterval;
    if (!CONFIG.randomDelay) return base;
    return Math.max(800, base + Math.floor(Math.random() * 1000) - 500);
  }

  async function nap(ms) {
    const endTime = Date.now() + (ms || getRandomInterval());
    while (Date.now() < endTime) {
      if (!state.running) return;
      await sleep(200);
    }
  }

  // 日志系统
  const LOG_MAX = 300;
  function log(type, msg) {
    console.log(`[选课-${type}]`, msg);

    const listEl = document.getElementById(`lg-${type}`);
    if (!listEl) return;

    const item = document.createElement('li');
    item.innerHTML = `<i>${now()}</i>${msg}`;
    listEl.prepend(item);

    while (listEl.children.length > LOG_MAX) {
      listEl.lastChild.remove();
    }
  }

  // 弹窗识别与自动处理
  function getModalRoot(el) {
    let node = el;
    // 类名匹配弹窗容器
    while (node && node !== document.body) {
      const cls = typeof node.className === 'string' ? node.className : '';
      if (/modal|dialog|layer|pop|tip|alert|messager/i.test(cls) && isVisible(node)) {
        return node;
      }
      node = node.parentElement;
    }
    // 兜底：匹配固定定位元素
    node = el;
    while (node && node !== document.body) {
      if (getComputedStyle(node).position === 'fixed') return node;
      node = node.parentElement;
    }
    return el;
  }

  function clickButton(container, btnText) {
    const buttons = container.querySelectorAll('button, a, input[type="button"], input[type="submit"], [class*="btn"]');
    for (const btn of buttons) {
      const text = cleanText(btn.value || btn.textContent);
      if (text === btnText && isVisible(btn)) {
        btn.click();
        return true;
      }
    }
    return false;
  }

  function getCurrentModal() {
    const xpath = '//*[contains(text(),"警告提示") or contains(text(),"提示") or contains(text(),"成功")]';
    const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    
    for (let i = 0; i < result.snapshotLength; i++) {
      const modal = getModalRoot(result.snapshotItem(i));
      if (modal && isVisible(modal) && modal.textContent) {
        return { element: modal, text: modal.textContent };
      }
    }
    return null;
  }

  function handleModal() {
    const xpath = '//*[contains(text(),"警告提示") or contains(text(),"选课成功") or contains(text(),"成功") or contains(text(),"提示")]';
    const result = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);

    for (let i = 0; i < result.snapshotLength; i++) {
      const modal = getModalRoot(result.snapshotItem(i));
      if (!modal || !isVisible(modal)) continue;

      const text = modal.textContent || '';

      // 退选类弹窗自动取消，防止误操作
      if (/退选|取消选课|删除/.test(text)) {
        if (clickButton(modal, '取消')) log('sys', '检测到退选弹窗，已自动取消');
        continue;
      }

      // 警告/提示弹窗自动确认
      if (/警告提示|提示/.test(text)) {
        if (clickButton(modal, '确定')) log('sys', '检测到提示弹窗，已自动确认');
        continue;
      }

      // 成功弹窗自动确认
      if (CONFIG.autoConfirmSuccess && /成功/.test(text) && text.length < 120) {
        if (clickButton(modal, '确定')) log('sys', '检测到成功提示，已自动确认');
      }
    }
  }

  // 弹窗监控：DOM变化监听 + 定时轮询双保险
  const observer = new MutationObserver(() => handleModal());
  observer.observe(document.body, { childList: true, subtree: true });
  setInterval(handleModal, 600);

  // 核心：课程解析（基于DOM结构精准提取）
  function parseCourses() {
    const courseMap = new Map();
    const panels = $$('.tjxk_list .panel.panel-info');
    if (!panels.length) return [];

    for (const panel of panels) {
      // 从隐藏input获取课程ID，准确率最高
      const codeInput = panel.querySelector('input[name="kch_id"]');
      if (!codeInput) continue;
      const courseCode = codeInput.value.trim();
      if (courseMap.has(courseCode)) continue;

      // 标题文本与基础信息提取
      const titleEl = panel.querySelector('.panel-heading .panel-title');
      const titleText = titleEl ? titleEl.textContent : '';

      const creditMatch = titleText.match(/(\d+(?:\.\d+)?)\s*学分/);
      const credit = creditMatch ? creditMatch[1] : '0';

      let courseName = titleText
        .replace(/\(\d+\)/, '')
        .replace(/\d+(?:\.\d+)?\s*学分/, '')
        .replace(/状态[:：].*$/, '')
        .replace(/^[\s\-–—]+/, '')
        .trim();

      // 选课状态：优先通过专属ID获取，兜底从标题提取
      let status = '';
      const statusEl = document.getElementById(`zt_txt_${courseCode}`);
      if (statusEl) {
        status = statusEl.textContent.replace(/状态[:：]\s*/, '').trim();
      } else {
        const statusMatch = titleText.match(/状态[:：]\s*([^\s,，。]{1,8})/);
        status = statusMatch ? statusMatch[1].trim() : '';
      }

      const isChaoxing = titleText.includes('超星') || courseName.includes('超星');

      // DOM元素引用
      const heading = panel.querySelector('.panel-heading');
      const expandBtn = panel.querySelector('.expand_close');

      courseMap.set(courseCode, {
        code: courseCode,
        name: courseName,
        credit: credit,
        status: status,
        chaoxing: isChaoxing,
        panel: panel,
        heading: heading,
        clickTarget: expandBtn || heading
      });
    }

    return [...courseMap.values()];
  }

  function refreshStatus(course) {
    const statusEl = document.getElementById(`zt_txt_${course.code}`);
    if (statusEl) {
      return statusEl.textContent.replace(/状态[:：]\s*/, '').trim();
    }
    return '';
  }

  // 按钮查找与课程展开
  function findQueryButton() {
    const buttons = $$('button, a, input[type="button"], input[type="submit"], [class*="btn"]');
    for (const btn of buttons) {
      if (cleanText(btn.value || btn.textContent) === '查询' && isVisible(btn)) {
        return btn;
      }
    }
    return null;
  }

  function getCourseButtons(course) {
    const buttons = [];
    if (!course.panel) return buttons;

    course.panel.querySelectorAll('a, button, [role="button"], input[type="button"], input[type="submit"]').forEach(btn => {
      const text = cleanText(btn.value || btn.textContent);
      if (text !== '选课' && text !== '退选') return;
      if (!isVisible(btn)) return;
      buttons.push({ type: text, element: btn });
    });

    return buttons;
  }

  async function expandCourse(course) {
    if (getCourseButtons(course).length) return true;
    
    try { course.clickTarget.click(); } catch (e) {}
    await sleep(CONFIG.stepDelay);
    
    return getCourseButtons(course).length > 0;
  }

  function collapseCourse(course) {
    if (!CONFIG.autoCollapse) return;
    try { course.clickTarget.click(); } catch (e) {}
  }

  // 单门课选课流程
  async function enrollCourse(course) {
    log('run', `处理: (${course.code})${course.name} | 学分:${course.credit} | 状态:${course.status || '未知'}`);

    // 已选课程直接跳过
    if (course.status.includes('已选') || state.successSet.has(course.code)) {
      state.stat.skip++;
      log('sys', `跳过【${course.name}】：已选`);
      return;
    }

    // 展开课程详情
    if (!(await expandCourse(course))) {
      state.stat.fail++;
      log('fail', `【${course.name}】展开失败`);
      return;
    }

    const buttons = getCourseButtons(course);
    const enrollBtn = buttons.find(b => b.type === '选课');
    const dropBtn = buttons.find(b => b.type === '退选');

    // 存在退选按钮则判定为已选
    if (dropBtn && !enrollBtn) {
      state.stat.skip++;
      log('sys', `跳过【${course.name}】：已选`);
      collapseCourse(course);
      return;
    }

    if (!enrollBtn) {
      state.stat.fail++;
      log('fail', `【${course.name}】未找到选课按钮`);
      collapseCourse(course);
      return;
    }

    // 点击前二次校验按钮文本
    const btnText = cleanText(enrollBtn.element.textContent || enrollBtn.element.value);
    if (btnText !== '选课') {
      log('sys', `按钮文本异常，跳过【${course.name}】`);
      return;
    }

    log('run', `点击选课: ${course.name}`);
    enrollBtn.element.click();
    await sleep(CONFIG.afterEnrollWait);

    // 选课结果判定
    const modal = getCurrentModal();
    if (modal) {
      const text = modal.text;
      if (/警告/.test(text)) {
        state.stat.fail++;
        log('fail', `【${course.name}】${truncate(text)}`);
      } else if (/成功/.test(text)) {
        state.stat.ok++;
        state.successSet.add(course.code);
        log('ok', `选课成功: ${course.name} (${course.code}) ${course.credit}学分`);
      } else {
        state.stat.fail++;
        log('fail', `【${course.name}】${truncate(text)}`);
      }
      handleModal();
    } else {
      const newStatus = refreshStatus(course);
      if (newStatus.includes('已选')) {
        state.stat.ok++;
        state.successSet.add(course.code);
        log('ok', `选课成功: ${course.name} (${course.code}) ${course.credit}学分`);
      } else {
        state.stat.fail++;
        log('fail', `【${course.name}】无反馈，按失败处理`);
      }
    }

    collapseCourse(course);
  }

  // 主循环
  async function mainLoop() {
    log('sys', '选课主循环已启动');

    while (state.running) {
      while (state.paused && state.running) await sleep(300);
      if (!state.running) break;

      state.loop++;
      state.triedSet.clear();
      updateStats();

      log('run', `===== 第 ${state.loop} 轮 =====`);

      try {
        const queryBtn = findQueryButton();
        if (!queryBtn) {
          log('fail', '未找到查询按钮，请确认在选课页面');
          await nap(4000);
          continue;
        }
        queryBtn.click();

        // 等待课程列表加载
        let courses = [];
        for (let i = 0; i < 3 && state.running; i++) {
          await nap(1500);
          courses = parseCourses();
          if (courses.length) break;
          
          log('run', `第${i+1}次未识别到课程，重试查询`);
          const retryBtn = findQueryButton();
          if (retryBtn) retryBtn.click();
        }

        if (!courses.length) {
          log('fail', '未能识别到课程列表，进入下一轮');
          await nap();
          continue;
        }

        log('run', `识别到 ${courses.length} 门课程`);

        // 过滤与排序
        let targetList = courses.filter(c => !c.status.includes('已选') && !state.successSet.has(c.code));
        
        if (CONFIG.onlyChaoxing) {
          targetList = targetList.filter(c => c.chaoxing);
        } else if (CONFIG.chaoxingFirst) {
          targetList.sort((a, b) => (b.chaoxing ? 1 : 0) - (a.chaoxing ? 1 : 0));
        }

        if (!CONFIG.retryFailed) {
          targetList = targetList.filter(c => !state.triedSet.has(c.code));
        }

        if (!targetList.length) {
          log('run', '无待选课程，进入下一轮');
          await nap();
          continue;
        }

        // 依次处理
        for (const course of targetList) {
          if (!state.running) break;
          while (state.paused && state.running) await sleep(300);
          if (!state.running) break;
          if (state.triedSet.has(course.code)) continue;

          state.triedSet.add(course.code);
          await enrollCourse(course);
          updateStats();
          await sleep(CONFIG.stepDelay);
        }

        log('run', '本轮处理完成');

      } catch (e) {
        log('sys', `运行异常: ${e.message}`);
      }

      await nap();
    }

    log('sys', '主循环已停止');
  }

  function updateStats() {
    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };
    setText('zf-loop', state.loop);
    setText('zf-ok', state.stat.ok);
    setText('zf-bad', state.stat.fail);
    setText('zf-skip', state.stat.skip);
  }

  // 构建控制面板UI
  function buildUI() {
    const css = `
#zf-panel{position:fixed;top:70px;right:18px;width:430px;z-index:99999;font:12px/1.5 "Microsoft YaHei",sans-serif;
  background:rgba(15,23,42,.94);color:#cbd5e1;border:1px solid #334155;border-radius:12px;
  box-shadow:0 8px 32px rgba(0,0,0,.45);backdrop-filter:blur(8px);user-select:none}
#zf-head{display:flex;align-items:center;justify-content:space-between;padding:9px 12px;cursor:move;
  background:linear-gradient(90deg,#1d4ed8,#0ea5e9);color:#fff;border-radius:11px 11px 0 0;font-weight:700;font-size:13px}
#zf-min{cursor:pointer;padding:0 7px;border-radius:5px;background:rgba(255,255,255,.2)}
#zf-body{padding:10px 12px 12px}
.zf-row{display:flex;gap:8px;margin-bottom:8px}
.zf-btn{flex:1;padding:7px 0;border:none;border-radius:7px;background:#334155;color:#e2e8f0;cursor:pointer;font-weight:600}
.zf-btn:disabled{opacity:.4;cursor:not-allowed}
.zf-btn.go{background:#16a34a}.zf-btn.warn{background:#d97706}.zf-btn.danger{background:#dc2626}
.zf-stats{display:flex;gap:6px;margin-bottom:8px}
.zf-stats span{flex:1;text-align:center;background:#1e293b;border-radius:6px;padding:4px 0}
.zf-stats b{font-size:14px}.g{color:#4ade80}.r{color:#f87171}.y{color:#fbbf24}
.zf-cfg{display:flex;flex-wrap:wrap;gap:4px 10px;background:#1e293b;border-radius:6px;padding:6px 8px;margin-bottom:8px}
.zf-cfg label{cursor:pointer;display:flex;align-items:center;gap:3px}
.zf-cfg input[type=number]{width:56px;background:#0f172a;color:#e2e8f0;border:1px solid #334155;border-radius:4px;padding:1px 4px}
.zf-tabs{display:flex;gap:2px;border-bottom:1px solid #334155}
.zf-tab{padding:5px 10px;cursor:pointer;border-radius:6px 6px 0 0;color:#94a3b8}
.zf-tab.on{background:#1e293b;color:#fff;font-weight:700}
.zf-tab i{font-style:normal;background:#334155;border-radius:8px;padding:0 5px;font-size:10px}
.zf-logs{position:relative;height:240px}
.zf-logs ul{display:none;position:absolute;inset:0;overflow-y:auto;margin:0;padding:6px;list-style:none;
  background:#0b1220;border-radius:0 0 8px 8px;font-family:Consolas,monospace;font-size:11px}
.zf-logs ul.on{display:block}
.zf-logs li{padding:2px 4px;border-bottom:1px solid #1e293b;word-break:break-all}
.zf-logs li i{font-style:normal;color:#64748b;margin-right:6px}
#lg-fail li{color:#f87171}#lg-run li{color:#93c5fd}#lg-sys li{color:#fbbf24}
.zf-logs::-webkit-scrollbar{width:6px}.zf-logs::-webkit-scrollbar-thumb{background:#334155;border-radius:3px}`;

    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = 'zf-panel';
    panel.innerHTML = `
<div id="zf-head"><span>正方抢课助手</span><span id="zf-min">—</span></div>
<div id="zf-body">
  <div class="zf-row">
    <button class="zf-btn go" id="zf-start">开始</button>
    <button class="zf-btn warn" id="zf-pause" disabled>暂停</button>
    <button class="zf-btn danger" id="zf-stop" disabled>停止</button>
  </div>
  <div class="zf-stats">
    <span>循环 <b id="zf-loop">0</b></span>
    <span class="g">成功 <b id="zf-ok">0</b></span>
    <span class="r">失败 <b id="zf-bad">0</b></span>
    <span class="y">跳过 <b id="zf-skip">0</b></span>
  </div>
  <div class="zf-cfg">
    <label><input type="checkbox" id="c-onlycx"> 仅抢超星课</label>
    <label><input type="checkbox" id="c-cxfirst" checked> 超星优先</label>
    <label><input type="checkbox" id="c-retry" checked> 失败重试</label>
    <label>间隔<input type="number" id="c-int" value="${CONFIG.queryInterval}" step="100" min="800">ms</label>
  </div>
  <div class="zf-tabs">
    <div class="zf-tab on" data-t="run">运行</div>
    <div class="zf-tab" data-t="fail">失败 <i id="b-fail">0</i></div>
    <div class="zf-tab" data-t="sys">系统</div>
  </div>
  <div class="zf-logs">
    <ul id="lg-run" class="on"></ul>
    <ul id="lg-fail"></ul>
    <ul id="lg-sys"></ul>
  </div>
</div>`;
    document.body.appendChild(panel);

    // 按钮事件
    $('#zf-start').onclick = () => {
      if (state.running) return;
      state.running = true;
      state.paused = false;
      $('#zf-start').disabled = true;
      $('#zf-pause').disabled = false;
      $('#zf-stop').disabled = false;
      log('sys', '已启动，弹窗监控同步生效');
      mainLoop();
    };

    $('#zf-pause').onclick = () => {
      if (!state.running) return;
      state.paused = !state.paused;
      $('#zf-pause').textContent = state.paused ? '继续' : '暂停';
      log('sys', state.paused ? '已暂停' : '已继续');
    };

    $('#zf-stop').onclick = () => {
      state.running = false;
      state.paused = false;
      $('#zf-start').disabled = false;
      $('#zf-pause').disabled = true;
      $('#zf-stop').disabled = true;
      $('#zf-pause').textContent = '暂停';
    };

    // 配置项绑定
    $('#c-onlycx').onchange = e => CONFIG.onlyChaoxing = e.target.checked;
    $('#c-cxfirst').onchange = e => CONFIG.chaoxingFirst = e.target.checked;
    $('#c-retry').onchange = e => CONFIG.retryFailed = e.target.checked;
    $('#c-int').onchange = e => CONFIG.queryInterval = Math.max(800, +e.target.value || 3500);

    // 日志标签切换
    $$('.zf-tab').forEach(tab => {
      tab.onclick = () => {
        $$('.zf-tab').forEach(t => t.classList.remove('on'));
        $$('.zf-logs ul').forEach(u => u.classList.remove('on'));
        tab.classList.add('on');
        document.getElementById(`lg-${tab.dataset.t}`).classList.add('on');
      };
    });

    // 最小化
    $('#zf-min').onclick = () => {
      const body = $('#zf-body');
      const hide = body.style.display !== 'none';
      body.style.display = hide ? 'none' : 'block';
      $('#zf-min').textContent = hide ? '□' : '—';
    };

    // 面板拖动
    const head = $('#zf-head');
    head.onmousedown = e => {
      if (e.target.id === 'zf-min') return;
      const rect = panel.getBoundingClientRect();
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;
      panel.style.right = 'auto';
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';

      const move = ev => {
        panel.style.left = (ev.clientX - offsetX) + 'px';
        panel.style.top = (ev.clientY - offsetY) + 'px';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    };

    log('sys', '面板加载完成，请在自主选课页面使用');
  }

  // 初始化与防重复注入
  if (window.__courseGrabber__) {
    window.__courseGrabber__.destroy?.();
  }

  window.__courseGrabber__ = {
    destroy: () => {
      observer.disconnect();
      const panel = document.getElementById('zf-panel');
      if (panel) panel.remove();
      state.running = false;
    }
  };

  // 页面卸载时清理资源
  window.addEventListener('beforeunload', () => {
    observer.disconnect();
  });

  buildUI();
})();
