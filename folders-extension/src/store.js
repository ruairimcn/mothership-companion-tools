// Shared state for the content script: the character list (from the Firestore
// hook or the app's local cache) and the user's folder layout.
//
// Everything is kept in chrome.storage.local. Nothing is written to the app's
// own storage or to Firestore.
(() => {
  'use strict';

  const HOOK_SOURCE = 'msc-folders-hook';
  const LAYOUT_KEY = 'layout';
  const charsKey = (uid) => `chars:${uid}`;

  const listeners = new Set();
  const state = {
    uid: null, // signed-in Firebase user, or null
    hookReady: false,
    characters: {}, // id -> { id, name, characterClass, creationComplete }
    source: 'none', // 'firestore' | 'cache' | 'local' | 'none'
    layout: { version: 1, folders: [], unfiledCollapsed: false },
  };

  const emit = () => listeners.forEach((fn) => fn(state));
  const uuid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

  const storageGet = (key) => new Promise((resolve) => chrome.storage.local.get(key, (r) => resolve(r[key])));
  const storageSet = (key, value) => new Promise((resolve) => chrome.storage.local.set({ [key]: value }, resolve));

  // ---- Character list -------------------------------------------------------

  const isValidChar = (c) => c && typeof c.id === 'string' && c.id && typeof c.name === 'string';

  const persistChars = () => {
    if (!state.uid || state.source !== 'firestore') return;
    storageSet(charsKey(state.uid), { characters: state.characters, savedAt: Date.now() });
  };

  // The app's local character pool (used for signed-out / not-yet-synced data).
  // shared_preferences stores the hydrated JSON as a JSON-encoded string.
  const readLocalPool = () => {
    try {
      let value = window.localStorage.getItem('flutter.CharacterPool');
      if (!value) return {};
      for (let i = 0; i < 3 && typeof value === 'string'; i++) value = JSON.parse(value);
      const out = {};
      const visit = (node, depth) => {
        if (!node || typeof node !== 'object' || depth > 4) return;
        if (typeof node.id === 'string' && typeof node.name === 'string' && ('mode' in node || 'strength' in node)) {
          out[node.id] = {
            id: node.id,
            name: node.name,
            characterClass: node.characterClassOverride || node.characterClass || '',
            creationComplete: node.creationComplete !== false,
          };
          return;
        }
        Object.values(node).forEach((child) => visit(child, depth + 1));
      };
      visit(value, 0);
      return out;
    } catch {
      return {};
    }
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
    state.characters = {};
    state.source = 'none';
    if (uid) {
      const cached = await storageGet(charsKey(uid));
      if (cached && cached.characters && state.uid === uid && state.source === 'none') {
        state.characters = cached.characters;
        state.source = 'cache';
      }
    }
    if (state.source === 'none') {
      const local = readLocalPool();
      if (Object.keys(local).length) {
        state.characters = local;
        state.source = 'local';
      }
    }
    emit();
  };

  const handleHookMessage = async (msg) => {
    if (msg.type === 'hook-ready') {
      state.hookReady = true;
      emit();
      return;
    }
    if (typeof msg.uid !== 'string') return;
    // Documents read for another user (e.g. in a shared session) aren't yours.
    const authUid = await readAuthUid();
    if (authUid && msg.uid !== authUid) return;
    if (msg.uid !== state.uid) await setUid(msg.uid);

    if (msg.type === 'replace' && Array.isArray(msg.characters)) {
      state.characters = {};
      msg.characters.filter(isValidChar).forEach((c) => { state.characters[c.id] = c; });
    } else if (msg.type === 'upsert' && Array.isArray(msg.characters)) {
      msg.characters.filter(isValidChar).forEach((c) => { state.characters[c.id] = c; });
    } else if (msg.type === 'rename' && state.characters[msg.id] && typeof msg.name === 'string') {
      state.characters[msg.id] = { ...state.characters[msg.id], name: msg.name };
    } else if (msg.type === 'delete' && Array.isArray(msg.ids)) {
      msg.ids.forEach((id) => { delete state.characters[id]; });
    } else {
      return;
    }
    state.source = 'firestore';
    persistChars();
    emit();
  };

  // Handle messages strictly in order; each one may await IndexedDB.
  let queue = Promise.resolve();
  const onHookMessage = (event) => {
    if (event.source !== window || !event.data || event.data.source !== HOOK_SOURCE) return;
    const msg = event.data;
    queue = queue.then(() => handleHookMessage(msg)).catch((err) => console.debug('[Mothership Folders]', err));
  };

  // ---- Folder layout ----------------------------------------------------------

  const saveLayout = () => storageSet(LAYOUT_KEY, state.layout);

  const sanitizeLayout = (raw) => {
    const folders = Array.isArray(raw && raw.folders) ? raw.folders : [];
    const seen = new Set();
    return {
      version: 1,
      unfiledCollapsed: !!(raw && raw.unfiledCollapsed),
      folders: folders
        .filter((f) => f && typeof f.name === 'string')
        .map((f) => ({
          id: typeof f.id === 'string' && f.id ? f.id : uuid(),
          name: f.name.slice(0, 80),
          collapsed: !!f.collapsed,
          charIds: (Array.isArray(f.charIds) ? f.charIds : [])
            .filter((id) => typeof id === 'string' && !seen.has(id) && seen.add(id)),
        })),
    };
  };

  const updateLayout = (mutate) => {
    mutate(state.layout);
    saveLayout();
    emit();
  };

  const removeFromAllFolders = (layout, charId) => {
    layout.folders.forEach((f) => {
      f.charIds = f.charIds.filter((id) => id !== charId);
    });
  };

  const api = {
    state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },

    folderOf(charId) {
      return state.layout.folders.find((f) => f.charIds.includes(charId)) || null;
    },

    addFolder(name) {
      const folder = { id: uuid(), name: name.slice(0, 80), collapsed: false, charIds: [] };
      updateLayout((l) => l.folders.push(folder));
      return folder;
    },
    renameFolder(folderId, name) {
      updateLayout((l) => {
        const f = l.folders.find((x) => x.id === folderId);
        if (f) f.name = name.slice(0, 80);
      });
    },
    deleteFolder(folderId) {
      updateLayout((l) => {
        l.folders = l.folders.filter((f) => f.id !== folderId);
      });
    },
    moveFolder(folderId, delta) {
      updateLayout((l) => {
        const i = l.folders.findIndex((f) => f.id === folderId);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= l.folders.length) return;
        [l.folders[i], l.folders[j]] = [l.folders[j], l.folders[i]];
      });
    },
    toggleFolder(folderId) {
      updateLayout((l) => {
        if (folderId === null) {
          l.unfiledCollapsed = !l.unfiledCollapsed;
          return;
        }
        const f = l.folders.find((x) => x.id === folderId);
        if (f) f.collapsed = !f.collapsed;
      });
    },
    // Move a character into a folder (null = unfiled), optionally before another character.
    assign(charId, folderId, beforeCharId = null) {
      updateLayout((l) => {
        removeFromAllFolders(l, charId);
        const f = folderId && l.folders.find((x) => x.id === folderId);
        if (!f) return;
        const at = beforeCharId ? f.charIds.indexOf(beforeCharId) : -1;
        if (at >= 0) f.charIds.splice(at, 0, charId);
        else f.charIds.push(charId);
      });
    },

    exportLayout() {
      const names = {};
      state.layout.folders.forEach((f) => f.charIds.forEach((id) => {
        if (state.characters[id]) names[id] = state.characters[id].name;
      }));
      return JSON.stringify({ ...state.layout, characterNames: names }, null, 2);
    },
    importLayout(json) {
      const parsed = sanitizeLayout(JSON.parse(json));
      state.layout = parsed;
      saveLayout();
      emit();
    },

    async refreshAuth() {
      const uid = await readAuthUid();
      if (uid !== state.uid && (uid || state.source !== 'firestore')) await setUid(uid);
      else if (!uid && state.source !== 'firestore') {
        // Signed out: show whatever the app keeps locally.
        const local = readLocalPool();
        const changed = JSON.stringify(Object.keys(local).sort()) !== JSON.stringify(Object.keys(state.characters).sort());
        if (changed) {
          state.characters = local;
          state.source = Object.keys(local).length ? 'local' : 'none';
          emit();
        }
      }
    },

    async init() {
      window.addEventListener('message', onHookMessage);
      state.layout = sanitizeLayout(await storageGet(LAYOUT_KEY));
      await api.refreshAuth();
      emit();
      // Sign-in/out happens inside the app; poll cheaply to notice it.
      setInterval(() => api.refreshAuth(), 5000);
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes[LAYOUT_KEY] && changes[LAYOUT_KEY].newValue) {
          state.layout = sanitizeLayout(changes[LAYOUT_KEY].newValue);
          emit();
        }
      });
    },
  };

  window.MSCFolders = window.MSCFolders || {};
  window.MSCFolders.store = api;
})();
