// Runs in the page's own JavaScript world at document_start.
//
// The Flutter app loads the Firebase JS SDK lazily and assigns the Firestore
// module to `window.firebase_firestore`. We intercept that assignment and hand
// the app a copy of the module whose read/write functions also report any
// documents under `users/{uid}/characters` to the extension's content script.
//
// This is strictly read-only: every call is forwarded unchanged, and results
// are returned to the app untouched. Nothing is ever written to Firestore.
(() => {
  'use strict';

  const SOURCE = 'msc-folders-hook';
  const CHAR_COLLECTION = /^users\/([^/]+)\/characters$/;
  const CHAR_DOC = /^users\/([^/]+)\/characters\/([^/]+)$/;

  const post = (msg) => window.postMessage({ source: SOURCE, ...msg }, window.location.origin);

  // Keep only what the folder panel needs; never forward full character sheets.
  const summarize = (id, data) => ({
    id: data && typeof data.id === 'string' ? data.id : id,
    name: data && typeof data.name === 'string' ? data.name : '',
    characterClass: (data && (data.characterClassOverride || data.characterClass)) || '',
    creationComplete: !(data && data.creationComplete === false),
  });

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
    const match = path && CHAR_COLLECTION.exec(path);
    if (!match) return;
    const characters = snap.docs.map((d) => summarize(d.id, d.data()));
    post({ type: isCompleteList ? 'replace' : 'upsert', uid: match[1], characters });
  });

  const reportDocSnapshot = (snap) => safe(() => {
    const path = snap && snap.ref && snap.ref.path;
    const match = path && CHAR_DOC.exec(path);
    if (!match) return;
    if (typeof snap.exists === 'function' && !snap.exists()) {
      post({ type: 'delete', uid: match[1], ids: [match[2]] });
    } else {
      post({ type: 'upsert', uid: match[1], characters: [summarize(match[2], snap.data())] });
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
      const match = CHAR_DOC.exec(pathOf(ref) || '');
      // A partial merge may not include the name; skip those.
      if (match && data && typeof data.name === 'string') {
        post({ type: 'upsert', uid: match[1], characters: [summarize(match[2], data)] });
      }
    });
    return result;
  };

  const wrapUpdateDoc = (orig) => function (ref, data, ...rest) {
    const result = orig.call(this, ref, data, ...rest);
    safe(() => {
      const match = CHAR_DOC.exec(pathOf(ref) || '');
      if (match && data && typeof data === 'object' && typeof data.name === 'string') {
        post({ type: 'rename', uid: match[1], id: match[2], name: data.name });
      }
    });
    return result;
  };

  const wrapDeleteDoc = (orig) => function (ref, ...rest) {
    const result = orig.call(this, ref, ...rest);
    safe(() => {
      const match = CHAR_DOC.exec(pathOf(ref) || '');
      if (match) post({ type: 'delete', uid: match[1], ids: [match[2]] });
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
