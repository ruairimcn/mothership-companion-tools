// The folder drawer: a slide-out panel drawn over the app in a shadow root so
// the app's styles and ours can't interfere with each other.
(() => {
  'use strict';

  const { store, opener } = window.MSCFolders;
  const UI_KEY = 'ui';

  const ui = {
    open: false,
    query: '',
    editing: null, // { kind: 'new' } | { kind: 'rename', folderId }
    editValue: '',
    dragCharId: null,
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
    .row { display: flex; align-items: center; gap: 6px; padding: 5px 6px; border-radius: 7px; cursor: grab; }
    .row:hover { background: #f2f2f2; }
    .row.dragging { opacity: .4; }
    .row.drop-before { box-shadow: inset 0 3px 0 #000; }
    .grip { color: #999; font-size: 12px; user-select: none; }
    .who { flex: 1; min-width: 0; border: 0; background: none; text-align: left; padding: 0; }
    .who:hover .cname { text-decoration: underline; }
    .cname { display: block; font-size: 14px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .cclass { display: block; font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: .05em; }
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
  const tab = h('button', { class: 'tab', title: 'Character folders (Alt+F)', onClick: () => setOpen(!ui.open) }, 'FOLDERS');
  const drawer = h('aside', { class: 'drawer', 'aria-label': 'Character folders' });
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

  const setOpen = (open) => {
    ui.open = open;
    drawer.classList.toggle('open', open);
    tab.style.display = open ? 'none' : '';
    chrome.storage.local.set({ [UI_KEY]: { open } });
    if (open) render();
  };

  // ---- Rendering --------------------------------------------------------------

  const characterList = () => Object.values(store.state.characters);

  const matches = (c) => !ui.query || c.name.toLowerCase().includes(ui.query.toLowerCase());

  const statusText = () => {
    const n = characterList().length;
    const s = store.state.source;
    if (s === 'firestore') return `${n} character${n === 1 ? '' : 's'} from your account.`;
    if (s === 'cache') return `${n} character${n === 1 ? '' : 's'} (saved list; refreshes when the app loads them).`;
    if (s === 'local') return `${n} character${n === 1 ? '' : 's'} stored on this device.`;
    return store.state.uid
      ? 'Waiting for the app to load your characters. Try opening the Characters screen.'
      : 'Sign in to the app to see your characters.';
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
    if (editing.kind === 'new') store.addFolder(name);
    else store.renameFolder(editing.folderId, name);
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

  const openCharacter = async (c) => {
    const result = await opener.openCharacter(c.name);
    if (!result.ok) {
      toast(result.reason, result.details && {
        label: 'Copy details',
        run: () => copyText(result.details).then(
          () => toast('Details copied. Paste them into your bug report.'),
          () => toast("Couldn't copy. Try again, or press Ctrl+C after selecting the text.")),
      });
    }
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

  const moveSelect = (c, currentFolderId) => {
    const folders = store.state.layout.folders;
    return h('select', {
      class: 'move',
      title: 'Move to folder',
      'aria-label': `Move ${c.name} to folder`,
      onChange: (e) => {
        const v = e.target.value;
        if (v === '__keep') return;
        if (v === '__new') {
          const name = prompt('New folder name');
          if (name && name.trim()) store.assign(c.id, store.addFolder(name.trim()).id);
          else render();
          return;
        }
        store.assign(c.id, v === '__none' ? null : v);
      },
    },
    h('option', { value: '__keep', selected: true }, '⋯'),
    folders.filter((f) => f.id !== currentFolderId).map((f) => h('option', { value: f.id }, `Move to ${f.name}`)),
    currentFolderId ? h('option', { value: '__none' }, 'Remove from folder') : null,
    h('option', { value: '__new' }, 'New folder…'));
  };

  const characterRow = (c, folderId) => {
    const row = h('div', {
      class: 'row',
      draggable: 'true',
      dataset: { charId: c.id },
      onDragstart: (e) => {
        ui.dragCharId = c.id;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', c.id);
        row.classList.add('dragging');
      },
      onDragend: () => {
        ui.dragCharId = null;
        row.classList.remove('dragging');
        root.querySelectorAll('.drop, .drop-before').forEach((el) => el.classList.remove('drop', 'drop-before'));
      },
      onDragover: (e) => {
        if (!ui.dragCharId || ui.dragCharId === c.id || !folderId) return;
        e.preventDefault();
        row.classList.add('drop-before');
      },
      onDragleave: () => row.classList.remove('drop-before'),
      onDrop: (e) => {
        if (!ui.dragCharId || !folderId) return;
        e.preventDefault();
        e.stopPropagation();
        store.assign(ui.dragCharId, folderId, c.id);
      },
    },
    h('span', { class: 'grip', 'aria-hidden': 'true' }, '⋮⋮'),
    h('button', { class: 'who', title: 'Open in the app', onClick: () => openCharacter(c) },
      h('span', { class: 'cname' }, c.name || '(unnamed)', c.creationComplete ? null : h('span', { class: 'draft' }, 'draft')),
      c.characterClass ? h('span', { class: 'cclass' }, c.characterClass) : null),
    moveSelect(c, folderId));
    return row;
  };

  const folderSection = ({ id, name, collapsed, chars, unfiled, index, total }) => {
    const isRenaming = ui.editing && ui.editing.kind === 'rename' && ui.editing.folderId === id;
    const section = h('section', {
      class: `folder${unfiled ? ' unfiled' : ''}${collapsed && !ui.query ? ' collapsed' : ''}`,
      onDragover: (e) => {
        if (!ui.dragCharId) return;
        e.preventDefault();
        section.classList.add('drop');
      },
      onDragleave: (e) => {
        if (!section.contains(e.relatedTarget)) section.classList.remove('drop');
      },
      onDrop: (e) => {
        if (!ui.dragCharId) return;
        e.preventDefault();
        store.assign(ui.dragCharId, unfiled ? null : id);
      },
    });

    const head = h('div', { class: 'fhead' },
      isRenaming
        ? editInput('Folder name')
        : h('button', {
          class: 'fname',
          'aria-expanded': String(!collapsed),
          onClick: () => store.toggleFolder(unfiled ? null : id),
        }, h('span', { class: 'caret', 'aria-hidden': 'true' }, '▾'), ` ${name}`),
      !isRenaming && h('span', { class: 'count' }, String(chars.length)),
      !unfiled && !isRenaming && h('span', { class: 'ficons' },
        h('button', { class: 'icon', title: 'Move up', disabled: index === 0, onClick: () => store.moveFolder(id, -1) }, '↑'),
        h('button', { class: 'icon', title: 'Move down', disabled: index === total - 1, onClick: () => store.moveFolder(id, 1) }, '↓'),
        h('button', {
          class: 'icon',
          title: 'Rename',
          onClick: () => { ui.editing = { kind: 'rename', folderId: id }; ui.editValue = name; render(); },
        }, '✎'),
        h('button', {
          class: 'icon',
          title: 'Delete folder (characters move to Unfiled)',
          onClick: () => { if (confirm(`Delete folder "${name}"? Its characters move to Unfiled.`)) store.deleteFolder(id); },
        }, '✕')));

    const rows = h('div', { class: 'rows' },
      chars.length
        ? chars.map((c) => characterRow(c, unfiled ? null : id))
        : h('div', { class: 'empty' }, ui.query ? 'No matches.' : unfiled ? 'Everything is filed.' : 'Drag characters here.'));

    section.append(head, rows);
    return section;
  };

  const render = () => {
    if (!ui.open) return;
    const { layout, characters } = store.state;
    const filed = new Set();
    const sections = layout.folders.map((f, index) => {
      const chars = f.charIds.map((id) => characters[id]).filter(Boolean);
      chars.forEach((c) => filed.add(c.id));
      return { id: f.id, name: f.name, collapsed: f.collapsed, chars: chars.filter(matches), index, total: layout.folders.length };
    });
    const unfiled = characterList()
      .filter((c) => !filed.has(c.id))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    // Searching hides folders with no matches.
    const visible = ui.query ? sections.filter((s) => s.chars.length) : sections;

    const list = h('div', { class: 'list' },
      ui.editing && ui.editing.kind === 'new'
        ? h('div', { class: 'toolbar' }, editInput('New folder name'))
        : null,
      visible.map(folderSection),
      folderSection({
        id: null,
        name: 'Unfiled',
        collapsed: layout.unfiledCollapsed,
        chars: unfiled.filter(matches),
        unfiled: true,
      }));

    const prevScroll = drawer.querySelector('.list')?.scrollTop || 0;
    const searchFocused = root.activeElement && root.activeElement.type === 'search';

    const search = h('input', {
      type: 'search',
      placeholder: 'Search characters',
      value: ui.query,
      'aria-label': 'Search characters',
      onInput: (e) => { ui.query = e.target.value; render(); },
    });

    drawer.replaceChildren(
      h('header', {},
        h('h1', {}, 'Folders'),
        h('button', { class: 'icon', title: 'Close (Alt+F)', 'aria-label': 'Close', onClick: () => setOpen(false) }, '✕')),
      h('div', { class: 'status' }, statusText()),
      h('div', { class: 'toolbar' },
        search,
        h('button', {
          class: 'btn',
          onClick: () => { ui.editing = { kind: 'new' }; ui.editValue = ''; render(); },
        }, '+ Folder')),
      list,
      h('footer', {},
        h('button', { class: 'btn secondary', title: 'Download your folders as a JSON backup', onClick: exportLayout }, 'Export'),
        h('button', { class: 'btn secondary', title: 'Restore folders from a JSON backup', onClick: importLayout }, 'Import')));

    list.scrollTop = prevScroll;
    if (searchFocused) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }
  };

  // ---- Backup -----------------------------------------------------------------

  const exportLayout = () => {
    const blob = new Blob([store.exportLayout()], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: 'mothership-folders.json' });
    root.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const importLayout = () => {
    const input = h('input', { type: 'file', accept: 'application/json,.json' });
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        if (!confirm('Replace your current folders with this backup?')) return;
        store.importLayout(await file.text());
        toast('Folders restored.');
      } catch {
        toast("That file isn't a valid folders backup.");
      }
    });
    input.click();
  };

  // ---- Boot -------------------------------------------------------------------

  const mount = () => {
    document.documentElement.append(host);
    chrome.storage.local.get(UI_KEY, (r) => setOpen(!!(r[UI_KEY] && r[UI_KEY].open)));
    window.addEventListener('keydown', (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'f' || e.key === 'F' || e.code === 'KeyF')) {
        e.preventDefault();
        e.stopPropagation();
        setOpen(!ui.open);
      }
    }, true);
  };

  store.subscribe(() => {
    // Don't wipe a half-typed folder name when data arrives in the background.
    if (ui.editing) return;
    render();
  });
  store.init();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
