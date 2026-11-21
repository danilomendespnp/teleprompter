/* Teleprompter — PWA estático, sem dependências.
 * Telas: lista de roteiros, editor, teleprompter (câmera + gravação ou só ler), resultado.
 * Dados só no aparelho (localStorage). */
'use strict';

(function () {
  // =========================================================
  // Utilidades
  // =========================================================
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = () => {
    try { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; } catch (e) { return false; }
  };
  const coarsePointer = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } })();

  function uid() {
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) { /* segue */ }
    return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  let wordRe;
  try { wordRe = new RegExp('[\\p{L}\\p{N}]', 'u'); } catch (e) { wordRe = /[A-Za-z0-9À-ɏ]/; }
  /** Conta palavras ignorando marcações entre [colchetes]. */
  function countWords(text) {
    const clean = String(text || '').replace(/\[[^\]\n]*\]/g, ' ');
    let n = 0;
    for (const w of clean.split(/\s+/)) if (w && wordRe.test(w)) n++;
    return n;
  }
  function fmtTime(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const ss = String(s).padStart(2, '0');
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + ss : m + ':' + ss;
  }
  function fmtBytes(b) {
    if (b < 1024 * 1024) return Math.max(1, Math.round(b / 1024)) + ' KB';
    return (b / 1048576).toFixed(1).replace('.', ',') + ' MB';
  }
  function fmtNum(n, d) { return Number(n).toFixed(d).replace('.', ','); }
  function pad2(n) { return String(n).padStart(2, '0'); }
  function fileName(d, ext) {
    return 'teleprompter_' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      '_' + pad2(d.getHours()) + pad2(d.getMinutes()) + '.' + ext;
  }
  function fmtDate(ts) {
    try {
      const d = new Date(ts), now = new Date();
      if (d.toDateString() === now.toDateString()) {
        return 'hoje, ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      }
      return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    } catch (e) { return ''; }
  }
  function debounce(fn, ms) {
    let t = 0;
    const f = function () { clearTimeout(t); t = setTimeout(() => { t = 0; fn(); }, ms); };
    f.flush = () => { if (t) { clearTimeout(t); t = 0; fn(); } };
    f.cancel = () => { clearTimeout(t); t = 0; };
    return f;
  }

  // =========================================================
  // Armazenamento local (tudo em try/catch)
  // =========================================================
  const KEYS = { scripts: 'tp.scripts.v1', settings: 'tp.settings.v1', seeded: 'tp.seeded.v1', iosTip: 'tp.iostip.v1' };
  const LS = {
    get(k, def) {
      try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; }
    },
  };
  let lastSaveErr = 0;
  function warnSaveFailed() {
    const now = Date.now();
    if (now - lastSaveErr > 10000) {
      lastSaveErr = now;
      toast('Não consegui salvar neste aparelho (memória cheia ou navegação privada).', { type: 'error', duration: 5000 });
    }
  }

  // =========================================================
  // Ajustes
  // =========================================================
  const DEFAULTS = {
    fontSize: 40, speed: 11, lineHeight: 1.4, margin: 6, align: 'left',
    area: 'top', bgOpacity: 45, color: 'white', guide: true,
    flipH: false, flipV: false, upper: false, bold: true,
    quality: '1080', countdown: 3, startTogether: true, autoStop: true,
    mode: 'camera', facing: 'user',
  };
  const SCHEMA = {
    fontSize: { num: [18, 96] }, speed: { num: [1, 30] }, lineHeight: { num: [1, 2.2] },
    margin: { num: [0, 25] }, bgOpacity: { num: [0, 90] },
    align: { en: ['left', 'center'] }, area: { en: ['top', 'half', 'full'] },
    color: { en: ['white', 'yellow', 'green'] }, quality: { en: ['720', '1080', '4k'] },
    countdown: { en: [0, 3, 5, 10] }, mode: { en: ['camera', 'read'] }, facing: { en: ['user', 'environment'] },
    guide: { bool: 1 }, flipH: { bool: 1 }, flipV: { bool: 1 }, upper: { bool: 1 }, bold: { bool: 1 },
    startTogether: { bool: 1 }, autoStop: { bool: 1 },
  };
  function sanitize(obj) {
    const out = Object.assign({}, DEFAULTS);
    if (obj && typeof obj === 'object') {
      for (const k of Object.keys(SCHEMA)) {
        const r = SCHEMA[k], v = obj[k];
        if (r.num) { const n = Number(v); if (v !== null && v !== '' && Number.isFinite(n)) out[k] = clamp(n, r.num[0], r.num[1]); }
        else if (r.bool) { if (typeof v === 'boolean') out[k] = v; }
        else if (r.en.indexOf(v) >= 0) out[k] = v;
      }
    }
    return out;
  }
  let S = sanitize(LS.get(KEYS.settings, null));
  const saveSettingsSoon = debounce(() => { if (!LS.set(KEYS.settings, S)) warnSaveFailed(); }, 300);

  const COLORS = { white: '#ffffff', yellow: '#ffe34d', green: '#a6f5a6' };
  const QUALITY = {
    '720': { long: 1280, short: 720, bps: 5000000 },
    '1080': { long: 1920, short: 1080, bps: 10000000 },
    '4k': { long: 3840, short: 2160, bps: 35000000 },
  };
  /** Nível de velocidade (1–30) → palavras por minuto estimadas. */
  const wpm = (lvl) => 50 + (lvl - 1) * 10;
  const GUIDE_RATIO = 0.3; // posição da linha de leitura dentro da faixa

  // =========================================================
  // Roteiros
  // =========================================================
  const EXAMPLE = {
    title: 'Exemplo: como usar o teleprompter',
    text: 'Oi! Este é um roteiro de exemplo para você testar o teleprompter.\n\n' +
      'Toque no texto para pausar ou continuar a rolagem. Arraste com o dedo para voltar ou avançar.\n\n' +
      'Use os botões de mais e menos na lateral para ajustar a velocidade e o tamanho da letra sem parar a leitura.\n\n' +
      '[pausa] Texto entre colchetes aparece apagado. Serve para marcar pausas, gestos ou cortes.\n\n' +
      'Deixe a faixa de texto no terço de cima da tela, perto da câmera. Assim o seu olhar fica quase na lente e parece que você está falando direto com quem assiste.\n\n' +
      'Quando terminar, toque no botão vermelho para parar. Depois é só salvar no celular ou compartilhar.\n\n' +
      'Agora apague este texto e cole o seu roteiro. Boa gravação!',
  };
  const Store = {
    list: [],
    load() {
      const arr = LS.get(KEYS.scripts, null);
      this.list = Array.isArray(arr) ? arr.filter((s) => s && typeof s === 'object' && typeof s.id === 'string').map((s) => ({
        id: s.id,
        title: typeof s.title === 'string' ? s.title : '',
        text: typeof s.text === 'string' ? s.text : '',
        createdAt: Number(s.createdAt) || Date.now(),
        updatedAt: Number(s.updatedAt) || Date.now(),
      })) : [];
      if (!LS.get(KEYS.seeded, false)) {
        if (this.list.length === 0) {
          const now = Date.now();
          this.list.push({ id: uid(), title: EXAMPLE.title, text: EXAMPLE.text, createdAt: now, updatedAt: now });
          this.save();
        }
        LS.set(KEYS.seeded, true);
      }
    },
    save() { if (!LS.set(KEYS.scripts, this.list)) warnSaveFailed(); },
    sorted() { return this.list.slice().sort((a, b) => b.updatedAt - a.updatedAt); },
    get(id) { return this.list.find((s) => s.id === id) || null; },
    create(title, text) {
      const now = Date.now();
      const s = { id: uid(), title: title || '', text: text || '', createdAt: now, updatedAt: now };
      this.list.push(s); this.save(); return s;
    },
    update(id, patch) {
      const s = this.get(id); if (!s) return null;
      Object.assign(s, patch, { updatedAt: Date.now() }); this.save(); return s;
    },
    remove(id) { this.list = this.list.filter((s) => s.id !== id); this.save(); },
    duplicate(id) {
      const s = this.get(id); if (!s) return null;
      return this.create((s.title || 'Sem título') + ' (cópia)', s.text);
    },
  };
  const displayTitle = (s) => (s.title && s.title.trim()) || 'Sem título';

  // =========================================================
  // Elementos
  // =========================================================
  let el = {};
  function grabElements() {
    const ids = ['view-list', 'view-editor', 'view-prompter', 'view-result', 'scriptList', 'emptyState', 'btnNew',
      'btnListSettings', 'btnInstall', 'iosTip', 'btnIosTipClose',
      'btnEditorBack', 'btnEditorMore', 'saveState', 'edTitle', 'edText', 'btnPaste', 'edCount', 'btnEditorPlay',
      'cam', 'stage', 'band', 'viewport', 'flipper', 'guide', 'scroller', 'scriptText', 'stateChip',
      'btnTpClose', 'statusPill', 'statusText', 'btnFlip', 'btnMode', 'progress', 'progressFill', 'remaining',
      'spdUp', 'spdDown', 'spdVal', 'sizeUp', 'sizeDown', 'sizeVal', 'camMsg', 'camMsgText', 'btnCamRetry',
      'btnCamDismiss', 'btnTop', 'btnRewind', 'btnMain', 'btnPlay', 'btnTpSettings', 'countdown', 'countdownNum',
      'btnResultBack', 'resMeta', 'resVideo', 'resName', 'btnShare', 'btnDownload', 'btnAgain', 'btnDiscard',
      'sheetWrap', 'sheet', 'sheetBody', 'sheetBackdrop', 'btnSheetClose', 'btnResetSettings', 'qualityNote',
      'dialogWrap', 'dialog', 'dialogBackdrop', 'dialogTitle', 'dialogMsg', 'dialogActions', 'toasts'];
    for (const id of ids) el[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = document.getElementById(id);
    el.views = { list: el.viewList, editor: el.viewEditor, prompter: el.viewPrompter, result: el.viewResult };
  }

  // =========================================================
  // Toasts e diálogos (sem alert())
  // =========================================================
  function toast(msg, opts) {
    opts = opts || {};
    if (!el.toasts) return;
    const t = document.createElement('div');
    t.className = 'toast' + (opts.type === 'error' ? ' toast-error' : '');
    const span = document.createElement('span');
    span.textContent = msg;
    t.appendChild(span);
    let timer = 0;
    const close = () => {
      clearTimeout(timer);
      t.classList.remove('show');
      setTimeout(() => t.remove(), 250);
    };
    if (opts.action) {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = opts.action.label;
      b.addEventListener('click', () => { close(); opts.action.run(); });
      t.appendChild(b);
    }
    t.addEventListener('click', (e) => { if (e.target === t || e.target === span) close(); });
    while (el.toasts.children.length >= 3) el.toasts.firstChild.remove();
    el.toasts.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    timer = setTimeout(close, opts.duration || 3200);
  }

  const Dialog = {
    open: false, resolve: null, prevFocus: null,
    show(opts) {
      if (this.open) this.close(null);
      return new Promise((resolve) => {
        this.open = true; this.resolve = resolve; this.prevFocus = document.activeElement;
        el.dialog.classList.toggle('list', !!opts.list);
        el.dialogTitle.textContent = opts.title || '';
        el.dialogMsg.textContent = opts.message || '';
        el.dialogActions.textContent = '';
        let focusBtn = null;
        for (const b of opts.buttons) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn ' + (b.kind || '');
          if (b.icon) {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('class', 'ico'); svg.setAttribute('aria-hidden', 'true');
            const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
            use.setAttribute('href', '#' + b.icon);
            svg.appendChild(use); btn.appendChild(svg);
          }
          const sp = document.createElement('span'); sp.textContent = b.label; btn.appendChild(sp);
          btn.addEventListener('click', () => this.close(b.value));
          el.dialogActions.appendChild(btn);
          if (b.focus || (!focusBtn && b.kind !== 'danger')) focusBtn = btn;
        }
        el.dialogWrap.hidden = false;
        (focusBtn || el.dialogActions.firstChild).focus();
      });
    },
    close(value) {
      if (!this.open) return;
      this.open = false;
      el.dialogWrap.hidden = true;
      const r = this.resolve; this.resolve = null;
      try { if (this.prevFocus && this.prevFocus.focus) this.prevFocus.focus(); } catch (e) { /* ok */ }
      if (r) r(value);
    },
  };
  function confirmDialog(title, message, okLabel, danger) {
    return Dialog.show({
      title, message,
      buttons: [
        { label: 'Cancelar', value: false, kind: 'ghost', focus: true },
        { label: okLabel || 'Confirmar', value: true, kind: danger ? 'danger' : 'primary' },
      ],
    }).then((v) => v === true);
  }

  // =========================================================
  // Navegação (com histórico, para o botão voltar do Android)
  // =========================================================
  let current = 'list';
  let curState = { view: 'list' };
  let ignoreNextPop = false;

  function navigate(view, data) {
    const st = Object.assign({ view }, data || {});
    if (Sheet.open) { Sheet.hide(true); history.replaceState(st, ''); }
    else history.pushState(st, '');
    enterView(st);
  }
  function goBack() { history.back(); }

  function enterView(st) {
    const prev = current;
    if (prev === 'editor') leaveEditor();
    if (prev === 'prompter') leavePrompter();
    if (prev === 'result') leaveResult();
    current = st.view; curState = st;
    for (const k of Object.keys(el.views)) el.views[k].hidden = k !== st.view;
    document.documentElement.dataset.view = st.view;
    if (st.view === 'list') renderList();
    else if (st.view === 'editor') enterEditor(st);
    else if (st.view === 'prompter') enterPrompter(st);
    else if (st.view === 'result') enterResult();
  }

  /** Volta a empilhar a entrada atual (quando o "voltar" foi barrado). */
  function repush() { history.pushState(Object.assign({}, curState, Sheet.open ? { sheet: true } : {}), ''); }

  async function onPopState(e) {
    if (ignoreNextPop) { ignoreNextPop = false; return; }
    const st = (e.state && e.state.view) ? e.state : { view: 'list' };
    if (Dialog.open) { Dialog.close(null); repush(); return; }
    if (Sheet.open && !st.sheet) {
      Sheet.hide(true);
      if (st.view === current) return;
    }
    if (current === 'prompter' && R.recording) {
      repush();
      stopRecording('back');
      return;
    }
    if (current === 'result' && !Result.saved && st.view !== 'result') {
      repush();
      const ok = await confirmDialog('Descartar a gravação?', 'Você ainda não salvou nem baixou este vídeo.', 'Descartar', true);
      if (ok) { Result.saved = true; goBack(); }
      return;
    }
    if (st.view === current && st.view !== 'prompter' && st.view !== 'editor') { curState = st; return; }
    enterView(st);
  }

  // =========================================================
  // Lista de roteiros
  // =========================================================
  function renderList() {
    const items = Store.sorted();
    el.scriptList.textContent = '';
    el.emptyState.hidden = items.length > 0;
    const w = wpm(S.speed);
    for (const s of items) {
      const words = countWords(s.text);
      const li = document.createElement('li');
      li.className = 'card';
      const title = displayTitle(s);
      const snippet = s.text.replace(/\s+/g, ' ').trim().slice(0, 160);
      li.innerHTML =
        '<button class="card-main" type="button" data-act="open">' +
          '<span class="card-title"></span><span class="card-snippet"></span>' +
          '<span class="card-meta"><b>' + words + '</b> ' + (words === 1 ? 'palavra' : 'palavras') +
          ' · ~' + fmtTime(words / w * 60) + ' · ' + escapeHtml(fmtDate(s.updatedAt)) + '</span>' +
        '</button>' +
        '<div class="card-actions">' +
          '<button class="icon-btn" type="button" data-act="more"><svg class="ico" aria-hidden="true"><use href="#i-dots"/></svg></button>' +
          '<button class="icon-btn play" type="button" data-act="play"><svg class="ico" aria-hidden="true"><use href="#i-play"/></svg></button>' +
        '</div>';
      li.querySelector('.card-title').textContent = title;
      li.querySelector('.card-snippet').textContent = snippet || 'Roteiro vazio';
      li.querySelector('[data-act="more"]').setAttribute('aria-label', 'Mais ações: ' + title);
      li.querySelector('[data-act="play"]').setAttribute('aria-label', 'Abrir no teleprompter: ' + title);
      li.dataset.id = s.id;
      el.scriptList.appendChild(li);
    }
  }

  async function onListClick(e) {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const li = btn.closest('.card');
    const id = li && li.dataset.id;
    if (!id) return;
    const act = btn.dataset.act;
    if (act === 'open') navigate('editor', { id });
    else if (act === 'play') openPrompter(id);
    else if (act === 'more') {
      const s = Store.get(id); if (!s) return;
      const v = await Dialog.show({
        title: displayTitle(s), list: true,
        buttons: [
          { label: 'Editar', value: 'edit', icon: 'i-edit' },
          { label: 'Duplicar', value: 'dup', icon: 'i-copy' },
          { label: 'Excluir', value: 'del', icon: 'i-trash', kind: 'danger-ghost' },
          { label: 'Cancelar', value: null, kind: 'ghost' },
        ],
      });
      if (v === 'edit') navigate('editor', { id });
      else if (v === 'dup') { Store.duplicate(id); renderList(); toast('Cópia criada.'); }
      else if (v === 'del') {
        const ok = await confirmDialog('Excluir roteiro?', '“' + displayTitle(s) + '” será apagado deste aparelho. Não dá para desfazer.', 'Excluir', true);
        if (ok) { Store.remove(id); renderList(); toast('Roteiro excluído.'); }
      }
    }
  }

  function openPrompter(id) {
    const s = Store.get(id);
    if (!s || countWords(s.text) === 0) { toast('Esse roteiro está vazio. Escreva ou cole um texto primeiro.'); return; }
    navigate('prompter', { id });
  }

  // =========================================================
  // Editor
  // =========================================================
  const Ed = { id: null, deleted: false };
  const saveEditorSoon = debounce(saveEditorNow, 400);

  function enterEditor(st) {
    const s = Store.get(st.id);
    if (!s) { history.replaceState({ view: 'list' }, ''); enterView({ view: 'list' }); return; }
    Ed.id = s.id; Ed.deleted = false;
    el.edTitle.value = s.title;
    el.edText.value = s.text;
    el.saveState.textContent = 'Salvo';
    updateEditorCount();
    if (st.isNew && !s.title && !s.text) setTimeout(() => { try { el.edTitle.focus(); } catch (e) { /* ok */ } }, 60);
  }
  function saveEditorNow() {
    if (!Ed.id || Ed.deleted) return;
    const s = Store.get(Ed.id); if (!s) return;
    if (s.title !== el.edTitle.value || s.text !== el.edText.value) {
      Store.update(Ed.id, { title: el.edTitle.value, text: el.edText.value });
    }
    el.saveState.textContent = 'Salvo';
  }
  function onEditorInput() {
    el.saveState.textContent = 'Salvando…';
    updateEditorCount();
    saveEditorSoon();
  }
  function updateEditorCount() {
    const n = countWords(el.edText.value);
    el.edCount.textContent = n + (n === 1 ? ' palavra' : ' palavras') + ' · ~' + fmtTime(n / wpm(S.speed) * 60) +
      ' a ' + wpm(S.speed) + ' ppm';
  }
  function leaveEditor() {
    saveEditorSoon.flush();
    if (Ed.id && !Ed.deleted) {
      const s = Store.get(Ed.id);
      if (s && !s.title.trim() && !s.text.trim()) Store.remove(Ed.id);
    }
    try { el.edTitle.blur(); el.edText.blur(); } catch (e) { /* ok */ }
    Ed.id = null;
  }
  async function pasteClipboard() {
    const fallback = 'O navegador não liberou a área de transferência. Toque e segure no texto e escolha Colar.';
    if (!navigator.clipboard || !navigator.clipboard.readText) { toast(fallback, { duration: 4500 }); el.edText.focus(); return; }
    try {
      const t = await navigator.clipboard.readText();
      if (!t) { toast('A área de transferência está vazia.'); return; }
      const ta = el.edText;
      const start = ta.selectionStart != null ? ta.selectionStart : ta.value.length;
      const end = ta.selectionEnd != null ? ta.selectionEnd : ta.value.length;
      if (typeof ta.setRangeText === 'function') ta.setRangeText(t, start, end, 'end');
      else ta.value = ta.value.slice(0, start) + t + ta.value.slice(end);
      onEditorInput();
      toast('Texto colado.');
    } catch (e) {
      toast(fallback, { duration: 4500 });
      el.edText.focus();
    }
  }
  async function editorMore() {
    if (!Ed.id) return;
    saveEditorSoon.flush();
    const id = Ed.id;
    const v = await Dialog.show({
      title: 'Roteiro', list: true,
      buttons: [
        { label: 'Duplicar', value: 'dup', icon: 'i-copy' },
        { label: 'Excluir', value: 'del', icon: 'i-trash', kind: 'danger-ghost' },
        { label: 'Cancelar', value: null, kind: 'ghost' },
      ],
    });
    if (v === 'dup') { Store.duplicate(id); toast('Cópia criada na lista de roteiros.'); }
    else if (v === 'del') {
      const ok = await confirmDialog('Excluir roteiro?', 'Este roteiro será apagado deste aparelho. Não dá para desfazer.', 'Excluir', true);
      if (ok) { Ed.deleted = true; saveEditorSoon.cancel(); Store.remove(id); toast('Roteiro excluído.'); goBack(); }
    }
  }

  // =========================================================
  // Teleprompter: rolagem
  // =========================================================
  const P = {
    script: null, words: 0, pos: 0, maxPos: 0, pxPerSec: 0, guideY: 0,
    playing: false, dragging: false, ended: false, raf: 0, last: 0, endTimer: 0,
    lastRemaining: '', lastProgress: -1, camError: '',
  };
  let resizeObs = null;

  function renderScriptHTML(text) {
    return escapeHtml(String(text).replace(/\s+$/, '')).replace(/\[([^\]\n]{0,300})\]/g, '<span class="cue">[$1]</span>');
  }

  function relayout() {
    if (current !== 'prompter') return;
    const frac = P.maxPos > 0 ? P.pos / P.maxPos : 0;
    const vh = el.viewport.clientHeight;
    const lineH = S.fontSize * S.lineHeight;
    P.guideY = Math.round(vh * GUIDE_RATIO);
    el.guide.style.top = Math.round(P.guideY + lineH / 2) + 'px';
    P.maxPos = Math.max(1, el.scriptText.offsetHeight);
    P.pos = clamp(frac * P.maxPos, 0, P.maxPos);
    computeSpeed();
    renderPosition(true);
  }
  function computeSpeed() {
    const secs = P.words / wpm(S.speed) * 60;
    P.pxPerSec = secs > 0 ? P.maxPos / secs : 0;
  }
  function renderPosition(force) {
    const dpr = window.devicePixelRatio || 1;
    const y = Math.round((P.guideY - P.pos) * dpr) / dpr;
    el.scroller.style.transform = 'translate3d(0,' + y + 'px,0)';
    const frac = P.maxPos > 0 ? P.pos / P.maxPos : 0;
    const pct = Math.round(frac * 1000) / 1000;
    if (force || pct !== P.lastProgress) {
      P.lastProgress = pct;
      el.progressFill.style.transform = 'scaleX(' + pct + ')';
      el.progress.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
    }
    const rem = P.pxPerSec > 0 ? fmtTime((P.maxPos - P.pos) / P.pxPerSec) : '0:00';
    if (force || rem !== P.lastRemaining) {
      P.lastRemaining = rem;
      el.remaining.textContent = '−' + rem;
    }
  }

  function tick(now) {
    P.raf = requestAnimationFrame(tick);
    const dt = P.last ? Math.min((now - P.last) / 1000, 0.25) : 0;
    P.last = now;
    if (P.playing && !P.dragging && P.pxPerSec > 0) {
      P.pos += P.pxPerSec * dt; // acumula fração de pixel (P.pos é float)
      if (P.pos >= P.maxPos) { P.pos = P.maxPos; reachEnd(); }
    }
    renderPosition(false);
    if (R.recording) {
      const s = Math.floor((now - R.t0) / 1000);
      if (s !== R.lastSec) { R.lastSec = s; el.statusText.textContent = fmtTime(s); }
    }
  }
  function startLoop() { if (!P.raf) { P.last = 0; P.raf = requestAnimationFrame(tick); } }
  function stopLoop() { if (P.raf) cancelAnimationFrame(P.raf); P.raf = 0; P.last = 0; }

  function play() {
    if (P.pxPerSec <= 0) { toast('Não há texto para rolar.'); return; }
    if (P.pos >= P.maxPos - 0.5) P.pos = 0;
    clearTimeout(P.endTimer);
    P.ended = false; P.playing = true;
    syncPrompterUI();
  }
  function pause() {
    if (!P.playing) return;
    P.playing = false;
    syncPrompterUI();
  }
  function togglePlay() { if (P.playing) pause(); else play(); }
  function reachEnd() {
    P.playing = false; P.ended = true;
    syncPrompterUI();
    clearTimeout(P.endTimer);
    if (R.recording && S.autoStop) {
      P.endTimer = setTimeout(() => {
        if (R.recording && P.ended && !P.dragging && P.pos >= P.maxPos - 1) stopRecording('end');
      }, 1500);
    }
  }
  function seekTo(pos) {
    P.pos = clamp(pos, 0, P.maxPos);
    if (P.pos < P.maxPos - 0.5 && P.ended) { P.ended = false; clearTimeout(P.endTimer); syncPrompterUI(); }
  }

  // Toque = pausa/continua; arrastar = reposiciona sem brigar com a rolagem automática.
  let drag = null;
  function onStageDown(e) {
    if (e.button > 0 || cd.active) return;
    drag = { id: e.pointerId, y0: e.clientY, pos0: P.pos, t0: performance.now(), moved: false };
    try { el.stage.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
  }
  function onStageMove(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (!drag.moved) {
      if (Math.abs(dy) < 8) return;
      drag.moved = true; P.dragging = true;
      drag.y0 = e.clientY; drag.pos0 = P.pos;
      return;
    }
    const dir = S.flipV ? -1 : 1;
    seekTo(drag.pos0 - (e.clientY - drag.y0) * dir);
    e.preventDefault();
  }
  function onStageUp(e) {
    if (!drag || e.pointerId !== drag.id) return;
    const wasTap = !drag.moved && performance.now() - drag.t0 < 500;
    drag = null; P.dragging = false;
    if (wasTap) togglePlay();
  }
  function onStageCancel() { drag = null; P.dragging = false; }
  function onStageWheel(e) {
    e.preventDefault();
    const dir = S.flipV ? -1 : 1;
    seekTo(P.pos + e.deltaY * dir * (e.deltaMode === 1 ? 32 : 1));
  }

  // =========================================================
  // Câmera e gravação
  // =========================================================
  const R = {
    stream: null, track: null, rec: null, chunks: [], recording: false, stopping: false,
    t0: 0, lastSec: -1, startedAt: null, mime: '', facing: 'user', maxLong: 0, cameras: -1,
    token: 0, noAudio: false, stopReason: '',
  };
  const Result = { blob: null, url: '', file: null, name: '', ext: '', duration: 0, saved: true, scriptId: null };
  let pendingAutostart = false;
  let bgStopNotice = false;

  const streamAlive = () => !!(R.stream && R.track && R.track.readyState === 'live');
  const camActive = () => S.mode === 'camera' && streamAlive();

  function stopStream() {
    R.token++;
    const s = R.stream;
    R.stream = null; R.track = null;
    if (s) for (const t of s.getTracks()) { try { t.stop(); } catch (e) { /* ok */ } }
    try { el.cam.srcObject = null; } catch (e) { /* ok */ }
    el.cam.classList.remove('on');
  }

  function camErrorMessage(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
      return 'Sem permissão para usar a câmera e o microfone. Libere nas configurações do navegador e toque em Tentar de novo.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'Nenhuma câmera encontrada neste aparelho.';
    if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
      return 'A câmera está ocupada por outro app ou não respondeu. Feche outros apps de câmera e tente de novo.';
    }
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
      return 'A câmera não aceitou essa configuração. Tente outra qualidade de vídeo.';
    }
    return 'Não foi possível abrir a câmera.';
  }

  async function startCamera() {
    if (S.mode !== 'camera') return false;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      camFail(window.isSecureContext === false
        ? 'A câmera só funciona com o app aberto em HTTPS.'
        : 'Este navegador não dá acesso à câmera. Use o modo só ler.');
      return false;
    }
    if (R.recording) return false;
    stopStream();
    const token = ++R.token;
    P.camError = ''; el.camMsg.hidden = true;
    el.statusText.textContent = 'Abrindo câmera…';
    const q = QUALITY[S.quality] || QUALITY['1080'];
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    const facing = { ideal: S.facing };
    // Larguras/alturas em "paisagem": os navegadores do celular giram o quadro quando o aparelho está em pé.
    const attempts = [
      { video: { facingMode: facing, width: { ideal: q.long }, height: { ideal: q.short }, frameRate: { ideal: 30 } }, audio },
      { video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio },
      { video: { facingMode: facing }, audio: true },
      { video: true, audio: true },
    ];
    let stream = null, lastErr = null, sawNotFound = false;
    for (const c of attempts) {
      try { stream = await navigator.mediaDevices.getUserMedia(c); break; } catch (err) {
        lastErr = err;
        if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) break;
        if (err && err.name === 'NotFoundError') sawNotFound = true;
      }
      if (token !== R.token) return false;
    }
    R.noAudio = false;
    if (!stream && sawNotFound && !(lastErr && lastErr.name === 'NotAllowedError')) {
      // Pode faltar só o microfone: tenta sem áudio (um pedido só, porque o anterior falhou sem perguntar).
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false }); R.noAudio = true; }
      catch (err) { lastErr = err; }
    }
    if (token !== R.token || current !== 'prompter' || S.mode !== 'camera') {
      if (stream) stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    if (!stream) { camFail(camErrorMessage(lastErr)); return false; }

    R.stream = stream;
    R.warnedLandscape = false;
    R.track = stream.getVideoTracks()[0] || null;
    if (!R.track) { stopStream(); camFail('Nenhuma câmera encontrada neste aparelho.'); return false; }
    const track = R.track;
    track.addEventListener('ended', () => { if (R.track === track) onTrackEnded(); });
    let settings = {};
    try { settings = track.getSettings ? track.getSettings() : {}; } catch (e) { /* ok */ }
    R.facing = settings.facingMode === 'environment' ? 'environment' : (settings.facingMode === 'user' ? 'user' : (S.facing === 'environment' && coarsePointer ? 'environment' : 'user'));
    el.cam.classList.toggle('mirror', R.facing !== 'environment');
    R.maxLong = 0;
    try {
      const caps = track.getCapabilities ? track.getCapabilities() : null;
      if (caps && caps.width && caps.height) R.maxLong = Math.max(caps.width.max || 0, caps.height.max || 0);
    } catch (e) { /* ok */ }
    el.cam.muted = true;
    el.cam.playsInline = true;
    el.cam.srcObject = stream;
    try { await el.cam.play(); } catch (e) { /* autoplay mudo deve funcionar; se não, o quadro aparece no primeiro toque */ }
    el.cam.classList.add('on');
    if (R.noAudio) toast('Nenhum microfone encontrado: o vídeo vai sair sem som.', { duration: 4500 });
    countCameras();
    syncQualityUI();
    syncPrompterUI();
    return true;
  }

  function onCamMeta() {
    if (current !== 'prompter' || !streamAlive()) return;
    const w = el.cam.videoWidth, h = el.cam.videoHeight;
    if (!R.recording) el.statusText.textContent = w && h ? w + '×' + h : 'Câmera';
    if (!R.warnedLandscape && w > h && coarsePointer && !R.recording && (window.innerHeight > window.innerWidth)) {
      R.warnedLandscape = true;
      toast('A câmera está entregando vídeo na horizontal. Gire o celular em pé e reabra a câmera, se precisar.', { duration: 5000 });
    }
  }

  async function countCameras() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      R.cameras = devs.filter((d) => d.kind === 'videoinput').length;
    } catch (e) { R.cameras = -1; }
    syncPrompterUI();
  }

  function camFail(msg) {
    stopStream();
    P.camError = msg;
    el.camMsgText.textContent = msg + ' Enquanto isso, o modo só ler continua funcionando.';
    el.camMsg.hidden = false;
    syncPrompterUI();
  }

  function onTrackEnded() {
    if (R.recording) { stopRecording('track'); toast('A câmera foi interrompida. A gravação foi encerrada.', { type: 'error' }); return; }
    if (current === 'prompter' && S.mode === 'camera') camFail('A câmera foi interrompida.');
  }

  function pickMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    const list = ['video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    for (const m of list) { try { if (MediaRecorder.isTypeSupported(m)) return m; } catch (e) { /* segue */ } }
    return '';
  }
  function extFor(type) {
    const t = String(type || '').toLowerCase();
    if (t.indexOf('mp4') >= 0) return 'mp4';
    if (t.indexOf('matroska') >= 0) return 'mkv';
    if (t.indexOf('quicktime') >= 0) return 'mov';
    return 'webm';
  }

  function startRecording() {
    if (!camActive() || R.recording) return false;
    if (typeof MediaRecorder === 'undefined') {
      toast('Este navegador não grava vídeo. Use o modo só ler e grave com o app de câmera.', { type: 'error', duration: 5000 });
      return false;
    }
    const mime = pickMime();
    const q = QUALITY[S.quality] || QUALITY['1080'];
    const tries = [];
    if (mime) tries.push({ mimeType: mime, videoBitsPerSecond: q.bps, audioBitsPerSecond: 128000 });
    if (mime) tries.push({ mimeType: mime });
    tries.push(undefined);
    let rec = null;
    for (const opts of tries) {
      try { rec = opts ? new MediaRecorder(R.stream, opts) : new MediaRecorder(R.stream); break; } catch (e) { rec = null; }
    }
    if (!rec) { toast('Não foi possível iniciar a gravação neste navegador.', { type: 'error' }); return false; }
    R.chunks = [];
    R.mime = mime;
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size) R.chunks.push(ev.data); };
    rec.onstop = () => onRecStop(rec);
    rec.onerror = (ev) => {
      const n = ev && ev.error && ev.error.name;
      toast('Erro na gravação' + (n ? ' (' + n + ')' : '') + '.', { type: 'error' });
      try { if (rec.state !== 'inactive') rec.stop(); } catch (e) { /* ok */ }
    };
    try {
      // No iPhone, gravar sem fatias evita arquivos MP4 com problema em algumas versões do iOS.
      if (isIOS) rec.start(); else rec.start(1000);
    } catch (e) {
      toast('Não foi possível iniciar a gravação.', { type: 'error' });
      return false;
    }
    R.rec = rec; R.recording = true; R.stopping = false;
    R.t0 = performance.now(); R.lastSec = -1; R.startedAt = new Date();
    el.statusText.textContent = '0:00';
    syncPrompterUI();
    return true;
  }

  function stopRecording(reason) {
    if (!R.rec || R.stopping) return;
    R.stopping = true; R.stopReason = reason || '';
    R.duration = (performance.now() - R.t0) / 1000;
    clearTimeout(P.endTimer);
    pause();
    try {
      if (R.rec.state !== 'inactive') R.rec.stop();
      else onRecStop(R.rec);
    } catch (e) { onRecStop(R.rec); }
  }

  function onRecStop(rec) {
    if (rec !== R.rec) return;
    R.rec = null; R.recording = false; R.stopping = false;
    const type = (rec.mimeType || R.mime || (isIOS ? 'video/mp4' : 'video/webm'));
    const base = type.split(';')[0].trim() || 'video/webm';
    const chunks = R.chunks; R.chunks = [];
    const blob = new Blob(chunks, { type: base });
    if (!blob.size) {
      // Parar logo depois de começar (menos de ~1 s) pode não gerar nenhum dado.
      toast((R.duration || 0) < 1.5 ? 'Gravação curta demais, descartada.' : 'A gravação saiu vazia. Tente de novo.', { type: 'error' });
      syncPrompterUI();
      return;
    }
    const ext = extFor(base);
    const name = fileName(R.startedAt || new Date(), ext);
    if (Result.url) { try { URL.revokeObjectURL(Result.url); } catch (e) { /* ok */ } }
    Result.blob = blob;
    Result.url = URL.createObjectURL(blob);
    Result.name = name; Result.ext = ext;
    Result.duration = R.duration || 0;
    Result.saved = false;
    Result.scriptId = P.script ? P.script.id : null;
    try { Result.file = new File([blob], name, { type: base }); } catch (e) { Result.file = null; }
    if (R.stopReason === 'background') bgStopNotice = true;
    if (current === 'prompter') navigate('result', {});
  }

  function flipCamera() {
    if (R.recording || cd.active) return;
    S.facing = S.facing === 'user' ? 'environment' : 'user';
    saveSettingsSoon();
    startCamera();
  }

  function toggleMode() {
    if (R.recording) return;
    cancelCountdown();
    S.mode = S.mode === 'camera' ? 'read' : 'camera';
    saveSettingsSoon();
    if (S.mode === 'read') { stopStream(); P.camError = ''; el.camMsg.hidden = true; toast('Modo só ler: sem câmera, fundo preto.'); }
    else startCamera();
    syncPrompterUI();
  }

  // =========================================================
  // Contagem regressiva
  // =========================================================
  const cd = { active: false, timer: 0, left: 0, done: null };
  function startCountdown(onDone) {
    cancelCountdown();
    const n = Number(S.countdown) || 0;
    if (!n) { onDone(); return; }
    cd.active = true; cd.left = n; cd.done = onDone;
    el.countdown.hidden = false;
    showCount();
    syncPrompterUI();
    const step = () => {
      cd.left--;
      if (cd.left <= 0) {
        const fn = cd.done;
        cancelCountdown();
        if (fn) fn();
      } else { showCount(); cd.timer = setTimeout(step, 1000); }
    };
    cd.timer = setTimeout(step, 1000);
  }
  function showCount() {
    el.countdownNum.textContent = String(cd.left);
    el.countdownNum.classList.remove('tick');
    void el.countdownNum.offsetWidth;
    el.countdownNum.classList.add('tick');
  }
  function cancelCountdown() {
    if (!cd.active) return;
    clearTimeout(cd.timer);
    cd.active = false; cd.done = null;
    el.countdown.hidden = true;
    syncPrompterUI();
  }

  // =========================================================
  // Botão principal (gravar/parar ou rolar/pausar)
  // =========================================================
  function mainAction() {
    if (cd.active) { cancelCountdown(); return; }
    if (!camActive()) {
      if (P.playing) pause();
      else startCountdown(play);
      return;
    }
    if (R.recording) { stopRecording('user'); return; }
    if (typeof MediaRecorder === 'undefined') {
      toast('Este navegador não grava vídeo. Use o modo só ler e grave com o app de câmera.', { type: 'error', duration: 5000 });
      return;
    }
    if (P.ended || P.pos >= P.maxPos - 0.5) { P.pos = 0; P.ended = false; }
    pause();
    startCountdown(() => {
      if (current !== 'prompter' || !camActive()) return;
      if (startRecording() && S.startTogether) play();
    });
  }

  // =========================================================
  // Entrar/sair do teleprompter
  // =========================================================
  function enterPrompter(st) {
    const s = Store.get(st.id);
    if (!s) {
      toast('Roteiro não encontrado.');
      history.replaceState({ view: 'list' }, '');
      enterView({ view: 'list' });
      return;
    }
    P.script = s; P.words = countWords(s.text);
    P.pos = 0; P.playing = false; P.ended = false; P.camError = '';
    P.lastProgress = -1; P.lastRemaining = '';
    el.camMsg.hidden = true;
    el.scriptText.innerHTML = renderScriptHTML(s.text);
    applySettings();
    if (!resizeObs && typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(() => relayout());
    }
    if (resizeObs) { resizeObs.observe(el.scriptText); resizeObs.observe(el.viewport); }
    requestAnimationFrame(relayout);
    startLoop();
    requestWakeLock();
    const auto = pendingAutostart; pendingAutostart = false;
    if (S.mode === 'camera') {
      startCamera().then((ok) => { if (auto && current === 'prompter') { if (ok) mainAction(); } });
    } else {
      stopStream();
      if (auto) setTimeout(mainAction, 50);
    }
    syncPrompterUI();
  }

  function leavePrompter() {
    cancelCountdown();
    P.playing = false; P.dragging = false; drag = null;
    clearTimeout(P.endTimer);
    if (R.recording && R.rec) { try { R.rec.ondataavailable = null; R.rec.onstop = null; R.rec.stop(); } catch (e) { /* ok */ } R.rec = null; R.recording = false; }
    stopStream();
    stopLoop();
    if (resizeObs) resizeObs.disconnect();
    releaseWakeLock();
    if (Sheet.open) Sheet.hide(true);
  }

  function syncPrompterUI() {
    if (current !== 'prompter') return;
    const cam = camActive();
    const vp = el.viewPrompter;
    vp.classList.toggle('recording', R.recording);
    vp.classList.toggle('read-only', !cam);

    let state;
    if (cd.active) state = 'countdown';
    else if (cam) state = R.recording ? 'recording' : 'record';
    else state = P.playing ? 'pause' : 'play';
    el.btnMain.dataset.state = state;
    el.btnMain.setAttribute('aria-label', {
      countdown: 'Cancelar contagem', record: 'Começar a gravar', recording: 'Parar a gravação',
      play: 'Começar a rolar o texto', pause: 'Pausar o texto',
    }[state]);

    el.btnPlay.hidden = !cam;
    el.btnPlay.querySelector('use').setAttribute('href', P.playing ? '#i-pause' : '#i-play');
    el.btnPlay.setAttribute('aria-label', P.playing ? 'Pausar o texto' : 'Rolar o texto');

    el.btnFlip.hidden = S.mode !== 'camera' || R.cameras === 1 || R.cameras === 0;
    el.btnFlip.disabled = R.recording || cd.active || !streamAlive();
    el.btnMode.disabled = R.recording;
    el.btnMode.querySelector('use').setAttribute('href', S.mode === 'camera' ? '#i-text' : '#i-camera');
    el.btnMode.setAttribute('aria-label', S.mode === 'camera' ? 'Mudar para modo só ler (sem câmera)' : 'Ligar a câmera');
    el.btnTpClose.setAttribute('aria-label', R.recording ? 'Parar a gravação' : 'Sair do teleprompter');

    if (!R.recording) {
      if (S.mode === 'read') el.statusText.textContent = 'Só ler';
      else if (P.camError) el.statusText.textContent = 'Sem câmera';
      else if (streamAlive() && el.cam.videoWidth) el.statusText.textContent = el.cam.videoWidth + '×' + el.cam.videoHeight;
    }

    let chip = '';
    if (P.ended) chip = R.recording && S.autoStop ? 'Fim do texto · parando a gravação…' : 'Fim do texto';
    else if (!P.playing && !cd.active) chip = 'Toque no texto para rolar';
    el.stateChip.textContent = chip;
    el.stateChip.classList.toggle('show', !!chip);
    syncQualityUI();
  }

  // =========================================================
  // Resultado
  // =========================================================
  function canShareFile(file) {
    try { return !!(file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })); } catch (e) { return false; }
  }
  function enterResult() {
    if (!Result.blob) { history.replaceState({ view: 'list' }, ''); enterView({ view: 'list' }); return; }
    el.resVideo.src = Result.url;
    el.resMeta.textContent = fmtTime(Result.duration) + ' · ' + fmtBytes(Result.blob.size) + ' · ' + Result.ext.toUpperCase();
    el.resName.textContent = Result.name;
    const share = canShareFile(Result.file);
    el.btnShare.hidden = !share;
    el.btnDownload.classList.toggle('primary', !share);
    showBgNotice();
  }
  function showBgNotice() {
    if (!bgStopNotice || document.hidden || current !== 'result') return;
    bgStopNotice = false;
    toast('A gravação foi encerrada porque o app saiu da tela. O vídeo até ali foi guardado.', { duration: 5000 });
  }
  function onResultMeta() {
    // Vídeos WebM do MediaRecorder vêm sem duração; isso força o navegador a calcular.
    const v = el.resVideo;
    if (v.duration === Infinity || isNaN(v.duration)) {
      const fix = () => { v.removeEventListener('timeupdate', fix); try { v.currentTime = 0; } catch (e) { /* ok */ } };
      v.addEventListener('timeupdate', fix);
      try { v.currentTime = 1e101; } catch (e) { /* ok */ }
    }
  }
  function leaveResult() {
    try { el.resVideo.pause(); } catch (e) { /* ok */ }
    el.resVideo.removeAttribute('src');
    try { el.resVideo.load(); } catch (e) { /* ok */ }
    if (Result.url) { try { URL.revokeObjectURL(Result.url); } catch (e) { /* ok */ } }
    Result.blob = null; Result.url = ''; Result.file = null; Result.saved = true;
  }
  async function shareResult() {
    if (!Result.file) return;
    try {
      await navigator.share({ files: [Result.file], title: Result.name });
      Result.saved = true;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      toast('Não deu para compartilhar. Use o botão Baixar.', { type: 'error' });
    }
  }
  function downloadResult() {
    if (!Result.url) return;
    const a = document.createElement('a');
    a.href = Result.url; a.download = Result.name; a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 0);
    Result.saved = true;
    toast(isIOS ? 'Abrindo o download. No iPhone, prefira Salvar / Compartilhar para mandar para Fotos.' : 'Download iniciado.', { duration: isIOS ? 5000 : 3000 });
  }
  async function recordAgain() {
    if (!Result.saved) {
      const ok = await confirmDialog('Gravar de novo?', 'Esta gravação ainda não foi salva e será perdida.', 'Gravar de novo', true);
      if (!ok) return;
    }
    Result.saved = true;
    pendingAutostart = true;
    goBack();
  }
  async function discardResult() {
    const ok = await confirmDialog('Descartar a gravação?', Result.saved ? 'O vídeo sai desta tela. A cópia que você salvou continua no aparelho.' : 'Você ainda não salvou nem baixou este vídeo.', 'Descartar', true);
    if (!ok) return;
    Result.saved = true;
    goBack();
  }

  // =========================================================
  // Ajustes: aplicar, painel, atalhos
  // =========================================================
  function applySettings() {
    const vp = el.viewPrompter, st = vp.style;
    st.setProperty('--tp-size', S.fontSize + 'px');
    st.setProperty('--tp-lh', String(S.lineHeight));
    st.setProperty('--tp-margin', S.margin + '%');
    st.setProperty('--tp-color', COLORS[S.color] || '#fff');
    st.setProperty('--tp-bg', String(S.bgOpacity / 100));
    vp.dataset.align = S.align;
    vp.classList.toggle('bold', S.bold);
    vp.classList.toggle('upper', S.upper);
    vp.classList.toggle('show-guide', S.guide);
    el.band.dataset.area = S.area;
    el.flipper.style.transform = (S.flipH || S.flipV) ? 'scale(' + (S.flipH ? -1 : 1) + ',' + (S.flipV ? -1 : 1) + ')' : '';
    el.spdVal.textContent = String(S.speed);
    el.sizeVal.textContent = String(S.fontSize);
    el.spdUp.disabled = S.speed >= 30; el.spdDown.disabled = S.speed <= 1;
    el.sizeUp.disabled = S.fontSize >= 96; el.sizeDown.disabled = S.fontSize <= 18;
    if (current === 'prompter') {
      computeSpeed();
      // Alturas mudam com fonte/margem; o ResizeObserver chama relayout. Sem ele, recalcula aqui.
      if (!resizeObs) requestAnimationFrame(relayout);
      renderPosition(true);
    }
    syncSheetControls();
  }

  const OUT = {
    fontSize: (v) => v + ' px',
    speed: (v) => v + ' · ≈' + wpm(v) + ' palavras/min',
    lineHeight: (v) => fmtNum(v, 2),
    margin: (v) => v + '%',
    bgOpacity: (v) => v + '%',
  };
  function syncSheetControls() {
    if (!el.sheetBody) return;
    for (const inp of $$('input[data-setting]', el.sheetBody)) {
      const k = inp.dataset.setting;
      if (inp.type === 'checkbox') inp.checked = !!S[k];
      else if (document.activeElement !== inp || String(inp.value) !== String(S[k])) inp.value = String(S[k]);
    }
    for (const seg of $$('.seg[data-setting]', el.sheetBody)) {
      const k = seg.dataset.setting;
      for (const b of $$('button[data-value]', seg)) b.setAttribute('aria-pressed', String(b.dataset.value) === String(S[k]) ? 'true' : 'false');
    }
    for (const o of $$('output[data-out]', el.sheetBody)) {
      const k = o.dataset.out; o.textContent = OUT[k] ? OUT[k](S[k]) : String(S[k]);
    }
    syncQualityUI();
  }
  function syncQualityUI() {
    if (!el.sheetBody) return;
    const seg = $('.seg[data-setting="quality"]', el.sheetBody);
    const lock = R.recording;
    for (const b of $$('button', seg)) {
      const v = b.dataset.value;
      let unavailable = false;
      if (R.maxLong) {
        if (v === '4k' && R.maxLong < 3840) unavailable = true;
        if (v === '1080' && R.maxLong < 1920) unavailable = true;
      }
      b.disabled = lock || unavailable;
    }
    let note = '';
    if (lock) note = 'Não dá para trocar a qualidade durante a gravação.';
    else if (R.maxLong && R.maxLong < 3840) note = 'Esta câmera vai até ' + (R.maxLong >= 1920 ? '1080p' : (R.maxLong >= 1280 ? '720p' : R.maxLong + ' px')) + ' neste navegador.';
    el.qualityNote.textContent = note;
  }

  const restartCameraSoon = debounce(() => {
    if (current === 'prompter' && S.mode === 'camera' && !R.recording && !cd.active) startCamera();
  }, 350);

  function setSetting(k, v) {
    const prev = S[k];
    S = sanitize(Object.assign({}, S, { [k]: v }));
    if (S[k] === prev) { syncSheetControls(); return; }
    applySettings();
    saveSettingsSoon();
    if (k === 'quality') restartCameraSoon();
    if (k === 'speed') {
      if (current === 'list') renderList();
      if (current === 'editor') updateEditorCount();
    }
    if (current === 'prompter') syncPrompterUI();
  }

  const Sheet = {
    open: false, hideTimer: 0, prevFocus: null,
    show() {
      if (this.open) return;
      this.open = true;
      this.prevFocus = document.activeElement;
      history.pushState(Object.assign({}, curState, { sheet: true }), '');
      clearTimeout(this.hideTimer);
      syncSheetControls();
      el.sheetWrap.hidden = false;
      void el.sheetWrap.offsetWidth;
      el.sheetWrap.classList.add('open');
      setTimeout(() => { try { el.btnSheetClose.focus({ preventScroll: true }); } catch (e) { /* ok */ } }, 50);
    },
    hide(fromPop) {
      if (!this.open) return;
      this.open = false;
      el.sheetWrap.classList.remove('open');
      this.hideTimer = setTimeout(() => { if (!this.open) el.sheetWrap.hidden = true; }, 240);
      if (!fromPop && history.state && history.state.sheet) { ignoreNextPop = true; history.back(); }
      try { if (this.prevFocus && this.prevFocus.focus) this.prevFocus.focus({ preventScroll: true }); } catch (e) { /* ok */ }
    },
  };

  function bindRepeat(btn, fn) {
    let t = 0, iv = 0, repeated = false;
    const stop = () => { clearTimeout(t); clearInterval(iv); t = 0; iv = 0; };
    btn.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      repeated = false;
      stop();
      t = setTimeout(() => { repeated = true; fn(); iv = setInterval(fn, 110); }, 420);
    });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach((ev) => btn.addEventListener(ev, stop));
    btn.addEventListener('click', (e) => { if (repeated) { repeated = false; e.preventDefault(); return; } fn(); });
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // =========================================================
  // Tela acesa e segundo plano
  // =========================================================
  let wakeLock = null;
  async function requestWakeLock() {
    if (!('wakeLock' in navigator) || document.hidden || wakeLock) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
      if (current !== 'prompter') releaseWakeLock();
    } catch (e) { wakeLock = null; }
  }
  function releaseWakeLock() {
    const w = wakeLock; wakeLock = null;
    if (w) { try { w.release(); } catch (e) { /* ok */ } }
  }
  function onVisibility() {
    if (current === 'result') { showBgNotice(); return; }
    if (current !== 'prompter') return;
    if (document.hidden) {
      pause();
      cancelCountdown();
      if (R.recording) stopRecording('background');
    } else {
      requestWakeLock();
      if (S.mode === 'camera' && !R.recording && !streamAlive()) startCamera();
    }
  }

  // =========================================================
  // Instalação
  // =========================================================
  let installEvt = null;
  function setupInstall() {
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installEvt = e;
      el.btnInstall.hidden = false;
    });
    window.addEventListener('appinstalled', () => { installEvt = null; el.btnInstall.hidden = true; toast('App instalado.'); });
    el.btnInstall.addEventListener('click', async () => {
      if (!installEvt) return;
      const ev = installEvt; installEvt = null;
      el.btnInstall.hidden = true;
      try { ev.prompt(); await ev.userChoice; } catch (e) { /* ok */ }
    });
    if (isIOS && !isStandalone() && !LS.get(KEYS.iosTip, false)) el.iosTip.hidden = false;
    el.btnIosTipClose.addEventListener('click', () => { el.iosTip.hidden = true; LS.set(KEYS.iosTip, true); });
  }

  // =========================================================
  // Eventos
  // =========================================================
  function bindEvents() {
    window.addEventListener('popstate', onPopState);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('beforeunload', (e) => {
      if (R.recording || (current === 'result' && !Result.saved)) { e.preventDefault(); e.returnValue = ''; }
    });

    // Lista
    el.scriptList.addEventListener('click', onListClick);
    el.btnNew.addEventListener('click', () => { const s = Store.create('', ''); navigate('editor', { id: s.id, isNew: true }); });
    el.btnListSettings.addEventListener('click', () => Sheet.show());

    // Editor
    el.btnEditorBack.addEventListener('click', goBack);
    el.edTitle.addEventListener('input', onEditorInput);
    el.edText.addEventListener('input', onEditorInput);
    el.edTitle.addEventListener('blur', () => saveEditorSoon.flush());
    el.edText.addEventListener('blur', () => saveEditorSoon.flush());
    el.edTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.edText.focus(); } });
    el.btnPaste.addEventListener('click', pasteClipboard);
    el.btnEditorMore.addEventListener('click', editorMore);
    el.btnEditorPlay.addEventListener('click', () => {
      saveEditorSoon.flush();
      if (Ed.id) openPrompter(Ed.id);
    });

    // Teleprompter
    el.stage.addEventListener('pointerdown', onStageDown);
    el.stage.addEventListener('pointermove', onStageMove);
    el.stage.addEventListener('pointerup', onStageUp);
    el.stage.addEventListener('pointercancel', onStageCancel);
    el.stage.addEventListener('lostpointercapture', onStageCancel);
    el.stage.addEventListener('wheel', onStageWheel, { passive: false });
    el.cam.addEventListener('loadedmetadata', onCamMeta);
    el.cam.addEventListener('resize', onCamMeta);
    el.btnTpClose.addEventListener('click', () => { if (R.recording) stopRecording('user'); else goBack(); });
    el.btnMain.addEventListener('click', mainAction);
    el.btnPlay.addEventListener('click', () => { if (!cd.active) togglePlay(); });
    el.btnTop.addEventListener('click', () => { seekTo(0); });
    el.btnRewind.addEventListener('click', () => { seekTo(P.pos - P.pxPerSec * 5); });
    el.btnFlip.addEventListener('click', flipCamera);
    el.btnMode.addEventListener('click', toggleMode);
    el.btnTpSettings.addEventListener('click', () => Sheet.show());
    el.btnCamRetry.addEventListener('click', () => { if (S.mode !== 'camera') { S.mode = 'camera'; saveSettingsSoon(); } startCamera(); });
    el.btnCamDismiss.addEventListener('click', () => {
      el.camMsg.hidden = true; P.camError = '';
      S.mode = 'read'; saveSettingsSoon(); stopStream(); syncPrompterUI();
    });
    el.countdown.addEventListener('click', () => { cancelCountdown(); toast('Contagem cancelada.'); });
    bindRepeat(el.spdUp, () => setSetting('speed', S.speed + 1));
    bindRepeat(el.spdDown, () => setSetting('speed', S.speed - 1));
    bindRepeat(el.sizeUp, () => setSetting('fontSize', S.fontSize + 2));
    bindRepeat(el.sizeDown, () => setSetting('fontSize', S.fontSize - 2));

    // Resultado
    el.resVideo.addEventListener('loadedmetadata', onResultMeta);
    el.btnShare.addEventListener('click', shareResult);
    el.btnDownload.addEventListener('click', downloadResult);
    el.btnAgain.addEventListener('click', recordAgain);
    el.btnDiscard.addEventListener('click', discardResult);
    el.btnResultBack.addEventListener('click', discardResult);

    // Painel de ajustes
    el.btnSheetClose.addEventListener('click', () => Sheet.hide());
    el.sheetBackdrop.addEventListener('click', () => Sheet.hide());
    el.sheetBody.addEventListener('input', (e) => {
      const inp = e.target.closest('input[data-setting]');
      if (!inp || inp.type !== 'range') return;
      setSetting(inp.dataset.setting, Number(inp.value));
    });
    el.sheetBody.addEventListener('change', (e) => {
      const inp = e.target.closest('input[data-setting]');
      if (!inp) return;
      if (inp.type === 'checkbox') setSetting(inp.dataset.setting, inp.checked);
      else setSetting(inp.dataset.setting, Number(inp.value));
    });
    el.sheetBody.addEventListener('click', (e) => {
      const b = e.target.closest('.seg button[data-value]');
      if (!b || b.disabled) return;
      const seg = b.closest('.seg');
      let v = b.dataset.value;
      if (seg.dataset.type === 'num') v = Number(v);
      setSetting(seg.dataset.setting, v);
    });
    el.btnResetSettings.addEventListener('click', async () => {
      const ok = await confirmDialog('Restaurar padrões?', 'Os ajustes de texto, área e gravação voltam ao padrão. Os roteiros não mudam.', 'Restaurar');
      if (!ok) return;
      const keep = { mode: S.mode, facing: S.facing };
      const prevQ = S.quality;
      S = sanitize(Object.assign({}, DEFAULTS, keep));
      applySettings(); saveSettingsSoon();
      if (S.quality !== prevQ) restartCameraSoon();
      if (current === 'list') renderList();
      if (current === 'prompter') syncPrompterUI();
      toast('Ajustes restaurados.');
    });

    // Diálogo
    el.dialogBackdrop.addEventListener('click', () => Dialog.close(null));

    // Teclado (desktop / teclado Bluetooth)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (Dialog.open) { Dialog.close(null); e.preventDefault(); return; }
        if (Sheet.open) { Sheet.hide(); e.preventDefault(); return; }
      }
      if (Dialog.open) {
        if (e.key === 'Tab') trapFocus(e, el.dialog);
        return;
      }
      if (Sheet.open) { if (e.key === 'Tab') trapFocus(e, el.sheet); return; }
      if (current !== 'prompter') return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const onButton = tag === 'BUTTON';
      switch (e.key) {
        case ' ':
          if (onButton) return;
          e.preventDefault(); if (!cd.active) togglePlay(); break;
        case 'ArrowUp': e.preventDefault(); setSetting('speed', S.speed + 1); break;
        case 'ArrowDown': e.preventDefault(); setSetting('speed', S.speed - 1); break;
        case 'ArrowLeft': e.preventDefault(); seekTo(P.pos - P.pxPerSec * 5); break;
        case '+': case '=': setSetting('fontSize', S.fontSize + 2); break;
        case '-': setSetting('fontSize', S.fontSize - 2); break;
        case 'Home': e.preventDefault(); seekTo(0); break;
        case 'Escape': if (!R.recording) goBack(); break;
        default: break;
      }
    });
  }
  function trapFocus(e, root) {
    const f = $$('button:not([disabled]):not([hidden]), input:not([disabled]), [tabindex]:not([tabindex="-1"])', root)
      .filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    else if (!root.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  }

  // =========================================================
  // Service worker (offline)
  // =========================================================
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    const okHost = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    if (!okHost) return;
    navigator.serviceWorker.register('./sw.js').catch(() => { /* sem offline, segue funcionando */ });
  }

  // =========================================================
  // Início
  // =========================================================
  function init() {
    grabElements();
    Store.load();
    applySettings();
    bindEvents();
    setupInstall();
    history.replaceState({ view: 'list' }, '');
    enterView({ view: 'list' });
    registerSW();
    // Gancho de teste (somente leitura do estado; não altera nada).
    window.__tp = { get state() { return { view: current, pos: P.pos, maxPos: P.maxPos, pxPerSec: P.pxPerSec, playing: P.playing, ended: P.ended, words: P.words, mode: S.mode, recording: R.recording }; }, settings: () => Object.assign({}, S) };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
