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
  // and we find the card at that position: from the list's scroll offset
  // when we can read it, or by scrolling to the top and counting down.

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

  const positions = () => cards().map((c) => `${c.id}@${Math.round(c.rect.top)}`).join(',');

  // Wait until the cards move (or `maxMs` passes), then for them to settle.
  const waitForMove = async (before, maxMs) => {
    for (let waited = 0; positions() === before && waited < maxMs; waited += 30) await sleep(30);
    for (let i = 0, prev = null; i < 10; i++) {
      const now = positions();
      if (now === prev) return;
      prev = now;
      await sleep(40);
    }
  };

  const wheelAt = async (x, y, deltaY) => {
    const before = positions();
    const view = document.querySelector('flutter-view');
    view.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, deltaY, deltaMode: 0 }));
    await waitForMove(before, 250);
  };

  const describeCards = () => {
    const zone = safeZone();
    const region = cards().length ? scrollRegion(cards()[0]) : null;
    return [`cards: ${cards().map((c) => `${c.id}:${Math.round(c.rect.top)}-${Math.round(c.rect.bottom)}`).join(' ')}`,
      `tap zone: ${Math.round(zone.top)}-${Math.round(zone.bottom)} of ${window.innerHeight}`,
      `scroll region: ${region ? `top ${Math.round(region.getBoundingClientRect().top)}, scrollTop ${region.scrollTop} of ${region.scrollHeight - region.clientHeight}` : 'none'}`].join('\n');
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

  // Flutter ignores accessibility clicks and scrolls for half a second after
  // pointer input it sees (mouse moves and clicks over the app, wheel
  // scrolls). The hook hides input inside the drawer from it, so track the
  // rest the same way and wait it out when needed.
  const QUIET_MS = 550;
  let lastInput = 0;
  const fromPanel = (e) => e.composedPath().some((n) => n && n.id === 'msc-folders-root');
  ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'mouseup', 'touchstart', 'touchend', 'wheel']
    .forEach((type) => window.addEventListener(type, (e) => { if (!fromPanel(e)) lastInput = Date.now(); }, true));

  const waitForQuiet = async () => {
    const giveUpAt = Date.now() + 3000; // a mouse that never stops moving
    while (Date.now() - lastInput < QUIET_MS && Date.now() < giveUpAt) await sleep(QUIET_MS - (Date.now() - lastInput) + 20);
  };

  const onCharactersPage = () => semanticsNodes().some((el) => /^(player characters|npcs)$/.test(normalize(ownLabel(el))));
  const stillListed = (card) => cards().some((c) => c.id === card.id) && onCharactersPage();

  // Open a card. Returns as soon as it's clicked; if the card is still on
  // the list shortly after, retry (then fall back to a screen tap) in the
  // background, and call onLateFailure if nothing worked.
  const activateCard = async (card, onLateFailure) => {
    await waitForQuiet();
    tapCard(cards().find((c) => c.id === card.id) || card);
    (async () => {
      for (const retry of [tapCard, tapPortrait]) {
        await sleep(600);
        if (!stillListed(card)) return;
        await waitForQuiet();
        const current = cards().find((c) => c.id === card.id);
        if (current && onCharactersPage()) retry(current);
      }
      await sleep(600);
      if (stillListed(card) && onLateFailure) onLateFailure();
    })();
  };

  // The list's scroll container. Flutter keeps its scrollTop equal to the
  // list's scroll offset, which tells us where every card sits in the list.
  const scrollRegion = (card) => {
    for (let p = parentNode(card.el); p; p = parentNode(p)) {
      if (p.scrollHeight > p.clientHeight + 2) return p;
    }
    return null;
  };

  // Mostly on screen is enough: the last cards can't scroll clear of the
  // bottom button bar.
  const isVisible = (card, zone) => card.rect.top >= zone.top - 2 && card.rect.top + card.rect.height / 2 <= window.innerHeight;

  // Fast path: number the cards from the scroll offset, scroll straight to
  // the target if needed, and click. Returns the card, or null to fall back.
  const findByOffset = async (index, total) => {
    const layout = () => {
      const list = cards();
      if (!list.length) return null;
      const region = scrollRegion(list[0]);
      if (!region) {
        // Nothing to scroll: every card is built, in order. (If some are
        // missing, the list is built lazily after all; use the slow path.)
        return list.length === total ? { list, region: null, indexOf: (c) => list.indexOf(c) } : null;
      }
      const pitch = list.length > 1 ? list[1].rect.top - list[0].rect.top : list[0].rect.height;
      if (pitch <= 0) return null;
      const regionTop = region.getBoundingClientRect().top;
      const contentY = (c) => c.rect.top - regionTop + region.scrollTop;
      // A card above the start of the list means the offset isn't the list's
      // real scroll position (an app version that doesn't keep it in sync).
      if (contentY(list[0]) < -2) return null;
      const pad = contentY(list[0]) % pitch; // space above the first card
      return { list, region, pitch, pad, regionTop, indexOf: (c) => Math.round((contentY(c) - pad) / pitch) };
    };

    let l = layout();
    if (!l) return null;
    const zone = safeZone();
    let target = l.list.find((c) => l.indexOf(c) === index);
    if (target && isVisible(target, zone)) return target;
    if (!l.region) return null;

    // Scroll so the target sits just below the tabs.
    const max = l.region.scrollHeight - l.region.clientHeight;
    const want = Math.max(0, Math.min(max, l.pad + index * l.pitch - (zone.top + 8 - l.regionTop)));
    await waitForQuiet();
    l.region.scrollTop = want;
    // The app builds newly scrolled-in cards over the next frame or two.
    for (let waited = 0; waited <= 600; waited += 30) {
      await sleep(30);
      l = layout();
      target = l && l.list.find((c) => l.indexOf(c) === index);
      if (target && (isVisible(target, zone) || (target.rect.bottom > zone.top && target.rect.top < window.innerHeight))) return target;
    }
    return null;
  };

  // Slow path: scroll to the top with the mouse wheel, then step down,
  // numbering cards as they appear.
  const findByStepping = async (index) => {
    let list = cards();
    if (!list.length) return null;
    const x = list[0].rect.left + list[0].rect.width / 2;
    const midY = (safeZone().top + safeZone().bottom) / 2;

    for (let i = 0, before = null; i < 10 && before !== positions(); i++) {
      before = positions();
      await wheelAt(x, midY, -100000);
    }

    list = cards();
    const pitch = list.length > 1 ? list[1].rect.top - list[0].rect.top : list[0].rect.height + 8;
    const known = new Map(list.map((c, i) => [c.id, i]));

    for (let step = 0; step < 80; step++) {
      list = cards();
      if (!list.length) return null;
      // Number any new cards from one we've already numbered.
      const anchor = list.find((c) => known.has(c.id));
      if (!anchor) return null;
      for (const c of list) known.set(c.id, known.get(anchor.id) + Math.round((c.rect.top - anchor.rect.top) / pitch));

      const zone = safeZone();
      const target = list.find((c) => known.get(c.id) === index);
      if (target && isVisible(target, zone)) return target;

      const indices = list.map((c) => known.get(c.id));
      const down = target ? target.rect.top > zone.top : index > Math.max(...indices);
      const before = positions();
      await wheelAt(x, midY, (down ? 1 : -1) * Math.max(40, Math.min(pitch, zone.bottom - zone.top - pitch)));
      if (positions() === before) {
        // The list can't scroll further; take the card if it's showing at all.
        return target && target.rect.bottom > zone.top && target.rect.top < window.innerHeight ? target : null;
      }
    }
    return null;
  };

  // Open the card at `index` (0 = top of the list) of `total`. `label` names
  // the character for error messages; onLateFailure is called if the click
  // turns out not to have opened anything.
  const openCard = async (index, label, { total = -1, onLateFailure } = {}) => {
    const details = () => `${describeCards()}\nwanted index ${index}\n${describeScreen(label)}`;
    const fail = (reason) => ({ ok: false, reason, details: details() });
    if (!(await ensureSemantics())) return fail("Couldn't switch on the app's accessibility layer.");
    for (let waited = 0; !cards().length && waited < 2000; waited += 100) await sleep(100);
    if (!cards().length) return fail("Couldn't find any character cards. Open the app's Characters page first, then try again.");

    const target = (await findByOffset(index, total)) || (await findByStepping(index));
    if (!target) {
      return fail(`"${label}" isn't where expected in the app's list. Reload the page so the folders panel has the latest list, then try again.`);
    }
    const lateDetails = details();
    await activateCard(target, onLateFailure && (() => onLateFailure({
      ok: false,
      reason: `The app didn't respond to opening "${label}".`,
      details: lateDetails,
    })));
    return { ok: true };
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
