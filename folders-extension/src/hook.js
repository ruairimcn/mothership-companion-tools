// Runs in the page's own JavaScript world at document_start.
//
// The Flutter app loads the Firebase JS SDK lazily and assigns the Firestore
// module to `window.firebase_firestore`. We intercept that assignment and hand
// the app a copy of the module whose read/write functions also report any
// documents under `users/{uid}/{characters,ships,maps}` to the extension's
// content script.
//
// It also reads the app's local caches (used when signed out) so that all
// parsing of app data lives in this one file.
//
// This is strictly read-only: every call is forwarded unchanged, and results
// are returned to the app untouched. Nothing is ever written to Firestore.
(() => {
  'use strict';

  const SOURCE = 'msc-folders-hook';

  // How to read each kind of record, from Firestore or the local cache.
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const idOf = (id, d) => (typeof d.id === 'string' && d.id ? d.id : id);

  const KINDS = {
    characters: {
      localKey: 'flutter.CharacterPool',
      // The field updateDoc changes when the item is renamed.
      nameField: 'name',
      // Whether a stored object is a complete record of this kind.
      looksLike: (d) => 'mode' in d || 'strength' in d,
      summarize: (id, d) => ({
        id: idOf(id, d),
        name: text(d.name),
        subtitle: text(d.characterClassOverride) || text(d.characterClass),
        draft: d.creationComplete === false,
        // NPCs live in the same collection; the panel files them separately.
        npc: d.mode === 'npc',
      }),
    },
    ships: {
      localKey: 'flutter.ShipCubit',
      nameField: 'shipIdentifier',
      looksLike: (d) => 'hullMax' in d || 'shipIdentifier' in d,
      summarize: (id, d) => {
        const makeModel = [text(d.make), text(d.model)].filter(Boolean).join(' ');
        const ident = text(d.shipIdentifier);
        return {
          id: idOf(id, d),
          name: ident || makeModel,
          subtitle: ident ? makeModel || text(d.classString) : text(d.classString),
          draft: false,
        };
      },
    },
    maps: {
      localKey: 'flutter.MapCubit',
      nameField: 'title',
      looksLike: (d) => 'rooms' in d || 'routes' in d,
      summarize: (id, d) => ({
        id: idOf(id, d),
        name: text(d.title),
        subtitle: text(d.module),
        draft: false,
      }),
    },
  };

  const names = Object.keys(KINDS).join('|');
  const COLLECTION = new RegExp(`^users/([^/]+)/(${names})$`);
  const DOC = new RegExp(`^users/([^/]+)/(${names})/([^/]+)$`);

  const post = (msg) => window.postMessage({ source: SOURCE, ...msg }, window.location.origin);

  const safe = (fn) => {
    try {
      fn();
    } catch (err) {
      console.debug('[Mothership Folders] hook error', err);
    }
  };

  const pathOf = (ref) => {
    if (!ref) return null;
    if (typeof ref.path === 'string') return ref.path;
    // Queries built on a collection keep the base path internally.
    const q = ref._query;
    if (q && q.path && typeof q.path.canonicalString === 'function') return q.path.canonicalString();
    return null;
  };

  // Only the fields the panel needs leave this function; never full sheets.
  const summarize = (kind, id, data) => KINDS[kind].summarize(id, data || {});

  const reportQuerySnapshot = (target, snap) => safe(() => {
    if (!snap || !Array.isArray(snap.docs)) return;
    let path = pathOf(target);
    // Only a plain collection read is the complete list. Filtered queries
    // (e.g. a `where` on the collection) may be partial, so we upsert those.
    const isCompleteList = target && target.type === 'collection';
    if (!path && snap.docs.length) {
      const first = snap.docs[0].ref && snap.docs[0].ref.path;
      if (first) path = first.split('/').slice(0, -1).join('/');
    }
    const match = path && COLLECTION.exec(path);
    if (!match) return;
    const [, uid, kind] = match;
    const items = snap.docs.map((d) => summarize(kind, d.id, d.data()));
    post({ type: isCompleteList ? 'replace' : 'upsert', uid, kind, items });
  });

  const reportDocSnapshot = (snap) => safe(() => {
    const path = snap && snap.ref && snap.ref.path;
    const match = path && DOC.exec(path);
    if (!match) return;
    const [, uid, kind, id] = match;
    if (typeof snap.exists === 'function' && !snap.exists()) {
      post({ type: 'delete', uid, kind, ids: [id] });
    } else {
      post({ type: 'upsert', uid, kind, items: [summarize(kind, id, snap.data())] });
    }
  });

  const reportSnapshot = (target, snap) => {
    if (snap && Array.isArray(snap.docs)) reportQuerySnapshot(target, snap);
    else reportDocSnapshot(snap);
  };

  const wrapGet = (orig) => function (target, ...rest) {
    const result = orig.call(this, target, ...rest);
    if (result && typeof result.then === 'function') {
      result.then((snap) => reportSnapshot(target, snap), () => {});
    }
    return result;
  };

  // onSnapshot(ref, [options], onNext | observer, [onError], [onComplete])
  const wrapOnSnapshot = (orig) => function (target, ...rest) {
    const args = rest.slice();
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (typeof a === 'function') {
        args[i] = function (snap) {
          reportSnapshot(target, snap);
          return a.apply(this, arguments);
        };
        break;
      }
      if (a && typeof a.next === 'function') {
        const next = a.next;
        args[i] = Object.assign({}, a, {
          next(snap) {
            reportSnapshot(target, snap);
            return next.apply(a, arguments);
          },
        });
        break;
      }
    }
    return orig.call(this, target, ...args);
  };

  const wrapSetDoc = (orig) => function (ref, data, ...rest) {
    const result = orig.call(this, ref, data, ...rest);
    safe(() => {
      const match = DOC.exec(pathOf(ref) || '');
      if (!match || !data) return;
      const [, uid, kind, id] = match;
      // A partial merge may not include the name; skip those.
      if (KINDS[kind].looksLike(data)) post({ type: 'upsert', uid, kind, items: [summarize(kind, id, data)] });
    });
    return result;
  };

  const wrapUpdateDoc = (orig) => function (ref, data, ...rest) {
    const result = orig.call(this, ref, data, ...rest);
    safe(() => {
      const match = DOC.exec(pathOf(ref) || '');
      if (!match || !data || typeof data !== 'object') return;
      const [, uid, kind, id] = match;
      const name = data[KINDS[kind].nameField];
      if (typeof name === 'string' && name.trim()) post({ type: 'rename', uid, kind, id, name: name.trim() });
    });
    return result;
  };

  const wrapDeleteDoc = (orig) => function (ref, ...rest) {
    const result = orig.call(this, ref, ...rest);
    safe(() => {
      const match = DOC.exec(pathOf(ref) || '');
      if (match) post({ type: 'delete', uid: match[1], kind: match[2], ids: [match[3]] });
    });
    return result;
  };

  const WRAPPERS = {
    getDocs: wrapGet,
    getDocsFromServer: wrapGet,
    getDocsFromCache: wrapGet,
    getDoc: wrapGet,
    getDocFromServer: wrapGet,
    getDocFromCache: wrapGet,
    onSnapshot: wrapOnSnapshot,
    setDoc: wrapSetDoc,
    updateDoc: wrapUpdateDoc,
    deleteDoc: wrapDeleteDoc,
  };

  const instrument = (mod) => {
    if (!mod || typeof mod !== 'object') return mod;
    // ES module namespaces are read-only, so build a plain copy instead.
    const copy = Object.assign({}, mod);
    for (const [name, wrap] of Object.entries(WRAPPERS)) {
      if (typeof mod[name] === 'function') copy[name] = wrap(mod[name]);
    }
    post({ type: 'hook-ready' });
    return copy;
  };

  // ---- Local caches (signed-out data) -----------------------------------------

  // shared_preferences keeps the hydrated JSON as a JSON-encoded string.
  const readLocal = (kind) => {
    let value = window.localStorage.getItem(KINDS[kind].localKey);
    if (!value) return [];
    for (let i = 0; i < 3 && typeof value === 'string'; i++) value = JSON.parse(value);
    const out = [];
    const visit = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 4) return;
      if (typeof node.id === 'string' && KINDS[kind].looksLike(node)) {
        out.push(KINDS[kind].summarize(node.id, node));
        return;
      }
      Object.values(node).forEach((child) => visit(child, depth + 1));
    };
    visit(value, 0);
    return out;
  };

  const lastLocal = {};
  const reportLocal = () => {
    for (const kind of Object.keys(KINDS)) {
      safe(() => {
        const items = readLocal(kind);
        const key = JSON.stringify(items);
        if (key === lastLocal[kind]) return;
        lastLocal[kind] = key;
        post({ type: 'local', kind, items });
      });
    }
  };

  // ---- Install ------------------------------------------------------------------

  // Let the content script start listening before the first report.
  setTimeout(reportLocal, 0);
  setInterval(reportLocal, 5000);

  let current = window.firebase_firestore ? instrument(window.firebase_firestore) : undefined;
  try {
    Object.defineProperty(window, 'firebase_firestore', {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (value) => {
        current = instrument(value);
      },
    });
  } catch (err) {
    console.debug('[Mothership Folders] could not install Firestore hook', err);
  }
})();
