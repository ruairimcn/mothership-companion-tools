// Opens a character in the app by "tapping" its tile.
//
// The app draws everything onto a canvas, so there's no DOM to click. Flutter
// can, however, build an accessibility tree of real elements (`flt-semantics`)
// with labels and tap handlers. We switch that on when needed, look for an
// element labelled with the character's name, and click it.
(() => {
  'use strict';

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const TAPPABLE = '[flt-tappable], [role="button"], [role="link"], [role="menuitem"], [role="tab"]';

  // The semantics tree normally lives in the light DOM, but look inside the
  // Flutter view's shadow root too in case a future engine moves it there.
  const semanticsNodes = () => {
    const nodes = [...document.querySelectorAll('flt-semantics')];
    for (const host of document.querySelectorAll('flutter-view, flt-glass-pane')) {
      if (host.shadowRoot) nodes.push(...host.shadowRoot.querySelectorAll('flt-semantics'));
    }
    return nodes;
  };

  const ensureSemantics = async () => {
    if (semanticsNodes().length) return true;
    const placeholder = document.querySelector('flt-semantics-placeholder');
    if (!placeholder) return false;
    placeholder.click();
    for (let i = 0; i < 30 && !semanticsNodes().length; i++) await sleep(100);
    return semanticsNodes().length > 0;
  };

  const normalize = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // The input element of a text field node, if it is one. Text fields keep
  // their text in the input's value rather than in a label.
  const fieldInput = (el) =>
    [...el.children].find((c) => c.tagName === 'INPUT' || c.tagName === 'TEXTAREA') || null;

  // A node's own text: its aria-label, its field's value, and its text
  // excluding child nodes (whose text belongs to them, not to this node).
  const ownLabel = (el) => {
    const parts = [el.getAttribute('aria-label') || ''];
    const input = fieldInput(el);
    if (input) parts.push(input.value || input.getAttribute('value') || '');
    parts.push([...el.childNodes]
      .filter((n) => n.nodeType === Node.TEXT_NODE || (n.nodeType === Node.ELEMENT_NODE && !/^(FLT-SEMANTICS|INPUT|TEXTAREA)/.test(n.tagName)))
      .map((n) => n.textContent)
      .join('\n'));
    return parts.filter((p) => p.trim()).join('\n');
  };

  const isTextField = (el) => !!fieldInput(el) || el.getAttribute('role') === 'textbox';

  const isTappable = (el) => el.matches(TAPPABLE);

  // How well a label matches the name: 3 = the whole label, 2 = a whole line,
  // 1 = the name as separate word(s) inside the label, 0 = no match.
  const matchScore = (label, want, wordRe) => {
    const norm = normalize(label);
    if (!norm) return 0;
    if (norm === want) return 3;
    if (label.split(/\n+/).map(normalize).includes(want)) return 2;
    return wordRe.test(norm) ? 1 : 0;
  };

  // Screen-sized tappables are background handlers (e.g. "tap to dismiss"),
  // never a tile, so skip past them.
  const isScreenSized = (el) => {
    const r = el.getBoundingClientRect();
    return r.width * r.height > 0.5 * window.innerWidth * window.innerHeight;
  };

  // How to tap a matching node. Returns { el } to click a semantics element,
  // or { el, x, y } to tap that point on the screen, or null.
  //   - a tappable node: click it
  //   - otherwise its nearest tappable ancestor (e.g. the card around a label)
  //   - or, for a card whose label sits outside its button, its only tappable child
  // A text field (like the boxed names on character cards) would just start
  // editing if clicked, so for those we tap the card just above the field.
  const tapTargetFor = (el) => {
    const field = isTextField(el);
    if (!field && isTappable(el) && !isScreenSized(el)) return { el };
    for (let up = el.parentElement && el.parentElement.closest(TAPPABLE); up; up = up.parentElement && up.parentElement.closest(TAPPABLE)) {
      if (!isScreenSized(up)) return { el: up };
    }
    if (field) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { el, x: r.left + r.width / 2, y: Math.max(0, r.top - Math.min(8, r.height / 3)) };
    }
    const down = el.querySelectorAll(TAPPABLE);
    return down.length === 1 ? { el: down[0] } : null;
  };

  const findTile = (name) => {
    const want = normalize(name);
    if (!want) return null;
    const wordRe = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(want)}($|[^\\p{L}\\p{N}])`, 'u');
    let best = null;
    for (const el of semanticsNodes()) {
      const score = matchScore(ownLabel(el), want, wordRe);
      if (!score) continue;
      const target = tapTargetFor(el);
      if (!target) continue;
      // Prefer the best match, then the most specific (shortest) label.
      const len = (target.el.textContent || '').length;
      if (!best || score > best.score || (score === best.score && len < best.len)) best = { target, score, len };
    }
    return best && best.target;
  };

  const scrollables = () =>
    semanticsNodes().filter((el) => {
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

  // Send a mouse tap to whatever the app has drawn at (x, y). Flutter handles
  // these like real pointer input.
  const tapAt = async (x, y) => {
    const view = document.querySelector('flutter-view') || document.elementFromPoint(x, y);
    const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 };
    view.dispatchEvent(new PointerEvent('pointerdown', { ...opts, buttons: 1 }));
    await sleep(40);
    view.dispatchEvent(new PointerEvent('pointerup', { ...opts, buttons: 0 }));
  };

  // A compact description of what's on screen, for bug reports.
  const describeScreen = (name) => {
    const nodes = semanticsNodes();
    const lines = nodes.slice(0, 250).map((el) => {
      let depth = 0;
      for (let p = el.parentElement; p; p = p.parentElement) if (p.tagName === 'FLT-SEMANTICS') depth++;
      const attrs = [el.getAttribute('role'), el.hasAttribute('flt-tappable') && 'tappable', el.getAttribute('aria-label') != null && 'aria', isTextField(el) && 'field']
        .filter(Boolean).join(',');
      const label = ownLabel(el).replace(/\s+/g, ' ').trim().slice(0, 80);
      return `${'  '.repeat(Math.min(depth, 12))}[${attrs}] ${JSON.stringify(label)}`;
    });
    return [
      `Mothership Folders diagnostics: looking for ${JSON.stringify(name)}`,
      `semantics nodes: ${nodes.length}, scrollable regions: ${scrollables().length}, placeholder: ${!!document.querySelector('flt-semantics-placeholder')}`,
      `url: ${location.pathname}${location.hash}`,
      ...lines,
    ].join('\n');
  };

  // Tap the tile for the first of `names` found on screen. `screen` names the
  // app screen that lists these items, for the error message.
  const openItem = async (names, screen = 'Characters') => {
    const [first] = names;
    if (!(await ensureSemantics())) {
      return { ok: false, reason: "Couldn't switch on the app's accessibility layer.", details: describeScreen(first) };
    }
    const findAny = () => names.map(findTile).find(Boolean) || null;
    let tile = null;
    for (let waited = 0; !tile && waited <= 2000; waited += 100) {
      tile = findAny();
      if (!tile) await sleep(100);
    }
    for (const name of names) {
      if (tile) break;
      tile = await scrollToFind(name);
    }
    if (!tile) {
      return {
        ok: false,
        reason: `Couldn't find "${first}" on screen. Open the app's ${screen} list first, then try again.`,
        details: describeScreen(first),
      };
    }
    tile.el.scrollIntoView({ block: 'nearest' });
    if (tile.x == null) {
      tile.el.click();
    } else {
      // Re-measure after scrolling, then tap the screen like a finger would.
      const again = tapTargetFor(tile.el) || tile;
      await tapAt(again.x, again.y);
    }
    return { ok: true };
  };

  window.MSCFolders = window.MSCFolders || {};
  window.MSCFolders.opener = { openItem, ensureSemantics, describeScreen, tapAt };
})();
