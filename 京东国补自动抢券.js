// ==UserScript==
// @name         JD 自动领取国家补贴（iframe + ShadowDOM + 绿色按钮识别 + 0.2s 重试）
// @namespace    https://example.com/
// @version      2.0
// @description  在国家补贴弹窗（含跨域 iframe/Shadow DOM）中每 2 秒自动尝试点击“立即领取”绿色按钮；Ctrl+Shift+L 开关；带调试输出与候选导出。
// @match        https://item.jd.com/*
// @match        https://*.jd.com/*
// @match        https://*.wqs.jd.com/*
// @match        https://*.wq.jd.com/*
// @match        https://*.sgm-static.jd.com/*
// @match        https://*.360buyimg.com/*
// @match        https://*.360buying.com/*
// @grant        none
// @run-at       document-idle
// @all-frames   true
// ==/UserScript==

(function () {
  'use strict';

  /******** 可调参数 ********/
  let enabled     = true;      // 默认启用（Ctrl+Shift+L 切换）
  const interval  = 100;      // 每 2s 重试
  const wantTexts = ['去领取'];    //列表中可输入多种匹配的文本
  const hostOk    = /(^|\.)jd\.com$|360buy(img|ing)?\.com$|sgm-static\.jd\.com$|wqs\.jd\.com$|wq\.jd\.com$/i;
  if (!hostOk.test(location.hostname)) return;

  let lastClickTs = 0;

  /******** 工具 ********/
  const isVisible = (el) => {
    if (!el) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || +s.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const isGreenish = (el) => {
    try {
      const s = getComputedStyle(el);
      const bg = s.backgroundColor || '';
      // rgb(a) 解析
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (!m) return false;
      const r = +m[1], g = +m[2], b = +m[3];
      // “偏绿且明显不是灰/黑/白” 的启发式
      return g > 120 && g > r + 20 && g > b + 20;
    } catch { return false; }
  };

  const textMatches = (txt) => {
    if (!txt) return false;
    const s = String(txt).replace(/\s+/g,'');
    return wantTexts.some(t => s.includes(t.replace(/\s+/g,'')));
  };

  // 深度选择（穿透 Shadow DOM）
  function deepCollect(root=document) {
    const out = [];
    const pushNode = (node) => {
      if (!(node instanceof Element)) return;
      out.push(node);
      // 遍历 Shadow DOM
      if (node.shadowRoot) {
        for (const c of node.shadowRoot.querySelectorAll('*')) out.push(c);
      }
    };

    // 常见可点击元素先收集
    const priSel = 'button,a,[role="button"],input[type="button"],input[type="submit"],[class*="btn"],[class*="button"],[class*="领取"]';
    for (const el of root.querySelectorAll(priSel)) pushNode(el);

    // 兜底：所有元素（避免漏掉包着文字的 div/span）
    for (const el of root.querySelectorAll('div,span')) pushNode(el);

    return out;
  }

  // 返回一批“最可能是领取”的候选（含评分，便于调试）
  function collectCandidates(root=document) {
    const nodes = deepCollect(root);
    const items = [];
    for (const el of nodes) {
      try {
        const txt = (el.innerText || el.value || el.title || el.getAttribute('aria-label') || '').trim();
        const cls = (el.className || '').toString();
        const role = el.getAttribute && el.getAttribute('role');

        // 基于文本/外观/类名/可见性打分
        let score = 0;
        if (textMatches(txt)) score += 5;
        if (/\bbtn|button|领取|green|primary/i.test(cls)) score += 2;
        if (role === 'button') score += 2;
        if (isGreenish(el)) score += 3;
        if (!isVisible(el)) score -= 4;

        if (score >= 3) {
          items.push({ el, score, txt, cls, bg: getComputedStyle(el).backgroundColor });
        }
      } catch {}
    }

    // 分数高的排前
    items.sort((a,b)=>b.score-a.score);
    return items;
  }

  function closestClickable(el) {
    let n = el;
    while (n && n !== document.body) {
      const role = n.getAttribute && n.getAttribute('role');
      if (n.tagName === 'BUTTON' || n.tagName === 'A' || role === 'button') return n;
      if (n.onclick || /\bbtn|button|领取/.test(n.className || '')) return n;
      n = n.parentElement;
    }
    return el;
  }

  function tryClick(el) {
    if (!enabled || !el) return false;
    const now = Date.now();
    if (now - lastClickTs < interval - 50) return false;
    lastClickTs = now;

    try {
      const target = closestClickable(el);
      target.scrollIntoView({ behavior: 'instant', block: 'center' });
      target.focus({ preventScroll: true });

      ['pointerdown','mousedown','click','mouseup'].forEach(type => {
        target.dispatchEvent(new MouseEvent(type, { bubbles:true, cancelable:true, view:window }));
      });

      console.log('[JD-领取] 点击成功 =>', { text: target.innerText?.trim(), cls: target.className, host: location.hostname });
      return true;
    } catch (e) {
      try { el.click(); console.log('[JD-领取] fallback click'); return true; }
      catch (err) { console.warn('[JD-领取] 点击失败', err); return false; }
    }
  }

  function scanAndClick() {
    // 优先在“国家补贴/补助/guobu/subsidy/弹窗”容器内找
    const containerSel = [
      '[id*="guobu"]','[id*="subsidy"]','[class*="补贴"]','[class*="补助"]',
      '[class*="dialog"]','[class*="popup"]','[class*="modal"]','[class*="drawer"]'
    ].join(',');
    let scopes = Array.from(document.querySelectorAll(containerSel));
    if (scopes.length === 0) scopes = [document];

    for (const scope of scopes) {
      const cands = collectCandidates(scope);
      if (cands.length) {
        const clicked = tryClick(cands[12].el);    // 改为 cands[1]（第2个）、cands[2]（第3个）等
        if (clicked) return true;
      }
    }
    return false;
  }

  // DOM 监听：一出现就尝试点击
  const mo = new MutationObserver((muts)=>{
    if (!enabled) return;
    for (const m of muts) {
      for (const n of m.addedNodes || []) {
        if (!(n instanceof Element)) continue;
        const cands = collectCandidates(n);
        if (cands.length) { tryClick(cands[0].el); }
      }
    }
  });
  mo.observe(document.documentElement || document.body, { childList:true, subtree:true });

  // 2s 周期扫描
  const timer = setInterval(()=> {
    try { scanAndClick(); } catch {}
  }, interval);

  // 初次尝试
  window.addEventListener('load', ()=> setTimeout(scanAndClick, 600));

  // 开关：Ctrl+Shift+L
  window.addEventListener('keydown', (e)=>{
    if (e.ctrlKey && e.shiftKey && (e.key==='L'||e.key==='l')) {
      enabled = !enabled;
      console.log('[JD-领取] 自动领取已', enabled ? '启用' : '禁用', 'frame=', location.hostname);
    }
  });

  // 调试接口：在 Console 里用 JDClaimAuto.dump()
  window.JDClaimAuto = {
    dump() {
      const list = collectCandidates(document).slice(0, 15).map(x => ({         //"15"为查找返回候选的数量
        score: x.score, text: x.txt, class: x.cls, bg: x.bg
      }));
      console.table(list);
      return list;
    },
    enable(){ enabled = true;  console.log('[JD-领取] 已启用'); },
    disable(){ enabled = false; console.log('[JD-领取] 已禁用'); }
  };

  console.log('[JD-领取] 脚本已加载（frame=', location.hostname, '）');
})();