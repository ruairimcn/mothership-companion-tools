// The folder drawer: a slide-out panel drawn over the app in a shadow root so
// the app's styles and ours can't interfere with each other.
(() => {
  'use strict';

  const { store, opener, page } = window.MSCFolders;
  const KINDS = store.kinds;
  const UI_KEY = 'ui';

  const ui = {
    open: false,
    kind: 'characters', // which list is showing (follows the app's page)
    query: '',
    editing: null, // { mode: 'new' } | { mode: 'rename', folderId }
    editValue: '',
    dragItemId: null,
  };

  // ---- Tiny DOM helper (text only — never innerHTML with app data) ----------

  const h = (tag, props = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: "Helvetica Neue", Arial, sans-serif; }
    button { font: inherit; color: inherit; cursor: pointer; }
    .tab {
      position: fixed; top: 50%; right: 0; transform: translateY(-50%);
      z-index: 2147483646; background: #000; color: #fff; border: 2px solid #000;
      border-right: 0; border-radius: 10px 0 0 10px; padding: 14px 7px;
      writing-mode: vertical-rl; font-weight: 800; font-size: 12px; letter-spacing: .14em;
      box-shadow: 0 2px 10px rgba(0,0,0,.25);
    }
    .tab:hover { background: #222; }
    .drawer {
      position: fixed; top: 0; right: 0; bottom: 0; width: min(340px, 100vw);
      z-index: 2147483647; background: #fff; color: #000; border-left: 3px solid #000;
      display: flex; flex-direction: column; transform: translateX(105%);
      transition: transform .18s ease-out; box-shadow: -6px 0 24px rgba(0,0,0,.25);
    }
    .drawer.open { transform: none; }
    header { display: flex; align-items: center; gap: 8px; padding: 14px 14px 8px; }
    h1 { flex: 1; margin: 0; font-size: 17px; font-weight: 900; letter-spacing: .04em; text-transform: uppercase; }
    .icon { border: 0; background: none; font-size: 18px; line-height: 1; padding: 4px 6px; border-radius: 6px; }
    .icon:hover { background: #eee; }
    .icon:disabled { opacity: .3; cursor: default; background: none; }
    .kinds { display: flex; margin: 0 14px 10px; border: 2px solid #000; border-radius: 8px; overflow: hidden; }
    .kind { flex: 1; border: 0; background: #fff; padding: 6px 4px; font-size: 11px; font-weight: 800;
      text-transform: uppercase; letter-spacing: .06em; }
    .kind + .kind { border-left: 2px solid #000; }
    .kind[aria-selected="true"] { background: #000; color: #fff; }
    .kind:not([aria-selected="true"]):hover { background: #eee; }
    .kind .n { font-weight: 400; opacity: .7; margin-left: 3px; }
    .status { padding: 0 14px 8px; font-size: 12px; color: #555; }
    .toolbar { display: flex; gap: 6px; padding: 0 14px 10px; }
    input[type=search], input.text {
      flex: 1; min-width: 0; border: 2px solid #000; border-radius: 8px; padding: 7px 9px; font-size: 13px; background: #fff; color: #000;
    }
    .btn {
      border: 2px solid #000; border-radius: 8px; background: #000; color: #fff;
      padding: 6px 10px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; white-space: nowrap;
    }
    .btn.secondary { background: #fff; color: #000; }
    .btn:hover { opacity: .85; }
    .list { flex: 1; overflow-y: auto; padding: 0 10px 12px; }
    .folder { border: 2px solid #000; border-radius: 10px; margin: 0 0 10px; overflow: hidden; }
    .folder.unfiled { border-style: dashed; }
    .folder.drop { background: #f0f0f0; outline: 3px solid #000; outline-offset: -1px; }
    .fhead { display: flex; align-items: center; gap: 4px; padding: 6px 6px 6px 8px; background: #000; color: #fff; }
    .unfiled .fhead { background: #fff; color: #000; border-bottom: 2px dashed #000; }
    .folder.collapsed .fhead { border-bottom: 0; }
    .fname { flex: 1; min-width: 0; border: 0; background: none; text-align: left; padding: 2px 0;
      font-weight: 800; font-size: 13px; text-transform: uppercase; letter-spacing: .05em;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .caret { display: inline-block; width: 14px; transition: transform .12s; }
    .collapsed .caret { transform: rotate(-90deg); }
    .count { font-size: 11px; opacity: .75; padding: 0 4px; }
    .ficons { display: flex; }
    .ficons .icon { font-size: 13px; padding: 3px 5px; color: inherit; }
    .fhead .icon:hover { background: rgba(255,255,255,.2); }
    .unfiled .fhead .icon:hover { background: #eee; }
    .fhead input.text { border-color: #fff; padding: 4px 6px; }
    .rows { padding: 4px; }
    .collapsed .rows { display: none; }
    .empty { padding: 8px; font-size: 12px; color: #777; font-style: italic; }
    .hint { margin: 4px 14px; padding: 14px; border: 2px dashed #000; border-radius: 10px; font-size: 13px; line-height: 1.45; }
    .hint-wrap { flex: 1; }
    .row { display: flex; align-items: center; gap: 6px; padding: 5px 6px; border-radius: 7px; cursor: grab; }
    .row:hover { background: #f2f2f2; }
    .row.dragging { opacity: .4; }
    .row.drop-before { box-shadow: inset 0 3px 0 #000; }
    .grip { color: #999; font-size: 12px; user-select: none; }
    .who { flex: 1; min-width: 0; border: 0; background: none; text-align: left; padding: 0; }
    .who:hover .iname { text-decoration: underline; }
    .iname { display: block; font-size: 14px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .isub { display: block; font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: .05em;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .draft { font-size: 10px; border: 1px solid #999; border-radius: 4px; padding: 0 4px; margin-left: 4px; color: #666; font-weight: 400; }
    select.move { appearance: none; width: 28px; height: 26px; border: 1px solid #ccc; border-radius: 6px; background: #fff; color: #000; font-size: 14px; text-align: center; padding: 0; cursor: pointer; }
    select.move:hover { border-color: #000; }
    footer { display: flex; gap: 6px; padding: 10px 14px 14px; border-top: 2px solid #000; }
    footer .btn { flex: 1; }
    .toast {
      position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483647;
      max-width: min(420px, calc(100vw - 32px)); background: #000; color: #fff; padding: 10px 14px;
      border-radius: 10px; font-size: 13px; box-shadow: 0 4px 16px rgba(0,0,0,.3);
      display: flex; align-items: center; gap: 12px;
    }
    .toast-action { flex: none; border: 1px solid #fff; border-radius: 6px; background: none; color: #fff; padding: 4px 8px; font-size: 12px; font-weight: 700; }
    .toast-action:hover { background: #fff; color: #000; }
    @media (prefers-reduced-motion: reduce) { .drawer, .caret { transition: none; } }
  `;

  // ---- Mount ------------------------------------------------------------------

  const host = h('div', { id: 'msc-folders-root' });
  const root = host.attachShadow({ mode: 'open' });
  const tab = h('button', { class: 'tab', title: 'Folders (Alt+F)', onClick: () => setOpen(!ui.open) }, 'FOLDERS');
  const drawer = h('aside', { class: 'drawer', 'aria-label': 'Folders' });
  const toastSlot = h('div');
  root.append(h('style', {}, CSS), tab, drawer, toastSlot);

  // Keep keyboard/pointer input aimed at the panel away from the app, which
  // listens on the window for its own shortcuts and gestures.
  ['keydown', 'keyup', 'keypress', 'pointerdown', 'pointerup', 'pointermove', 'wheel', 'touchstart', 'touchmove', 'contextmenu']
    .forEach((type) => host.addEventListener(type, (e) => e.stopPropagation()));

  let toastTimer;
  const toast = (text, action = null) => {
    clearTimeout(toastTimer);
    toastSlot.replaceChildren(h('div', { class: 'toast', role: 'status' },
      h('span', {}, text),
      action && h('button', { class: 'toast-action', onClick: action.run }, action.label)));
    toastTimer = setTimeout(() => toastSlot.replaceChildren(), action ? 12000 : 4500);
  };

  const saveUi = () => chrome.storage.local.set({ [UI_KEY]: { open: ui.open, kind: ui.kind } });

  const setOpen = (open) => {
    ui.open = open;
    drawer.classList.toggle('open', open);
    tab.style.display = open ? 'none' : '';
    saveUi();
    if (open) render();
  };

  const setKind = (kind) => {
    if (kind === ui.kind) return;
    ui.kind = kind;
    ui.query = '';
    ui.editing = null;
    saveUi();
    render();
  };

  // ---- Rendering --------------------------------------------------------------

  const kindInfo = () => KINDS[ui.kind];
  const itemsOf = (kind) => Object.values(store.state.lists[kind].items);

  const matches = (c) => !ui.query || c.name.toLowerCase().includes(ui.query.toLowerCase());

  const statusText = () => {
    const { plural, singular, label } = kindInfo();
    const n = itemsOf(ui.kind).length;
    const count = `${n} ${n === 1 ? singular : plural}`;
    const s = store.state.lists[ui.kind].source;
    if (s === 'firestore') return `${count} from your account.`;
    if (s === 'cache') return `${count} (saved list; refreshes when the app loads them).`;
    if (s === 'local') return `${count} stored on this device.`;
    return store.state.uid
      ? `Waiting for the app to load your ${plural}. Try opening the ${label} screen.`
      : `Sign in to the app to see your ${plural}.`;
  };

  const commitEdit = () => {
    const name = ui.editValue.trim();
    const editing = ui.editing;
    ui.editing = null;
    ui.editValue = '';
    if (!name || !editing) {
      render();
      return;
    }
    if (editing.mode === 'new') store.addFolder(ui.kind, name);
    else store.renameFolder(ui.kind, editing.folderId, name);
  };

  const editInput = (placeholder) => {
    const input = h('input', {
      class: 'text',
      value: ui.editValue,
      placeholder,
      maxLength: 80,
      onInput: (e) => { ui.editValue = e.target.value; },
      onKeydown: (e) => {
        if (e.key === 'Enter') commitEdit();
        if (e.key === 'Escape') { ui.editing = null; render(); }
      },
      onBlur: () => { if (ui.editing) commitEdit(); },
    });
    queueMicrotask(() => { input.focus(); input.select(); });
    return input;
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fall back to the legacy copy command if the async API is refused.
      const area = h('textarea', { style: 'position:fixed;opacity:0' });
      area.value = text;
      root.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      if (!ok) throw new Error('copy failed');
    }
  };

  // The app's character list order: living before dead, then by name
  // (case-sensitive, by character code), then by class override.
  const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const appOrder = (a, b) =>
    (Number(!!a.dead) - Number(!!b.dead))
    || byCode(a.sortName ?? a.name, b.sortName ?? b.name)
    || byCode(a.classOverride || '', b.classOverride || '');

  const isCharacterKind = (kind) => kind === 'characters' || kind === 'npcs';

  const copyDetails = (details) => copyText(details).then(
    () => toast('Details copied. Paste them into your bug report.'),
    () => toast("Couldn't copy. Try again, or press Ctrl+C after selecting the text."));

  const openItem = async (item, event) => {
    const index = isCharacterKind(ui.kind)
      ? itemsOf(ui.kind).sort(appOrder).findIndex((c) => c.id === item.id)
      : null;
    // Shift+click copies what the extension can see, for bug reports.
    if (event && event.shiftKey) {
      await opener.ensureSemantics();
      copyDetails(opener.debugInfo(item.name, index));
      return;
    }
    let result;
    if (isCharacterKind(ui.kind)) {
      // Character cards don't expose names, so open by position in the list.
      result = await opener.openCard(index, item.name || `this ${kindInfo().singular}`);
    } else {
      // The tile may show the name or, for unnamed ships, the make and model.
      const names = [item.name, item.subtitle].filter(Boolean);
      if (!names.length) {
        toast(`This ${kindInfo().singular} has no name to look for. Open it from the app instead.`);
        return;
      }
      result = await opener.openItem(names, kindInfo().label);
    }
    if (!result.ok) {
      toast(result.reason, result.details && { label: 'Copy details', run: () => copyDetails(result.details) });
    }
  };

  const moveSelect = (item, currentFolderId) => {
    const kind = ui.kind;
    const folders = store.state.layouts[kind].folders;
    return h('select', {
      class: 'move',
      title: 'Move to folder',
      'aria-label': `Move ${item.name} to folder`,
      onChange: (e) => {
        const v = e.target.value;
        if (v === '__keep') return;
        if (v === '__new') {
          const name = prompt('New folder name');
          if (name && name.trim()) store.assign(kind, item.id, store.addFolder(kind, name.trim()).id);
          else render();
          return;
        }
        store.assign(kind, item.id, v === '__none' ? null : v);
      },
    },
    h('option', { value: '__keep', selected: true }, '⋯'),
    folders.filter((f) => f.id !== currentFolderId).map((f) => h('option', { value: f.id }, `Move to ${f.name}`)),
    currentFolderId ? h('option', { value: '__none' }, 'Remove from folder') : null,
    h('option', { value: '__new' }, 'New folder…'));
  };

  const itemRow = (item, folderId) => {
    const kind = ui.kind;
    const row = h('div', {
      class: 'row',
      draggable: 'true',
      dataset: { itemId: item.id },
      onDragstart: (e) => {
        ui.dragItemId = item.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', item.id);
        row.classList.add('dragging');
      },
      onDragend: () => {
        ui.dragItemId = null;
        row.classList.remove('dragging');
        root.querySelectorAll('.drop, .drop-before').forEach((el) => el.classList.remove('drop', 'drop-before'));
      },
      onDragover: (e) => {
        if (!ui.dragItemId || ui.dragItemId === item.id || !folderId) return;
        e.preventDefault();
        row.classList.add('drop-before');
      },
      onDragleave: () => row.classList.remove('drop-before'),
      onDrop: (e) => {
        if (!ui.dragItemId || !folderId) return;
        e.preventDefault();
        e.stopPropagation();
        store.assign(kind, ui.dragItemId, folderId, item.id);
      },
    },
    h('span', { class: 'grip', 'aria-hidden': 'true' }, '⋮⋮'),
    h('button', { class: 'who', title: 'Open in the app (Shift+click: copy details for a bug report)', onClick: (e) => openItem(item, e) },
      h('span', { class: 'iname' }, item.name || '(unnamed)', item.draft ? h('span', { class: 'draft' }, 'draft') : null),
      item.subtitle ? h('span', { class: 'isub' }, item.subtitle) : null),
    moveSelect(item, folderId));
    return row;
  };

  const folderSection = ({ id, name, collapsed, items, unfiled, index, total }) => {
    const kind = ui.kind;
    const { plural } = kindInfo();
    const isRenaming = ui.editing && ui.editing.mode === 'rename' && ui.editing.folderId === id;
    const section = h('section', {
      class: `folder${unfiled ? ' unfiled' : ''}${collapsed && !ui.query ? ' collapsed' : ''}`,
      onDragover: (e) => {
        if (!ui.dragItemId) return;
        e.preventDefault();
        section.classList.add('drop');
      },
      onDragleave: (e) => {
        if (!section.contains(e.relatedTarget)) section.classList.remove('drop');
      },
      onDrop: (e) => {
        if (!ui.dragItemId) return;
        e.preventDefault();
        store.assign(kind, ui.dragItemId, unfiled ? null : id);
      },
    });

    const head = h('div', { class: 'fhead' },
      isRenaming
        ? editInput('Folder name')
        : h('button', {
          class: 'fname',
          'aria-expanded': String(!collapsed),
          onClick: () => store.toggleFolder(kind, unfiled ? null : id),
        }, h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'), ` ${name}`),
      !isRenaming && h('span', { class: 'count' }, String(items.length)),
      !unfiled && !isRenaming && h('span', { class: 'ficons' },
        h('button', { class: 'icon', title: 'Move up', disabled: index === 0, onClick: () => store.moveFolder(kind, id, -1) }, '↑'),
        h('button', { class: 'icon', title: 'Move down', disabled: index === total - 1, onClick: () => store.moveFolder(kind, id, 1) }, '↓'),
        h('button', {
          class: 'icon',
          title: 'Rename',
          onClick: () => { ui.editing = { mode: 'rename', folderId: id }; ui.editValue = name; render(); },
        }, '✎'),
        h('button', {
          class: 'icon',
          title: `Delete folder (${plural} move to Unfiled)`,
          onClick: () => { if (confirm(`Delete folder "${name}"? Its ${plural} move to Unfiled.`)) store.deleteFolder(kind, id); },
        }, '✕')));

    const rows = h('div', { class: 'rows' },
      items.length
        ? items.map((item) => itemRow(item, unfiled ? null : id))
        : h('div', { class: 'empty' }, ui.query ? 'No matches.' : unfiled ? 'Everything is filed.' : `Drag ${plural} here.`));

    section.append(head, rows);
    return section;
  };

  // Like replaceChildren, but skips the false/null parts of conditional layouts
  // (replaceChildren would show them as text).
  const setDrawer = (...parts) => drawer.replaceChildren(...parts.filter(Boolean));

  // Pages without a list (Roll, Online, Settings…) get a pointer instead.
  const renderHint = () => {
    setDrawer(
      h('header', {},
        h('h1', {}, 'Folders'),
        h('button', { class: 'icon', title: 'Close (Alt+F)', 'aria-label': 'Close', onClick: () => setOpen(false) }, '✕')),
      h('div', { class: 'hint-wrap' },
        h('p', { class: 'hint' }, 'Open Characters, Ships or Maps in the app to see their folders.')),
      footer());
  };

  const footer = () => h('footer', {},
    h('button', { class: 'btn secondary', title: 'Download all your folders as a JSON backup', onClick: exportLayouts }, 'Export'),
    h('button', { class: 'btn secondary', title: 'Restore folders from a JSON backup', onClick: importLayouts }, 'Import'));

  const render = () => {
    if (!ui.open) return;
    if (page.state.available && !page.state.kind) {
      renderHint();
      return;
    }
    const kind = ui.kind;
    const layout = store.state.layouts[kind];
    const items = store.state.lists[kind].items;
    const filed = new Set();
    const sections = layout.folders.map((f, index) => {
      const inFolder = f.itemIds.map((id) => items[id]).filter(Boolean);
      inFolder.forEach((c) => filed.add(c.id));
      return { id: f.id, name: f.name, collapsed: f.collapsed, items: inFolder.filter(matches), index, total: layout.folders.length };
    });
    const unfiled = itemsOf(kind)
      .filter((c) => !filed.has(c.id))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    // Searching hides folders with no matches.
    const visible = ui.query ? sections.filter((s) => s.items.length) : sections;

    const list = h('div', { class: 'list' },
      ui.editing && ui.editing.mode === 'new'
        ? h('div', { class: 'toolbar' }, editInput('New folder name'))
        : null,
      visible.map(folderSection),
      folderSection({
        id: null,
        name: 'Unfiled',
        collapsed: layout.unfiledCollapsed,
        items: unfiled.filter(matches),
        unfiled: true,
      }));

    const prevScroll = drawer.querySelector('.list')?.scrollTop || 0;
    const searchFocused = root.activeElement && root.activeElement.type === 'search';

    const search = h('input', {
      type: 'search',
      placeholder: `Search ${kindInfo().plural}`,
      value: ui.query,
      'aria-label': `Search ${kindInfo().plural}`,
      onInput: (e) => { ui.query = e.target.value; render(); },
    });

    // Tabs only appear when the page can't be detected.
    const kindTabs = !page.state.available && h('div', { class: 'kinds', role: 'tablist' },
      Object.entries(KINDS).map(([k, info]) => h('button', {
        class: 'kind',
        role: 'tab',
        'aria-selected': String(k === kind),
        onClick: () => setKind(k),
      }, info.label, h('span', { class: 'n' }, String(itemsOf(k).length)))));

    setDrawer(
      h('header', {},
        h('h1', {}, page.state.available ? `${kindInfo().label} folders` : 'Folders'),
        h('button', { class: 'icon', title: 'Close (Alt+F)', 'aria-label': 'Close', onClick: () => setOpen(false) }, '✕')),
      kindTabs,
      h('div', { class: 'status' }, statusText()),
      h('div', { class: 'toolbar' },
        search,
        h('button', {
          class: 'btn',
          onClick: () => { ui.editing = { mode: 'new' }; ui.editValue = ''; render(); },
        }, '+ Folder')),
      list,
      footer());

    list.scrollTop = prevScroll;
    if (searchFocused) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }
  };

  // ---- Backup -----------------------------------------------------------------

  const exportLayouts = () => {
    const blob = new Blob([store.exportLayouts()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: 'mothership-folders.json' });
    root.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const importLayouts = () => {
    const input = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) return;
      try {
        if (!confirm('Replace your current folders with this backup?')) return;
        store.importLayouts(await file.text());
        toast('Folders restored.');
      } catch {
        toast("That file isn't a valid folders backup.");
      }
    });
    input.addEventListener('cancel', () => input.remove());
    root.append(input);
    input.click();
  };

  // ---- Boot -------------------------------------------------------------------

  const mount = () => {
    document.documentElement.append(host);
    chrome.storage.local.get(UI_KEY, (r) => {
      const saved = r[UI_KEY] || {};
      if (KINDS[saved.kind]) ui.kind = saved.kind;
      setOpen(!!saved.open);
    });
    window.addEventListener('keydown', (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'f' || e.key === 'F' || e.code === 'KeyF')) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(!ui.open);
      }
    }, true);
  };

  page.subscribe(({ kind }) => {
    if (kind && kind !== ui.kind) {
      ui.kind = kind;
      ui.query = '';
      ui.editing = null;
      saveUi();
    }
    render();
  });

  store.subscribe(() => {
    // Don't wipe a half-typed folder name when data arrives in the background.
    if (ui.editing) return;
    render();
  });
  store.init();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
