// Opens a character in the app by "tapping" its tile.
//
// The app draws everything onto a canvas, so there's no DOM to click. Flutter
// can, however, build an accessibility tree of real elements (`flt-semantics`)
// with labels and tap handlers. We switch that on when needed, look for an
// element labelled with the character's name, and click it.
(() => {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const semanticsRoot = () => document.querySelector('flutter-view') || document.body;

  const semanticsEnabled = () => !!semanticsRoot().querySelector('flt-semantics');

  const ensureSemantics = async () => {
    if (semanticsEnabled()) return true;
    const placeholder = document.querySelector('flt-semantics-placeholder');
    if (!placeholder) return false;
    placeholder.click();
    for (let i = 0; i < 20 && !semanticsEnabled(); i++) await sleep(100);
    return semanticsEnabled();
  };

  const normalize = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

  const labelOf = (el) => el.getAttribute('aria-label') || el.textContent || '';

  const isTappable = (el) =>
    el.hasAttribute('flt-tappable') || el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link';

  // Find the most specific tappable element whose label contains the name as a
  // whole line (tiles usually read "Name\nClass\n…").
  const findTile = (name) => {
    const want = normalize(name);
    if (!want) return null;
    let best = null;
    for (const el of semanticsRoot().querySelectorAll('flt-semantics')) {
      const raw = labelOf(el);
      const lines = raw.split(/\n+/).map(normalize);
      if (!lines.includes(want) && normalize(raw) !== want) continue;
      const target = isTappable(el) ? el : el.closest('[flt-tappable], [role="button"], [role="link"]');
      if (!target) continue;
      const len = labelOf(target).length;
      if (!best || len < best.len) best = { el: target, len };
    }
    return best && best.el;
  };

  const scrollables = () =>
    [...semanticsRoot().querySelectorAll('flt-semantics')].filter((el) => {
      const style = getComputedStyle(el);
      return /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 2;
    });

  // Lists are built lazily, so an off-screen tile may not exist yet. Scroll
  // each scrollable region from the top until the tile shows up.
  const scrollToFind = async (name) => {
    for (const region of scrollables()) {
      region.scrollTop = 0;
      await sleep(150);
      for (let step = 0; step < 40; step++) {
        const tile = findTile(name);
        if (tile) return tile;
        const before = region.scrollTop;
        region.scrollTop = before + Math.max(80, region.clientHeight * 0.8);
        await sleep(150);
        if (region.scrollTop === before) break;
      }
    }
    return findTile(name);
  };

  const openCharacter = async (name) => {
    if (!(await ensureSemantics())) {
      return { ok: false, reason: "Couldn't switch on the app's accessibility layer." };
    }
    await sleep(50);
    const tile = findTile(name) || (await scrollToFind(name));
    if (!tile) {
      return { ok: false, reason: `Couldn't find "${name}" on screen. Open the app's character list first, then try again.` };
    }
    tile.scrollIntoView({ block: 'center' });
    tile.click();
    return { ok: true };
  };

  window.MSCFolders = window.MSCFolders || {};
  window.MSCFolders.opener = { openCharacter, ensureSemantics };
})();
