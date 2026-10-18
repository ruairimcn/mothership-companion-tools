// Shared state for the content script: the lists of characters, ships and
// maps (from the Firestore hook or the app's local cache) and the user's
// folder layout for each.
//
// Everything is kept in chrome.storage.local. Nothing is written to the app's
// own storage or to Firestore.
(() => {
  'use strict';

  const HOOK_SOURCE = 'msc-folders-hook';
  // What the panel calls each kind of record (parsing lives in hook.js).
  const KINDS = {
    characters: { label: 'Characters', singular: 'character', plural: 'characters' },
    ships: { label: 'Ships', singular: 'ship', plural: 'ships' },
    maps: { label: 'Maps', singular: 'map', plural: 'maps' },
  };
  const KIND_NAMES = Object.keys(KINDS);
  const LAYOUTS_KEY = 'layouts';
  const LEGACY_LAYOUT_KEY = 'layout'; // v0.1: characters only
  const itemsKey = (kind, uid) => `items:${kind}:${uid}`;

  const emptyLayout = () => ({ folders: [], unfiledCollapsed: false });
  const forEachKind = (fn) => Object.fromEntries(KIND_NAMES.map((k) => [k, fn(k)]));

  const listeners = new Set();
  const state = {
    uid: null, // signed-in Firebase user, or null
    hookReady: false,
    // kind -> { items: { id -> { id, name, subtitle, draft } }, source }
    // source: 'firestore' | 'cache' | 'local' | 'none'
    lists: forEachKind(() => ({ items: {}, source: 'none' })),
    // kind -> items from the app's local cache, reported by the hook
    locals: forEachKind(() => ({})),
    layouts: forEachKind(emptyLayout),
  };

  const emit = () => listeners.forEach((fn) => fn(state));
  const uuid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  const storageGet = (keys) => new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  const storageSet = (key, value) => new Promise((resolve) => chrome.storage.local.set({ [key]: value }, resolve));

  // ---- Item lists -------------------------------------------------------------

  const isValidItem = (c) => c && typeof c.id === 'string' && c.id && typeof c.name === 'string';

  const persistItems = (kind) => {
    const list = state.lists[kind];
    if (!state.uid || list.source !== 'firestore') return;
    storageSet(itemsKey(kind, state.uid), { items: list.items, savedAt: Date.now() });
  };

  // Show the app's local data for kinds that have nothing better.
  const applyLocal = (kind) => {
    const list = state.lists[kind];
    if (list.source !== 'none' && list.source !== 'local') return false;
    const local = state.locals[kind];
    const same = JSON.stringify(Object.keys(local).sort()) === JSON.stringify(Object.keys(list.items).sort());
    list.items = local;
    list.source = Object.keys(local).length ? 'local' : 'none';
    return !same;
  };

  // The signed-in user, from the Firebase Auth persistence the app already keeps.
  const readAuthUid = () => new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open('firebaseLocalStorageDb');
    } catch {
      resolve(null);
      return;
    }
    req.onerror = () => resolve(null);
    req.onupgradeneeded = () => {
      // The database doesn't exist yet; don't create it on the app's behalf.
      req.transaction.abort();
      resolve(null);
    };
    req.onsuccess = () => {
      const db = req.result;
      try {
        const all = db.transaction('firebaseLocalStorage', 'readonly').objectStore('firebaseLocalStorage').getAll();
        all.onsuccess = () => {
          const entry = (all.result || []).find((e) => String(e.fbase_key || '').startsWith('firebase:authUser:'));
          db.close();
          resolve(entry && entry.value && entry.value.uid ? entry.value.uid : null);
        };
        all.onerror = () => { db.close(); resolve(null); };
      } catch {
        db.close();
        resolve(null);
      }
    };
  });

  const setUid = async (uid) => {
    if (uid === state.uid) return;
    state.uid = uid;
    state.lists = forEachKind(() => ({ items: {}, source: 'none' }));
    const cached = uid ? await storageGet(KIND_NAMES.map((k) => itemsKey(k, uid))) : {};
    if (state.uid !== uid) return; // switched again while loading
    for (const kind of KIND_NAMES) {
      const list = state.lists[kind];
      const hit = cached[itemsKey(kind, uid)];
      if (hit && hit.items && list.source === 'none') {
        list.items = hit.items;
        list.source = 'cache';
      }
      applyLocal(kind);
    }
    emit();
  };

  const handleHookMessage = async (msg) => {
    if (msg.type === 'hook-ready') {
      state.hookReady = true;
      emit();
      return;
    }
    if (!KINDS[msg.kind]) return;
    if (msg.type === 'local' && Array.isArray(msg.items)) {
      state.locals[msg.kind] = {};
      msg.items.filter(isValidItem).forEach((c) => { state.locals[msg.kind][c.id] = c; });
      if (applyLocal(msg.kind)) emit();
      return;
    }
    if (typeof msg.uid !== 'string') return;
    // Documents read for another user (e.g. in a shared session) aren't yours.
    const authUid = await readAuthUid();
    if (authUid && msg.uid !== authUid) return;
    if (msg.uid !== state.uid) await setUid(msg.uid);

    const list = state.lists[msg.kind];
    if (msg.type === 'replace' && Array.isArray(msg.items)) {
      list.items = {};
      msg.items.filter(isValidItem).forEach((c) => { list.items[c.id] = c; });
    } else if (msg.type === 'upsert' && Array.isArray(msg.items)) {
      msg.items.filter(isValidItem).forEach((c) => { list.items[c.id] = c; });
    } else if (msg.type === 'rename' && list.items[msg.id] && typeof msg.name === 'string') {
      list.items[msg.id] = { ...list.items[msg.id], name: msg.name };
    } else if (msg.type === 'delete' && Array.isArray(msg.ids)) {
      msg.ids.forEach((id) => { delete list.items[id]; });
    } else {
      return;
    }
    list.source = 'firestore';
    persistItems(msg.kind);
    emit();
  };

  // Handle messages strictly in order; each one may await IndexedDB.
  let queue = Promise.resolve();
  const onHookMessage = (event) => {
    if (event.source !== window || !event.data || event.data.source !== HOOK_SOURCE) return;
    const msg = event.data;
    queue = queue.then(() => handleHookMessage(msg)).catch((err) => console.debug('[Mothership Folders]', err));
  };

  // ---- Folder layouts ---------------------------------------------------------

  const saveLayouts = () => storageSet(LAYOUTS_KEY, state.layouts);

  const sanitizeLayout = (raw) => {
    const folders = Array.isArray(raw && raw.folders) ? raw.folders : [];
    const seen = new Set();
    return {
      unfiledCollapsed: !!(raw && raw.unfiledCollapsed),
      folders: folders
        .filter((f) => f && typeof f.name === 'string')
        .map((f) => ({
          id: typeof f.id === 'string' && f.id ? f.id : uuid(),
          name: f.name.slice(0, 80),
          collapsed: !!f.collapsed,
          // v0.1 called this charIds.
          itemIds: (Array.isArray(f.itemIds) ? f.itemIds : Array.isArray(f.charIds) ? f.charIds : [])
            .filter((id) => typeof id === 'string' && !seen.has(id) && seen.add(id)),
        })),
    };
  };

  const sanitizeLayouts = (raw) => forEachKind((kind) => sanitizeLayout(raw && raw[kind]));

  const updateLayout = (kind, mutate) => {
    mutate(state.layouts[kind]);
    saveLayouts();
    emit();
  };

  const findFolder = (layout, folderId) => layout.folders.find((f) => f.id === folderId);

  const api = {
    state,
    kinds: KINDS,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    addFolder(kind, name) {
      const folder = { id: uuid(), name: name.slice(0, 80), collapsed: false, itemIds: [] };
      updateLayout(kind, (l) => l.folders.push(folder));
      return folder;
    },
    renameFolder(kind, folderId, name) {
      updateLayout(kind, (l) => {
        const f = findFolder(l, folderId);
        if (f) f.name = name.slice(0, 80);
      });
    },
    deleteFolder(kind, folderId) {
      updateLayout(kind, (l) => {
        l.folders = l.folders.filter((f) => f.id !== folderId);
      });
    },
    moveFolder(kind, folderId, delta) {
      updateLayout(kind, (l) => {
        const i = l.folders.findIndex((f) => f.id === folderId);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= l.folders.length) return;
        [l.folders[i], l.folders[j]] = [l.folders[j], l.folders[i]];
      });
    },
    // folderId null toggles the Unfiled section.
    toggleFolder(kind, folderId) {
      updateLayout(kind, (l) => {
        if (folderId === null) {
          l.unfiledCollapsed = !l.unfiledCollapsed;
          return;
        }
        const f = findFolder(l, folderId);
        if (f) f.collapsed = !f.collapsed;
      });
    },
    // Move an item into a folder (null = unfiled), optionally before another item.
    assign(kind, itemId, folderId, beforeItemId = null) {
      updateLayout(kind, (l) => {
        l.folders.forEach((f) => { f.itemIds = f.itemIds.filter((id) => id !== itemId); });
        const f = folderId && findFolder(l, folderId);
        if (!f) return;
        const at = beforeItemId ? f.itemIds.indexOf(beforeItemId) : -1;
        if (at >= 0) f.itemIds.splice(at, 0, itemId);
        else f.itemIds.push(itemId);
      });
    },

    exportLayouts() {
      // Names make the backup readable; they're ignored on import.
      const names = forEachKind((kind) => {
        const out = {};
        state.layouts[kind].folders.forEach((f) => f.itemIds.forEach((id) => {
          const item = state.lists[kind].items[id];
          if (item) out[id] = item.name;
        }));
        return out;
      });
      return JSON.stringify({ version: 2, layouts: state.layouts, names }, null, 2);
    },
    importLayouts(json) {
      const raw = JSON.parse(json);
      if (raw && raw.layouts) state.layouts = sanitizeLayouts(raw.layouts);
      else if (raw && Array.isArray(raw.folders)) state.layouts = { ...state.layouts, characters: sanitizeLayout(raw) };
      else throw new Error('Not a folders backup');
      saveLayouts();
      emit();
    },

    async refreshAuth() {
      const uid = await readAuthUid();
      const anyFromFirestore = KIND_NAMES.some((k) => state.lists[k].source === 'firestore');
      if (uid !== state.uid && (uid || !anyFromFirestore)) {
        await setUid(uid);
        return;
      }
    },

    async init() {
      window.addEventListener('message', onHookMessage);
      const stored = await storageGet([LAYOUTS_KEY, LEGACY_LAYOUT_KEY]);
      state.layouts = sanitizeLayouts(stored[LAYOUTS_KEY]);
      if (!stored[LAYOUTS_KEY] && stored[LEGACY_LAYOUT_KEY]) {
        // Carry over folders made with v0.1 (characters only).
        state.layouts.characters = sanitizeLayout(stored[LEGACY_LAYOUT_KEY]);
        await saveLayouts();
        chrome.storage.local.remove(LEGACY_LAYOUT_KEY);
      }
      await api.refreshAuth();
      emit();
      // Sign-in/out happens inside the app; poll cheaply to notice it.
      setInterval(() => api.refreshAuth(), 5000);
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[LAYOUTS_KEY] && changes[LAYOUTS_KEY].newValue) {
          state.layouts = sanitizeLayouts(changes[LAYOUTS_KEY].newValue);
          emit();
        }
      });
    },
  };

  window.MSCFolders = window.MSCFolders || {};
  window.MSCFolders.store = api;
})();
