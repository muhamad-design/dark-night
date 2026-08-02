// Dark Night - content script
// Injected at document_start in all frames. Reads settings from
// chrome.storage.sync, builds a theme stylesheet and keeps it applied.

(() => {
  "use strict";

  // Both the declarative registration and the service worker's catch-up
  // executeScript() can land in the same frame. A second instance would run a
  // second MutationObserver and a second storage listener against the same
  // style element, so a frame only ever has one owner.
  //
  // Ownership is claimed, not first-come: after the extension is reloaded the
  // previous owner is still resident in this isolated world but its chrome.*
  // bridge is dead. A plain "already loaded" flag would let that corpse block
  // the replacement forever, so the incoming instance asks whether the current
  // owner is still alive and takes over from it if not.
  const previous = window.__darkNight;
  if (previous && previous.alive()) return;

  const STYLE_ID = "dark-night-style";
  const READY_ATTR = "data-dark-night-ready";

  const DEFAULTS = {
    enabled: true,
    mode: "dynamic", // "dynamic" | "filter"
    brightness: 100, // 50..150
    contrast: 100, // 50..150
    sepia: 0, // 0..100
    grayscale: 0, // 0..100
    disabledSites: []
  };

  let settings = null;
  let pending = null; // changes that arrive before the first read resolves
  let observer = null;
  let watchingHead = false;

  // Only the top frame paints the page-wide filter in filter mode; a subframe
  // is already inside the top frame's filtered output. Cannot change without a
  // navigation, so resolve it once.
  const IS_TOP = (() => {
    try {
      return window.top === window;
    } catch (e) {
      return false; // cross-origin ancestor - we are definitely not the top
    }
  })();

  // The host cannot change without a navigation, which reloads this script,
  // so resolve it once instead of on every mutation.
  const HOST = (() => {
    let host = location.hostname;
    try {
      const origins = location.ancestorOrigins;
      if (window.top !== window && origins && origins.length) {
        host = new URL(origins[origins.length - 1]).hostname;
      }
    } catch (e) {
      /* opaque or cross-origin ancestor - fall back to our own hostname */
    }
    return host.replace(/^www\./, "");
  })();

  function siteDisabled(s) {
    return s.disabledSites.some((entry) => {
      const d = entry.replace(/^www\./, "");
      return HOST === d || HOST.endsWith("." + d);
    });
  }

  function cssFilterValue(s, withInvert) {
    const parts = [];
    if (withInvert) parts.push("invert(1)", "hue-rotate(180deg)");
    if (s.brightness !== 100) parts.push(`brightness(${s.brightness}%)`);
    if (s.contrast !== 100) parts.push(`contrast(${s.contrast}%)`);
    if (s.sepia !== 0) parts.push(`sepia(${s.sepia}%)`);
    if (s.grayscale !== 0) parts.push(`grayscale(${s.grayscale}%)`);
    return parts.join(" ");
  }

  // Media is re-inverted so photos and video keep their real colours. Only
  // elements that paint the media themselves are listed - matching a wrapper
  // such as <picture> would invert its <img> a second time.
  //
  // <iframe> is deliberately absent. The top frame's filter already inverts
  // every subframe's painted output, so re-inverting the element here cancelled
  // that out: a frame the content script cannot reach (sandboxed without
  // allow-scripts, an injection that failed) was inverted exactly twice and
  // rendered as a bright white box on a dark page. Leaving iframes alone means
  // every iframe is inverted exactly once, whether or not it runs this script,
  // and subframes that do run it re-invert only their own media.
  //
  // <embed> and <object> stay in the list on purpose: they usually carry an
  // image or a plugin surface, which is media and should keep its real colours.
  // The cost is that an <embed>/<object> *document* - a PDF, say - is inverted
  // twice and stays light. Use an <iframe> for those, or exclude the site.
  //
  // <canvas> is also absent. A canvas is as often an application surface - the
  // Google Sheets grid, a document view, a whiteboard - as it is a picture, and
  // re-inverting it left those apps painted white on an otherwise dark page,
  // which is the exact complaint this engine exists to fix. Photographic
  // canvases now render inverted; that is the accepted trade.
  function buildFilterCss(s, isTop = IS_TOP) {
    const invert = cssFilterValue(s, true);
    const root = isTop
      ? `
html {
  filter: ${invert} !important;
  /* Inverted, #eaeaea lands on #151515 - beUI's --background - so a filtered
     page and the popup sit on exactly the same ground. Pure white would give
     #000, which is darker than the rest of the theme. */
  background-color: #eaeaea !important;
  min-height: 100vh;
}
/* Top-layer elements (modal dialogs, open popovers, the fullscreen element) are
   painted outside the <html> subtree, so an ancestor filter never reaches them
   and they stayed white on a dark page. They need their own pass.

   One rule each, deliberately: a selector list is dropped in full when the
   parser does not recognise any one of its selectors, so pairing :modal with
   the newer :popover-open would silently take modals down on an older Chrome.
   Fullscreen media is excluded - it has its own re-invert below, and matching
   it here would invert the video instead. */
:modal {
  filter: ${invert} !important;
}
[popover]:popover-open {
  filter: ${invert} !important;
}
:fullscreen:not(img):not(video):not(canvas) {
  filter: ${invert} !important;
}`
      : "";
    // Emitted in every frame, not just the top one: a self-theming cross-origin
    // embed would otherwise serve its own dark theme and get inverted white.
    return `
:root {
  /* A site that honours prefers-color-scheme would otherwise serve its own dark
     theme, which this engine then inverts into a blinding white page. Pinning
     light gives the filter the light source it is built to invert. */
  color-scheme: light !important;
}${root}
img, video, embed, object {
  filter: invert(1) hue-rotate(180deg) !important;
}
/* A fullscreen element is in the top layer, outside the <html> subtree, so the
   root filter never reaches it. Media there would be left with only its own
   re-inversion and render as a colour negative. Its own rule, so an older
   parser rejecting :fullscreen cannot take the media rule above down with it. */
img:fullscreen, video:fullscreen, canvas:fullscreen, embed:fullscreen, object:fullscreen {
  filter: none !important;
}
`;
  }

  // `*` carries zero specificity, so a single site rule such as
  // `.card { background: #fff !important }` outranked the override and that
  // surface kept its white background - the most common reason a themed page
  // still looks unthemed. `#\9` is an id made of a TAB character, and HTML
  // forbids whitespace in an id, so the clause can never match anything: it
  // only lifts each selector to (3,0,0) and above, which outranks essentially
  // every real site rule while matching exactly the same elements.
  const SP = ":not(#\\9):not(#\\9):not(#\\9)";

  // beUI's dark tokens, copied from beui.dev's own stylesheet. popup/src/theme.css
  // holds the identical set, so a themed page and the extension's own UI are the
  // same palette. Change them in both places or not at all.
  const T = {
    background: "#151515", // --background
    card: "#1c1c1c", // --card, the raised surface
    foreground: "oklch(96% 0 0)", // --foreground
    muted: "oklch(62% 0 0)", // --muted-foreground
    border: "#ffffff1a", // --border-strong
    accent: "oklch(80% 0.18 195)", // --accent
    accentFg: "#151515", // --accent-fg
    violet: "oklch(68% 0.22 295)", // --violet, used for visited links
    scrollThumb: "oklch(38% 0 0)"
  };

  function buildDynamicCss(s) {
    const extra = cssFilterValue(s, false);
    const filterRule = extra ? `html${SP} { filter: ${extra} !important; }` : "";
    return `
:root {
  color-scheme: dark !important;
}
html${SP}, body${SP} {
  background-color: ${T.background} !important;
  color: ${T.foreground} !important;
}
*${SP} {
  background-color: ${T.background} !important;
}
/* Pseudo-elements are deliberately left out of the background rule above.
   Painting them too turned every decorative overlay - accent bars, tooltip
   arrows, toggle knobs, progress fills, checkmarks - into an opaque dark
   block. One with no author background stays transparent either way, which is
   the correct default; one with an author background keeps its real colour. */
*${SP}, *${SP}::before, *${SP}::after {
  color: ${T.foreground} !important;
  text-shadow: none !important;
}
/* A light gradient or background image survives the colour override and would
   leave near-white text on a near-white band. Pseudo-elements keep theirs so
   sprite icons still render. */
*${SP} {
  background-image: none !important;
}
img${SP}, video${SP}, canvas${SP}, svg${SP}, picture${SP}, iframe${SP}, embed${SP}, object${SP} {
  background-color: transparent !important;
}
/* Icons drawn with a hard-coded black fill would otherwise disappear into the
   dark surface. Icons using currentColor are already carried by the text rule.
   Excluded: black inside <mask>, <clipPath>, <filter> and <defs> is a channel
   value, not a colour - recolouring it would reveal what the mask hides. */
[fill="#000"]:not(mask *):not(clipPath *):not(filter *):not(defs *),
[fill="#000000"]:not(mask *):not(clipPath *):not(filter *):not(defs *),
[fill="black"]:not(mask *):not(clipPath *):not(filter *):not(defs *) {
  fill: ${T.foreground} !important;
}
[stroke="#000"]:not(mask *):not(clipPath *):not(filter *):not(defs *),
[stroke="#000000"]:not(mask *):not(clipPath *):not(filter *):not(defs *),
[stroke="black"]:not(mask *):not(clipPath *):not(filter *):not(defs *) {
  stroke: ${T.foreground} !important;
}
a${SP}, a${SP} span, a${SP} strong, a${SP} em, a${SP} b, a${SP} i, a${SP} u, a${SP} small {
  color: ${T.accent} !important;
}
a${SP}:visited {
  color: ${T.violet} !important;
}
input${SP}, textarea${SP}, select${SP}, button${SP} {
  background-color: ${T.card} !important;
  color: ${T.foreground} !important;
  border-color: ${T.border} !important;
}
/* One flat background across every surface also erases the hover and selection
   feedback the site drew with its own backgrounds, so the UI stops responding
   visually. These put it back on the roles that actually carry it. Descendants
   are repainted too, or the highlight hides behind their own opaque colour.
   List items are restricted to the innermost hovered one so nested menus do
   not light up the whole ancestor chain. */
a${SP}:hover, button${SP}:hover, [role="button"]${SP}:hover,
[role="option"]${SP}:hover, [role="menuitem"]${SP}:hover, [role="tab"]${SP}:hover,
tr${SP}:hover,
a${SP}:hover *${SP}, button${SP}:hover *${SP}, [role="button"]${SP}:hover *${SP},
[role="option"]${SP}:hover *${SP}, [role="menuitem"]${SP}:hover *${SP},
[role="tab"]${SP}:hover *${SP}, tr${SP}:hover *${SP} {
  background-color: ${T.card} !important;
}
/* Split out because of :has() - an unrecognised selector invalidates the entire
   list it sits in, and that would take every hover state above down with it. */
li${SP}:hover:not(:has(li:hover)),
li${SP}:hover:not(:has(li:hover)) *${SP} {
  background-color: ${T.card} !important;
}
/* aria-current="" is ARIA-equivalent to false, so it is excluded alongside it. */
[aria-selected="true"]${SP},
[aria-current]${SP}:not([aria-current="false"]):not([aria-current=""]),
[aria-selected="true"]${SP} *${SP},
[aria-current]${SP}:not([aria-current="false"]):not([aria-current=""]) *${SP} {
  background-color: color-mix(in oklab, ${T.accent} 16%, ${T.background}) !important;
}
/* Elevation is carried entirely by shadow on a light page and vanishes on a
   dark one. A 1px spread ring is what actually reads as an edge here; a soft
   dark drop shadow alone never will. Focused elements are left alone - many
   design systems draw their focus ring as a box-shadow, and overriding it would
   remove the only indicator the element has. */
[role="menu"]${SP}:not(:focus-visible), [role="listbox"]${SP}:not(:focus-visible),
[role="dialog"]${SP}:not(:focus-visible), [role="tooltip"]${SP}:not(:focus-visible),
dialog${SP}:not(:focus-visible), [popover]${SP}:not(:focus-visible) {
  box-shadow: 0 0 0 1px ${T.border}, 0 8px 24px rgba(0, 0, 0, 0.7) !important;
}
/* Light hairlines survive the colour override and stay bright on the dark
   surface. Scoped to elements that are never CSS triangles - a blanket
   border-color rule squares off carets, which is why it was reverted before. */
hr${SP}, table${SP}, thead${SP}, tbody${SP}, tfoot${SP}, tr${SP}, th${SP}, td${SP} {
  border-color: ${T.border} !important;
}
:focus-visible {
  outline: 2px solid ${T.accent} !important;
  outline-offset: 2px !important;
}
::placeholder {
  color: ${T.muted} !important;
  opacity: 1 !important;
}
::selection {
  background-color: ${T.accent} !important;
  color: ${T.accentFg} !important;
}
html {
  scrollbar-color: ${T.scrollThumb} ${T.card};
}
${filterRule}
`;
  }

  function buildCss(s) {
    return s.mode === "filter" ? buildFilterCss(s) : buildDynamicCss(s);
  }

  // --------------------------------------------------------------------------
  // Shadow DOM
  //
  // A <style> in document.head does not cross a shadow boundary, and
  // background-color is not an inherited property, so every component that
  // paints its own surface inside an open shadow root kept its light
  // background - the "app is still white" case. The same sheet is adopted into
  // each open root instead. Closed roots stay unreachable by design.
  //
  // Filter mode does not need any of this: the filter on <html> rasterises the
  // whole frame, shadow content included.
  // --------------------------------------------------------------------------
  const SCAN_BATCH_LIMIT = 1000;
  const SWEEP_DELAYS = [300, 1000, 3000, 8000];
  const sweeps = [];
  let sweptOnce = false;
  let shadowSheet = null;
  let shadowCss = null;
  let shadowObserver = null;
  let scanTimer = null;
  let scanQueue = [];
  let fullRescan = false;
  let observedRoots = new WeakSet();

  function eachShadowRoot(node, fn) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    let el = node.nodeType === 1 && node.shadowRoot ? node : null;
    do {
      if (el && el.shadowRoot) {
        fn(el.shadowRoot);
        eachShadowRoot(el.shadowRoot, fn);
      }
    } while ((el = walker.nextNode()));
  }

  function adoptInto(root) {
    if (!shadowSheet) return;
    // Re-checked every pass: an app that reassigns adoptedStyleSheets drops
    // ours, and re-adding is the only way back in.
    if (!root.adoptedStyleSheets.includes(shadowSheet)) {
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, shadowSheet];
    }
    if (shadowObserver && !observedRoots.has(root)) {
      observedRoots.add(root);
      // Roots nested inside this one only surface through its own mutations.
      shadowObserver.observe(root, { childList: true, subtree: true });
    }
  }

  function flushScan() {
    scanTimer = null;
    const batch = scanQueue;
    scanQueue = [];
    if (fullRescan) {
      fullRescan = false;
      eachShadowRoot(document.documentElement, adoptInto);
      return;
    }
    for (const node of batch) {
      if (node.isConnected) eachShadowRoot(node, adoptInto);
    }
  }

  function onShadowMutation(records) {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1) scanQueue.push(node);
      }
    }
    // An app that appends thousands of nodes in one batch would otherwise cost
    // a subtree walk per node, much of it overlapping. Past that point one pass
    // over the document is both cheaper and bounded.
    if (scanQueue.length > SCAN_BATCH_LIMIT) {
      fullRescan = true;
      scanQueue = [];
    }
    // Batched: at document_start every parsed element arrives as a mutation.
    if ((scanQueue.length || fullRescan) && !scanTimer) scanTimer = setTimeout(flushScan, 100);
  }

  function startShadow(css) {
    if (shadowCss !== css) {
      shadowCss = css;
      if (!shadowSheet) shadowSheet = new CSSStyleSheet();
      shadowSheet.replaceSync(css);
    }
    if (!shadowObserver) {
      shadowObserver = new MutationObserver(onShadowMutation);
      shadowObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
    eachShadowRoot(document.documentElement, adoptInto);

    // A custom element already sitting in the DOM when its definition finally
    // loads is upgraded in place: attachShadow() runs inside the constructor and
    // produces no mutation record at all, so the observer above never learns
    // about it. That is the normal shape of a deferred component bundle, and
    // re-walking is the only way to find it - a content script runs in an
    // isolated world and cannot hook the page's attachShadow.
    if (!sweptOnce) {
      sweptOnce = true;
      for (const delay of SWEEP_DELAYS) sweeps.push(setTimeout(sweep, delay));
      // The offsets above are measured from whenever the storage read happened,
      // which says nothing about parse progress. Deferred and module scripts all
      // run before DOMContentLoaded, so that event is the one point guaranteed
      // to be after the upgrades a bundle performs.
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", sweep, { once: true });
      }
    }
  }

  // Routed through the same debounce as observed mutations, so a sweep landing
  // in the middle of a parse burst coalesces with the queued work instead of
  // adding a second full-document walk beside it.
  function sweep() {
    if (!shadowObserver) return; // theme is off; nothing to adopt into
    fullRescan = true;
    if (!scanTimer) scanTimer = setTimeout(flushScan, 100);
  }

  function stopShadow() {
    if (shadowObserver) {
      shadowObserver.disconnect();
      shadowObserver = null;
    }
    // The set records which roots the *current* observer already watches. A new
    // observer starts watching nothing, so carrying the old set over would leave
    // every previously-known root unwatched after a disable/re-enable, and roots
    // nested inside them would never be found again.
    observedRoots = new WeakSet();
    clearTimeout(scanTimer);
    scanTimer = null;
    scanQueue = [];
    fullRescan = false;
    while (sweeps.length) clearTimeout(sweeps.pop());
    sweptOnce = false;
    // Emptying the shared sheet strips the theme from every root that still
    // holds it, including detached-but-cached subtrees the walk below cannot
    // reach. startShadow refills it because shadowCss no longer matches.
    if (shadowSheet) {
      shadowSheet.replaceSync("");
      shadowCss = null;
    }
    if (shadowSheet && document.documentElement) {
      eachShadowRoot(document.documentElement, (root) => {
        if (root.adoptedStyleSheets.includes(shadowSheet)) {
          root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== shadowSheet);
        }
      });
    }
  }

  // --------------------------------------------------------------------------

  function applyTheme() {
    if (!settings) return;
    const active = settings.enabled && !siteDisabled(settings);
    let style = document.getElementById(STYLE_ID);

    if (!active) {
      if (style) style.remove();
      stopShadow();
      stopWatching();
      return;
    }

    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      // documentElement exists at document_start even before <head>.
      (document.head || document.documentElement).appendChild(style);
    }
    const css = buildCss(settings);
    if (style.textContent !== css) style.textContent = css;

    if (settings.mode === "filter") stopShadow();
    else startShadow(css);

    startWatching();
  }

  // Disabling, reloading or updating the extension orphans this frame: the
  // chrome.* bridge dies, so no settings change can ever reach it again and the
  // injected sheet would sit on the page until a manual reload - the theme
  // frozen on, deaf to "Disable for this site". Nothing outside the frame can
  // clear it, so the frame cleans up after itself. Invalidation is permanent,
  // so there is no false positive to worry about.
  function teardown() {
    clearInterval(deadCheck);
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    stopShadow();
    stopWatching();
  }

  function alive() {
    return !!(chrome.runtime && chrome.runtime.id);
  }

  const deadCheck = setInterval(() => {
    if (!alive()) teardown();
  }, 5000);

  // Hand the frame over: strip whatever the dead owner left behind, then
  // publish this instance as the one to ask next time.
  if (previous) previous.teardown();
  window.__darkNight = { alive, teardown };

  // Some SPAs rewrite <head>; re-attach the style if it gets removed. Only
  // <html> and <head> child lists are watched - a subtree observer would fire
  // on every DOM change the page makes.
  function onMutation() {
    // Queued records still arrive as a microtask after stopWatching() ran.
    if (!observer) return;
    if (!chrome.runtime || !chrome.runtime.id) {
      teardown();
      return;
    }
    if (document.head && !watchingHead) {
      watchingHead = true;
      observer.observe(document.head, { childList: true });
    }
    if (
      settings &&
      settings.enabled &&
      !siteDisabled(settings) &&
      !document.getElementById(STYLE_ID)
    ) {
      applyTheme();
    }
  }

  function startWatching() {
    if (observer) return;
    observer = new MutationObserver(onMutation);
    observer.observe(document.documentElement, { childList: true });
    watchingHead = false;
    if (document.head) {
      watchingHead = true;
      observer.observe(document.head, { childList: true });
    }
  }

  function stopWatching() {
    if (!observer) return;
    observer.disconnect();
    observer = null;
    watchingHead = false;
  }

  function mergeChanges(changes) {
    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue !== undefined ? newValue : DEFAULTS[key];
    }
  }

  chrome.storage.sync.get(DEFAULTS, (stored) => {
    settings = stored;
    // Replay anything that landed while the read was in flight.
    if (pending) {
      mergeChanges(pending);
      pending = null;
    }
    applyTheme();
    // Releases the pre-paint stylesheet registered by the service worker.
    document.documentElement.setAttribute(READY_ATTR, "");
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (!settings) {
      pending = Object.assign(pending || {}, changes);
      return;
    }
    mergeChanges(changes);
    applyTheme();
  });
})();
