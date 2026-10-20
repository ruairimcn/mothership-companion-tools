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

  // ---- Character cards ----------------------------------------------------------
  //
  // Character cards show the name in a disabled text field, and Flutter never
  // puts a field's text in the DOM, so cards can't be found by name. Instead
  // the panel works out the character's position in the app's sorted list,
  // and we count cards: scroll the list to the top, then step down.

  const FIELD = 'input[data-semantics-role="text-field"], textarea[data-semantics-role="text-field"]';
  const fieldCount = (el) => (el ? el.querySelectorAll(FIELD).length : 0);
  const parentNode = (el) => el.parentElement && el.parentElement.closest('flt-semantics');

  // A card is the tappable node holding exactly its two fields (name,
  // class). The app wraps each card in an untappable node with the same
  // fields, so prefer the tappable one; without one, take the outermost.
  const cards = () => {
    const withFields = semanticsNodes().filter((el) => fieldCount(el) === 2);
    const tappable = withFields.filter((el) => el.matches(TAPPABLE) && !isScreenSized(el)
      && !withFields.some((other) => other !== el && other.contains(el) && other.matches(TAPPABLE)));
    const picked = tappable.length ? tappable : withFields.filter((el) => fieldCount(parentNode(el)) !== 2);
    return picked
      .map((el) => ({ el, id: el.id, rect: el.getBoundingClientRect() }))
      .filter((c) => c.rect.height > 0)
      .sort((a, b) => a.rect.top - b.rect.top);
  };

  // The part of the screen where cards can be tapped: below the PLAYER
  // CHARACTERS / NPCS tabs and above the bottom button bar.
  const safeZone = () => {
    let top = 0;
    for (const el of semanticsNodes()) {
      if (/^(player characters|npcs)$/.test(normalize(ownLabel(el)))) top = Math.max(top, el.getBoundingClientRect().bottom);
    }
    return { top: top + 4, bottom: window.innerHeight - 72 };
  };

  const wheelAt = async (x, y, deltaY) => {
    const view = document.querySelector('flutter-view');
    view.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, deltaY, deltaMode: 0 }));
    await sleep(250);
  };

  const positions = () => cards().map((c) => `${c.id}@${Math.round(c.rect.top)}`).join(',');

  const describeCards = () => {
    const zone = safeZone();
    return [`cards: ${cards().map((c) => `${c.id}:${Math.round(c.rect.top)}-${Math.round(c.rect.bottom)}`).join(' ')}`,
      `tap zone: ${Math.round(zone.top)}-${Math.round(zone.bottom)} of ${window.innerHeight}`].join('\n');
  };

  // The whole card is one tap area with its own accessibility element; a
  // click on that is turned into a tap by Flutter (screen taps sent to the
  // canvas don't reliably reach it). Fall back to a screen tap on the
  // portrait if the card has no tappable element.
  const tapCard = (card) => {
    const el = card.el.matches(TAPPABLE) ? card.el : card.el.closest(TAPPABLE);
    if (el && !isScreenSized(el)) {
      el.click();
      return;
    }
    tapPortrait(card);
  };

  const tapPortrait = (card) => {
    const r = card.rect;
    tapAt(r.left + Math.min(80, r.width / 4), r.top + r.height / 2);
  };

  // Flutter ignores accessibility clicks for a moment after any pointer
  // input (mouse moves and clicks anywhere, wheel scrolls), preferring the
  // pointer events. Track that input the way it does, and wait it out.
  const QUIET_MS = 700;
  let lastInput = 0;
  ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'touchstart', 'touchend', 'wheel']
    .forEach((type) => window.addEventListener(type, () => { lastInput = Date.now(); }, true));

  const waitForQuiet = async () => {
    const giveUpAt = Date.now() + 3000; // a mouse that never stops moving
    while (Date.now() - lastInput < QUIET_MS && Date.now() < giveUpAt) await sleep(QUIET_MS - (Date.now() - lastInput) + 20);
    // And let any scrolling come to rest.
    for (let i = 0, prev = null; i < 10; i++) {
      const now = positions();
      if (now === prev) break;
      prev = now;
      await sleep(120);
    }
  };

  const onCharactersPage = () => semanticsNodes().some((el) => /^(player characters|npcs)$/.test(normalize(ownLabel(el))));

  // Open a card, checking that the app responded: if the card is still on
  // the list afterwards, try again, then fall back to a screen tap.
  const activateCard = async (card) => {
    const attempts = [tapCard, tapCard, tapPortrait];
    for (const attempt of attempts) {
      await waitForQuiet();
      const current = cards().find((c) => c.id === card.id);
      // Gone already, or the page changed: something opened.
      if (!current || !onCharactersPage()) return true;
      attempt(current);
      await sleep(800);
      if (!cards().some((c) => c.id === card.id) || !onCharactersPage()) return true;
    }
    return false;
  };

  // Open the card at `index` (0 = top of the list). `label` names the
  // character for error messages.
  const openCard = async (index, label) => {
    const fail = (reason) => ({ ok: false, reason, details: `${describeCards()}\nwanted index ${index}\n${describeScreen(label)}` });
    if (!(await ensureSemantics())) return fail("Couldn't switch on the app's accessibility layer.");
    let list = cards();
    for (let waited = 0; !list.length && waited < 2000; waited += 100) {
      await sleep(100);
      list = cards();
    }
    if (!list.length) return fail("Couldn't find any character cards. Open the app's Characters page first, then try again.");

    const x = list[0].rect.left + list[0].rect.width / 2;
    const midY = (safeZone().top + safeZone().bottom) / 2;

    // Scroll to the top; the scroll stops at the start of the list.
    for (let i = 0, before = null; i < 10 && before !== positions(); i++) {
      before = positions();
      await wheelAt(x, midY, -100000);
    }

    list = cards();
    const pitch = list.length > 1 ? list[1].rect.top - list[0].rect.top : list[0].rect.height + 8;
    const known = new Map(list.map((c, i) => [c.id, i]));

    for (let step = 0; step < 80; step++) {
      list = cards();
      // Number any new cards from one we've already numbered.
      const anchor = list.find((c) => known.has(c.id));
      if (!anchor) return fail(`Lost track of the list while scrolling to "${label}". Try again.`);
      for (const c of list) known.set(c.id, known.get(anchor.id) + Math.round((c.rect.top - anchor.rect.top) / pitch));

      const zone = safeZone();
      const target = list.find((c) => known.get(c.id) === index);
      // Mostly on screen is enough: the last cards can't scroll clear of the
      // bottom button bar.
      const visible = target && target.rect.top >= zone.top - 2
        && target.rect.top + target.rect.height / 2 <= window.innerHeight;
      if (visible) {
        return (await activateCard(target)) ? { ok: true } : fail(`The app didn't respond to opening "${label}".`);
      }

      const indices = list.map((c) => known.get(c.id));
      const down = target ? target.rect.top > zone.top : index > Math.max(...indices);
      const before = positions();
      await wheelAt(x, midY, (down ? 1 : -1) * Math.max(40, Math.min(pitch, zone.bottom - zone.top - pitch)));
      if (positions() === before) {
        // The list can't scroll further; take the card if it's showing at all.
        if (target && target.rect.bottom > zone.top && target.rect.top < window.innerHeight) {
          return (await activateCard(target)) ? { ok: true } : fail(`The app didn't respond to opening "${label}".`);
        }
        return fail(`"${label}" isn't where expected in the app's list. Reload the page so the folders panel has the latest list, then try again.`);
      }
    }
    return fail(`Couldn't reach "${label}" in the list.`);
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
  // Diagnostics on demand (Shift+click a name in the drawer).
  const debugInfo = (label, index) =>
    [index == null ? null : `wanted index ${index}`, describeCards(), describeScreen(label)].filter(Boolean).join('\n');

  window.MSCFolders.opener = { openItem, openCard, debugInfo, ensureSemantics, describeScreen, tapAt, semanticsNodes, ownLabel, normalize };
})();
