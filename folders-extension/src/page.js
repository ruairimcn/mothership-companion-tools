// Works out which list the app is showing (characters, NPCs, ships or maps)
// so the drawer can show the matching folders.
//
// The app's navigation doesn't change the URL, so this reads the
// accessibility tree instead: the Characters screen has "PLAYER CHARACTERS" /
// "NPCS" tabs, and every list shows the names of the items in it.
(() => {
  'use strict';

  const { store, opener } = window.MSCFolders;
  const POLL_MS = 700;
  const CHARACTER_TABS = { 'player characters': 'characters', npcs: 'npcs' };

  const listeners = new Set();
  const state = {
    // false until the accessibility tree is on; until then the drawer can't
    // tell which page is showing and lets the user pick.
    available: false,
    kind: null, // the detected kind, or null on pages without a list
  };

  // Every piece of text on screen, normalised, line by line.
  const screenTexts = (nodes) => {
    const texts = new Set();
    for (const el of nodes) {
      const label = opener.ownLabel(el);
      if (!label) continue;
      texts.add(opener.normalize(label));
      label.split(/\n+/).forEach((line) => texts.add(opener.normalize(line)));
    }
    return texts;
  };

  // How many of a kind's items are named on screen.
  const score = (kind, texts) =>
    Object.values(store.state.lists[kind].items)
      .filter((item) => item.name && texts.has(opener.normalize(item.name))).length;

  const detect = () => {
    const nodes = opener.semanticsNodes();
    if (!nodes.length) return { available: false, kind: null };
    const texts = screenTexts(nodes);

    // On the Characters screen, the selected tab says which list is showing.
    if (Object.keys(CHARACTER_TABS).every((t) => texts.has(t))) {
      for (const el of nodes) {
        const tab = CHARACTER_TABS[opener.normalize(opener.ownLabel(el))];
        if (tab && el.getAttribute('aria-selected') === 'true') return { available: true, kind: tab };
      }
      const npcs = score('npcs', texts);
      return { available: true, kind: npcs > score('characters', texts) ? 'npcs' : 'characters' };
    }

    // Elsewhere, go by whose names are showing (a list or an open sheet).
    let best = null;
    let bestScore = 0;
    for (const kind of Object.keys(store.kinds)) {
      const s = score(kind, texts);
      if (s > bestScore) {
        best = kind;
        bestScore = s;
      }
    }
    return { available: true, kind: best };
  };

  // Require the same answer twice in a row so brief in-between frames
  // (page transitions) don't flicker the drawer.
  let pending = null;
  const tick = async () => {
    // The tree only exists once switched on; do that as soon as the app has
    // drawn its first frame (the placeholder appears then).
    if (!opener.semanticsNodes().length && document.querySelector('flt-semantics-placeholder')) {
      await opener.ensureSemantics();
    }
    const next = detect();
    const key = `${next.available}:${next.kind}`;
    if (key !== `${state.available}:${state.kind}` && key === pending) {
      Object.assign(state, next);
      listeners.forEach((fn) => fn(state));
    }
    pending = key;
  };

  setInterval(tick, POLL_MS);

  window.MSCFolders.page = {
    state,
    detect,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
})();
