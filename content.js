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
    disabledSites: [],
    autoSkipNativeDark: true, // step aside when the page is already dark
    forcedSites: [] // theme these even when they already look dark
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

  function hostInList(list) {
    return list.some((entry) => {
      const d = entry.replace(/^www\./, "");
      return HOST === d || HOST.endsWith("." + d);
    });
  }

  function siteDisabled(s) {
    return hostInList(s.disabledSites);
  }

  function siteForced(s) {
    return hostInList(s.forcedSites);
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
  // still looks unthemed. `:not()` takes the specificity of its most specific
  // argument, so the compound below lifts each selector to (3,0,0), which
  // outranks essentially every real site rule. Those are ids made of control
  // characters, and an element carries at most one id, so the compound can
  // never match and the clause is always true: the selectors match exactly the
  // elements they would without it.
  //
  // One `:not()` holding a three-id compound, deliberately, rather than three
  // `:not(#\9)` in a row. Both are (3,0,0), but the chained form costs three id
  // comparisons per element across the ~40 selectors below that run against
  // everything, and this sheet is resolved over the whole document on every
  // page load. Collapsing it roughly halves the engine's style cost: on a
  // 5,700-element page it took +7.4ms over an unthemed load down to +3.9ms,
  // faster in 33 of 40 interleaved rounds. test/perf-bench.html measures this.
  const SP = ":not(#\\9#\\8#\\7)";

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
  // Native dark detection
  //
  // A site that is already dark - its own toggle, a stored preference, a
  // prefers-color-scheme theme - gains nothing from being themed again, and in
  // filter mode it gets inverted into a blinding white page. "Offers dark mode"
  // is not answerable from here (cross-origin stylesheets hide their rules),
  // but "is rendering dark right now" is: read the page's own background with
  // the injected sheet lifted and step aside when it is dark. If the browser
  // prefers light and the site only goes dark via prefers-color-scheme, the
  // page really is rendering light and theming it is the correct outcome.
  //
  // Only the top frame measures. In filter mode a subframe's CSS assumes the
  // ancestor filter exists, so frames must agree on one verdict; the top hands
  // it out over postMessage. Page JS shares the window and could spoof either
  // message, but all that buys it is flipping the theme in its own iframes,
  // which the page could do to itself anyway.
  // --------------------------------------------------------------------------
  const DETECT_RECHECKS = [1000, 3000]; // SPAs restyle after hydration
  const MSG_QUERY = "dark-night:verdict?";
  const MSG_VERDICT = "dark-night:verdict";

  let nativeDark = false; // top frame: last measurement; subframe: the top's verdict
  let detectionArmed = false;
  const detectTimers = [];
  const childFrames = []; // every frame that has ever asked for the verdict

  function steppedAside(s) {
    return nativeDark && s.autoSkipNativeDark && !siteForced(s);
  }

  // true / false / null for "cannot tell" - transparent, translucent, or a
  // syntax this does not parse. Failing toward light is the safe direction:
  // the theme just applies, which is the behaviour the user installed.
  function colorIsDark(color) {
    let m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(color);
    if (m) {
      if (m[4] !== undefined && Number(m[4]) < 0.5) return null; // see-through
      const lin = (c) => {
        const v = Number(c) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]) < 0.2;
    }
    // Chrome serialises modern-syntax backgrounds (Tailwind 4 emits oklch) in
    // their own notation; the first component is always lightness.
    m = /^(oklch|oklab|lab|lch)\(\s*([\d.]+)(%?)/.exec(color);
    if (m) {
      let l = Number(m[2]);
      if (m[3] === "%" || m[1] === "lab" || m[1] === "lch") l /= 100;
      return l < 0.45;
    }
    return null;
  }

  function readPageDark() {
    for (const el of [document.body, document.documentElement]) {
      if (!el) continue;
      const v = colorIsDark(getComputedStyle(el).backgroundColor);
      if (v !== null) return v;
    }
    // Both transparent: the canvas shows through, and its colour follows the
    // document's own color-scheme - "light dark" follows the browser setting.
    const scheme = getComputedStyle(document.documentElement).colorScheme || "";
    if (!/\bdark\b/.test(scheme)) return false;
    if (/\blight\b/.test(scheme)) return matchMedia("(prefers-color-scheme: dark)").matches;
    return true;
  }

  // The injected sheet paints the page dark itself, so it is lifted for the
  // read. Lift, read, restore is one synchronous task: the browser recalculates
  // style for the read but never paints the unthemed frame, so nothing flashes.
  function measurePageDark() {
    const style = document.getElementById(STYLE_ID);
    const lifted = !!(style && !style.disabled);
    if (lifted) style.disabled = true;
    try {
      return readPageDark();
    } finally {
      if (lifted) style.disabled = false;
    }
  }

  function checkNativeDark() {
    if (!IS_TOP || !settings || !document.body) return;
    // Measured only while the result could matter; when the extension or the
    // site is off, or auto-skip is off, the verdict is simply "not stepping
    // aside" and the page is never touched for it.
    const worth = settings.enabled && !siteDisabled(settings) && settings.autoSkipNativeDark;
    const verdict = worth ? measurePageDark() : false;
    if (verdict === nativeDark) return;
    nativeDark = verdict;
    applyTheme();
    for (const w of childFrames) {
      try {
        w.postMessage({ type: MSG_VERDICT, dark: nativeDark }, "*");
      } catch (e) {
        /* frame navigated away */
      }
    }
  }

  function armDetection() {
    if (detectionArmed) return;
    detectionArmed = true;
    if (!IS_TOP) {
      // Ask once; the top answers immediately and again on every change.
      try {
        window.top.postMessage(MSG_QUERY, "*");
      } catch (e) {
        /* detached frame */
      }
      return;
    }
    const kickoff = () => {
      checkNativeDark();
      for (const delay of DETECT_RECHECKS) detectTimers.push(setTimeout(checkNativeDark, delay));
    };
    // Not before DOMContentLoaded: at document_start the body has no styles
    // yet, and a site's own dark theme often arrives with its stylesheet or a
    // hydration script, both of which have run by then.
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", kickoff, { once: true });
    } else {
      kickoff();
    }
  }

  if (IS_TOP) {
    window.addEventListener("message", (e) => {
      if (e.data !== MSG_QUERY || !e.source || e.source === window) return;
      if (!childFrames.includes(e.source)) childFrames.push(e.source);
      try {
        e.source.postMessage({ type: MSG_VERDICT, dark: nativeDark }, "*");
      } catch (err) {
        /* frame navigated away */
      }
    });
  } else {
    window.addEventListener("message", (e) => {
      if (e.source !== window.top) return;
      const d = e.data;
      if (!d || d.type !== MSG_VERDICT || typeof d.dark !== "boolean") return;
      if (d.dark === nativeDark) return;
      nativeDark = d.dark;
      if (settings) applyTheme();
    });
  }

  // The popup asks whether this page was measured as already dark, so it can
  // offer "theme it anyway". Only the top frame answers; subframes return
  // nothing and Chrome delivers the one response that was sent.
  if (chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!IS_TOP || !msg || msg.type !== "dark-night:status") return;
      sendResponse({ nativeDark });
    });
  }

  // --------------------------------------------------------------------------

  function applyTheme() {
    if (!settings) return;
    const active = settings.enabled && !siteDisabled(settings) && !steppedAside(settings);
    let style = document.getElementById(STYLE_ID);

    if (!active) {
      if (style) style.remove();
      stopShadow();
      stopWatching();
      stopDeadCheck();
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
    startDeadCheck();
  }

  // Disabling, reloading or updating the extension orphans this frame: the
  // chrome.* bridge dies, so no settings change can ever reach it again and the
  // injected sheet would sit on the page until a manual reload - the theme
  // frozen on, deaf to "Disable for this site". Nothing outside the frame can
  // clear it, so the frame cleans up after itself. Invalidation is permanent,
  // so there is no false positive to worry about.
  function teardown() {
    stopDeadCheck();
    // A recheck firing after the bridge died would re-measure and could
    // re-apply the theme this teardown just removed.
    while (detectTimers.length) clearTimeout(detectTimers.pop());
    const style = document.getElementById(STYLE_ID);
    if (style) style.remove();
    stopShadow();
    stopWatching();
  }

  function alive() {
    return !!(chrome.runtime && chrome.runtime.id);
  }

  // Polled rather than event-driven: an invalidated extension delivers no
  // callback to say so, and holding a runtime.connect port open to notice the
  // disconnect would keep the service worker resident for as long as the page
  // is, which costs far more than it saves.
  //
  // Started only while the theme is actually applied. Running it from script
  // start meant every frame of every page polled forever - including sites on
  // the exclusion list and every frame on every page while the extension was
  // switched off entirely, where teardown has nothing to remove and the timer
  // is pure wake-up cost. Nothing is injected in those frames, so nothing needs
  // reclaiming if the bridge dies there.
  let deadCheck = null;

  function startDeadCheck() {
    if (deadCheck) return;
    deadCheck = setInterval(() => {
      if (!alive()) teardown();
    }, 5000);
  }

  function stopDeadCheck() {
    if (!deadCheck) return;
    clearInterval(deadCheck);
    deadCheck = null;
  }

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
    armDetection();
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
    // A policy change can invalidate the last measurement - auto-skip switched
    // on mid-session, the site force-themed or released, the extension or the
    // site re-enabled - so the verdict is re-taken right away rather than
    // waiting for a reload.
    if (changes.enabled || changes.disabledSites || changes.autoSkipNativeDark || changes.forcedSites) {
      checkNativeDark();
    }
  });
})();
