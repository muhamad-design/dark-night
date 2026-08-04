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
    themeImages: false, // let the theme reach photos and video too
    disabledSites: [],
    autoSkipNativeDark: true, // step aside when the page is already dark
    forcedSites: [], // theme these even when they already look dark
    siteOverrides: {} // host -> its own copy of the six visual settings
  };

  let settings = null;
  let pending = null; // changes that arrive before the first read resolves
  let observer = null;
  let watchingHead = false;

  // Only the top frame paints the page-wide filter in filter mode; a subframe
  // is already inside the top frame's filtered output. Cannot change without a
  // navigation, so resolve it once.
  //
  // A fenced frame answers `window.top === window` with itself and carries an
  // empty ancestorOrigins - it is the root of its own frame tree - yet it is
  // still painted into the embedding page, so the embedder's root filter
  // rasterises it exactly like an iframe. Taken at face value it would have
  // applied a second root filter inside the first, which is the doubling the
  // gate exists to prevent. window.fence is the one thing that tells them
  // apart: a Fence object inside a fenced frame tree, null everywhere else, and
  // read here from the isolated world, where the page cannot forge it.
  const IS_TOP = (() => {
    try {
      return window.top === window && !window.fence;
    } catch (e) {
      return false; // cross-origin ancestor - we are definitely not the top
    }
  })();

  // The host cannot change without a navigation, which reloads this script,
  // so resolve it once instead of on every mutation.
  const bareHost = (h) => (h || "").replace(/^www\./, "");

  function resolveHost(win, loc) {
    try {
      const origins = loc.ancestorOrigins;
      if (win.top !== win && origins && origins.length) {
        const top = new URL(origins[origins.length - 1]).hostname;
        if (top) return bareHost(top);
      }
    } catch (e) {
      /* opaque or cross-origin ancestor - fall back to our own hostname */
    }
    if (loc.hostname) return bareHost(loc.hostname);

    // No hostname of our own: an about:blank or about:srcdoc document. The URL
    // has no host to match a per-site rule against, but such a document is not
    // a site in its own right either - it was opened by one, inherits that
    // one's origin, and is painted as part of it. Without this it answered to
    // no rule at all, so a site the user had excluded still had its popups
    // themed: a Slack huddle is exactly this, a window.open("about:blank")
    // whose call controls kept being inverted on an excluded app.slack.com.
    //
    // manifest.json sets match_about_blank, so this script runs there; the
    // three sources below are every way such a document can name the page it
    // belongs to. location.origin first: it is the inherited origin itself,
    // needs no cross-window access, and is the only one a sandboxed or
    // detached document can still answer.
    try {
      const inherited = new URL(loc.origin).hostname;
      if (inherited) return bareHost(inherited);
    } catch (e) {
      /* "null" for a genuinely opaque origin - nothing to inherit */
    }
    for (const related of [
      () => win.opener && win.opener.location.hostname,
      () => win.parent !== win && win.parent.location.hostname
    ]) {
      try {
        const host = related();
        if (host) return bareHost(host);
      } catch (e) {
        /* cross-origin, or gone - try the next one */
      }
    }
    return "";
  }

  const HOST = resolveHost(window, location);

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

  // The theme this host is painted with. A site can keep its own copy of the
  // six visual settings; everything else - the master switch, the exclusion
  // list, auto-skip - stays shared, because those decide *whether* to theme and
  // already have per-site answers of their own.
  //
  // Matched on the exact host, unlike the exclusion list, which matches
  // suffixes: excluding a domain is meant to cover everything under it, whereas
  // a tuning is a response to one site's design. HOST is the top frame's, so
  // every frame on a page is painted with the same theme.
  function effective(s) {
    const own = s.siteOverrides ? s.siteOverrides[HOST] : null;
    return own && typeof own === "object" ? { ...s, ...own } : s;
  }

  // The forward filter an ancestor is painting THIS frame with, as the top
  // frame reported it, or null for "nothing above is filtering".
  //
  // A subframe cannot work this out for itself, and used to assume it. Two ways
  // the assumption is wrong, both reachable: the top document may not be
  // running this script at all - a file:// page without file access, another
  // extension's page, anything Chrome refuses - while an http(s) subframe of it
  // is; and HOST is read from ancestorOrigins, which Blink serialises as the
  // literal string "null" for an opaque origin (a top document sandboxed by
  // CSP, an about:blank opened by window.open), so the subframe silently
  // resolves its OWN host and can disagree with the top about every per-site
  // answer, the engine included. Either way the frame emitted a reversal for a
  // filter that was not there - a colour negative in filter mode, crushed
  // images in dynamic mode.
  //
  // So it is told rather than assumed, and null until it is: a missing reversal
  // costs one round trip of media carrying the page filter, which is exactly
  // what "theme images" looks like, while an unpaired one is a visible defect
  // that never corrects itself.
  let ancestorFilter = null;

  // Contrast before brightness, which is not the order it reads in the popup and
  // is not cosmetic. A browser clamps to [0,1] between filter primitives, so the
  // forward chain can destroy a channel before the media reversal ever runs -
  // and no element filter can bring back what the root filter already clipped.
  //
  // brightness(130%) first drives every channel above 0.77 to pure white, and
  // the contrast that follows lands it at 0.9: a white photographic background
  // came out grey however exact the reversal was. Contrast first compresses
  // toward the middle, which leaves the brightness that follows the headroom to
  // land white back on white. Measured across the swatch set, this is the
  // difference between white returning as #e3e3e3 and returning as #ffffff.
  //
  // It costs a little at the bottom - black lifts rather than crushing - which
  // is the cheaper error on photographs, and the one a viewer reads as "slightly
  // washed" rather than "wrong colour".
  function cssFilterValue(s, withInvert) {
    const parts = [];
    if (withInvert) parts.push("invert(1)", "hue-rotate(180deg)");
    if (s.contrast !== 100) parts.push(`contrast(${s.contrast}%)`);
    if (s.brightness !== 100) parts.push(`brightness(${s.brightness}%)`);
    if (s.sepia !== 0) parts.push(`sepia(${s.sepia}%)`);
    if (s.grayscale !== 0) parts.push(`grayscale(${s.grayscale}%)`);
    return parts.join(" ");
  }

  // The reverse of the slider chain, for media that has to stay true to colour.
  // An element's own filter is applied before any ancestor's, so media carrying
  // the reverse of what <html> carries comes out of the pair unchanged - which
  // is the only way to exempt anything from an ancestor filter in CSS.
  //
  // Reversing a chain reverses its order as well as each function, and
  // brightness and contrast do not commute, so the order here is not cosmetic.
  // It is the mirror of cssFilterValue's contrast-then-brightness, which means
  // brightness comes first here:
  //   brightness(b) -> brightness(1/b)
  //   contrast(c)   -> contrast(1/c)
  //   grayscale(g)  -> saturate(1/(1-g)), exact because the spec defines
  //                    grayscale(g) as saturate(1-g) - the same matrix.
  //
  // sepia() is the one that cannot be reversed: its matrix is not expressible
  // as any other CSS filter function, and at 100% it is singular anyway. A
  // sepia tint therefore still reaches media, which is the right answer for the
  // one slider that is a deliberate warm cast over the whole page rather than a
  // correction applied per surface.
  //
  // Dropping a term from the middle of the chain costs a little more than that
  // term: the reversal telescopes only while it stays paired, so with sepia in
  // play the two saturates sit either side of a matrix they do not commute with
  // and grayscale stops cancelling exactly either. Brightness and contrast are
  // adjacent to the dropped term on one side only and still cancel exactly, and
  // at the default sepia of 0 every term cancels exactly.
  function undoFilterValue(s) {
    // Six decimals, because the reciprocals are rarely exact: 100/130 rounded
    // to four left a drift of 3e-7 per channel, and while that is three orders
    // below one 8-bit step, the digits are free and the headroom means the
    // exactness test measures the arithmetic rather than the rounding.
    const pct = (n) => `${Math.round(n * 1e6) / 1e6}%`;
    const parts = [];
    // At 100% the colour is gone; no amount of saturate brings it back.
    if (s.grayscale !== 0 && s.grayscale < 100) {
      parts.push(`saturate(${pct(10000 / (100 - s.grayscale))})`);
    }
    if (s.brightness !== 100) parts.push(`brightness(${pct(10000 / s.brightness)})`);
    if (s.contrast !== 100) parts.push(`contrast(${pct(10000 / s.contrast)})`);
    return parts.join(" ");
  }

  // The reversal media has to carry to come back out of a forward filter
  // unchanged. `applied` is the filter that is actually reaching this frame's
  // pixels - this frame's own settings in the top frame, an ancestor's in a
  // subframe - so its sliders say what to undo and its `themeImages` whether
  // media was meant to be exempt at all. `inverting` says whether that chain
  // included the invert pair.
  //
  // A null `applied` is the whole point of the argument: with nothing filtering
  // this frame, media needs nothing. A reversal emitted there is not a harmless
  // no-op, it is the reversal applied on its own.
  function mediaUndo(applied, inverting) {
    if (!applied || applied.themeImages) return "";
    const undo = undoFilterValue(applied);
    return inverting ? `${undo} invert(1) hue-rotate(180deg)`.trim() : undo;
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
  //
  // All of that is what happens while media is being kept true to colour, which
  // is the default. With "theme images" on, media is simply left to the root
  // filter like every other pixel: an inverted screenshot or diagram is exactly
  // what that setting is for, and an inverted photograph is the reason it is
  // off until asked for.
  function buildFilterCss(s, isTop = IS_TOP, ancestor = ancestorFilter) {
    // The forward filter this frame's pixels actually carry: this engine's own
    // invert chain in the top frame, an ancestor's in a subframe.
    //
    // Everything a subframe emits in this engine is compensation for an
    // ancestor INVERSION - pinning color-scheme light is what gives that
    // inversion a light source to work on, and the media rule is what takes it
    // back off photos. With nothing above inverting, every one of those rules
    // is unpaired: color-scheme light forces a site's light theme with nothing
    // to invert it, and the media rule renders every photo as a colour
    // negative. So the frame emits nothing at all rather than half a pair.
    const applied = isTop ? s : ancestor;
    if (!isTop && (!applied || applied.mode !== "filter")) return "";
    const invert = cssFilterValue(s, true);
    const root = isTop
      ? `
html {
  filter: ${invert} !important;
  /* Inverted, #eaeaea lands on #151515 - the theme's --background - so a
     filtered page and the popup sit on exactly the same ground. Pure white
     would give #000, which is darker than the rest of the theme. */
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
    // The root filter has already inverted and adjusted every pixel of the
    // frame by the time it reaches media, so undoing it here is what keeps a
    // photo looking like the photo. Dropped entirely when the theme is meant to
    // reach media, which leaves it carrying the root filter like anything else.
    //
    // Built from the filter that is actually applied, not from this frame's own
    // settings: in a subframe those are the same values only while the top
    // frame resolved the same host, and the reversal is worthless unless it is
    // the exact reverse of what was applied.
    const undo = mediaUndo(applied, true);
    const media = undo
      ? `
img, video, embed, object {
  filter: ${undo} !important;
}`
      : "";
    // A fullscreen element is in the top layer, outside the <html> subtree, so
    // the root filter never reaches it. Media true to colour therefore needs
    // nothing at all there - carrying the reverse alone would render it as a
    // colour negative - and themed media needs the whole treatment applied
    // directly, since nothing above it will.
    const fullscreenMedia = applied.themeImages ? cssFilterValue(applied, true) : "none";
    // Emitted in every frame that an inversion actually reaches, not just the
    // top one: a self-theming cross-origin embed would otherwise serve its own
    // dark theme and get inverted white.
    return `
:root {
  /* A site that honours prefers-color-scheme would otherwise serve its own dark
     theme, which this engine then inverts into a blinding white page. Pinning
     light gives the filter the light source it is built to invert. */
  color-scheme: light !important;
}${root}${media}
/* Its own rule, so an older parser rejecting :fullscreen cannot take the media
   rule above down with it. */
img:fullscreen, video:fullscreen, canvas:fullscreen, embed:fullscreen, object:fullscreen {
  filter: ${fullscreenMedia} !important;
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

  // The popup's dark tokens. popup/src/theme.css holds the identical set, so a
  // themed page and the extension's own UI are the same palette. Change them
  // in both places or not at all.
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

  function buildDynamicCss(s, isTop = IS_TOP, ancestor = ancestorFilter) {
    const extra = cssFilterValue(s, false);
    // Top frame only, for the same reason filter mode gates its root rule: a
    // filter on <html> rasterises the whole subtree, and an iframe's painted
    // output is part of that subtree, so a subframe emitting its own copy had
    // the sliders applied twice - brightness 130 landed on 169.
    const filterRule = extra && isTop ? `html${SP} { filter: ${extra} !important; }` : "";
    // This engine never inverts, so the only thing that reaches media is the
    // slider filter on <html> - which is exactly what washed a photograph out
    // at brightness 130 / contrast 80. Media carries the reverse unless the
    // theme is meant to reach it. At default slider values there is nothing to
    // undo, so no rule is emitted and no image pays for a filter it does not
    // need.
    //
    // A subframe emits it too, unlike the root rule above: the top frame's
    // filter rasterises a subframe's painted output, so media in there is
    // adjusted by it and needs the same reversal to come back out true to
    // colour. Which filter, though, is the top frame's to say and not this
    // frame's to guess - down to whether it inverts at all, since a top frame
    // running the other engine still filters this one's pixels.
    const applied = isTop ? s : ancestor;
    const undo = mediaUndo(applied, !isTop && !!applied && applied.mode === "filter");
    const mediaRule = undo
      ? `
img${SP}, video${SP}, embed${SP}, object${SP} {
  filter: ${undo} !important;
}
/* Fullscreen media is in the top layer, outside the <html> subtree, so the
   slider filter never reaches it - and reversing a filter that was never
   applied is what would break it. */
img:fullscreen, video:fullscreen, embed:fullscreen, object:fullscreen {
  filter: none !important;
}`
      : "";
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
${filterRule}${mediaRule}
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
  // Only the top frame measures, and the same channel carries two things a
  // subframe cannot answer for itself: the verdict, and what the top frame is
  // painting the page with. Page JS shares the window and could spoof either
  // message, but all that buys it is flipping the theme in its own iframes,
  // which the page could do to itself anyway - and the numbers it could send
  // are rebuilt in readAncestorFilter rather than trusted, because those do
  // reach a stylesheet.
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

  // Top frame: the forward filter this frame is painting its whole subtree
  // with, as the frames inside it need to see it, or null when it is painting
  // none. Dynamic mode at default sliders emits no root rule at all, so there
  // is nothing below it to reverse and it reports null too.
  function appliedFilter() {
    if (!settings) return null;
    if (!settings.enabled || siteDisabled(settings) || steppedAside(settings)) return null;
    const v = effective(settings);
    if (v.mode !== "filter" && !cssFilterValue(v, false)) return null;
    return {
      mode: v.mode === "filter" ? "filter" : "dynamic",
      brightness: v.brightness,
      contrast: v.contrast,
      sepia: v.sepia,
      grayscale: v.grayscale,
      themeImages: !!v.themeImages
    };
  }

  // Subframe: the same value, rebuilt from whatever arrived rather than taken
  // as sent. The channel is a window message, so any script on the page can
  // post one, and these numbers are printed straight into this frame's
  // stylesheet - a string that survived would close the declaration and let a
  // page write rules into a cross-origin subframe, which is a great deal more
  // than the theme-flipping the channel already tolerates.
  function readAncestorFilter(f) {
    if (!f || typeof f !== "object") return null;
    // Out of range or not a number at all (NaN fails both comparisons) falls
    // back to the neutral value, which contributes nothing to the reversal.
    const num = (v, lo, hi, dflt) => (typeof v === "number" && v >= lo && v <= hi ? v : dflt);
    return {
      mode: f.mode === "filter" ? "filter" : "dynamic",
      brightness: num(f.brightness, 50, 150, 100),
      contrast: num(f.contrast, 50, 150, 100),
      sepia: num(f.sepia, 0, 100, 0),
      grayscale: num(f.grayscale, 0, 100, 0),
      themeImages: f.themeImages === true
    };
  }

  function currentVerdict() {
    return { type: MSG_VERDICT, dark: nativeDark, filter: appliedFilter() };
  }

  // Sent whenever what a subframe is compensating for could have moved, which
  // is every applyTheme in the top frame: the verdict changing, the settings
  // changing, this site being excluded or force-themed, the remembered hint
  // landing. Deduplicated, because most of those leave the answer identical.
  let lastBroadcast = "";

  function broadcast() {
    if (!IS_TOP) return;
    const msg = currentVerdict();
    const key = JSON.stringify(msg);
    if (key === lastBroadcast) return;
    lastBroadcast = key;
    for (const w of childFrames) {
      try {
        w.postMessage(msg, "*");
      } catch (e) {
        /* frame navigated away */
      }
    }
  }

  // Relative luminance, sRGB components in 0..1.
  function rgbIsDark(r, g, b) {
    const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) < 0.2;
  }

  // true / false / null for "cannot tell" - transparent, translucent, or a
  // syntax this does not parse. Failing toward light is the safe direction:
  // the theme just applies, which is the behaviour the user installed.
  function colorIsDark(color) {
    // Alpha first, whichever syntax carries it. A see-through background says
    // nothing about what the page renders, so it is "cannot tell" regardless of
    // the colour underneath. Modern syntax puts it after a slash -
    // `oklab(0 0 0 / 0.1)`, which is what a Tailwind 4 `bg-black/10` computes
    // to - and legacy rgba() puts it fourth. Reading only the legacy form let a
    // faint tint on an otherwise white <body> read as opaque black, and since
    // <body> is measured first that one value decided the whole verdict: the
    // engine switched itself off on a white page.
    const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(color);
    if (slash && Number(slash[1]) / (slash[2] === "%" ? 100 : 1) < 0.5) return null;

    let m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(color);
    if (m) {
      if (m[4] !== undefined && Number(m[4]) < 0.5) return null; // see-through
      return rgbIsDark(Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255);
    }
    // `color(srgb 0.07 0.09 0.11)` is what Chrome returns for a background
    // built with `color-mix(in srgb, ...)` or relative colour syntax - both
    // common in current design systems. Wider gamuts take the same path: the
    // component values differ slightly from their sRGB equivalents, but never
    // enough to move a colour across the light/dark line.
    m = /^color\(\s*(?:srgb|display-p3|a98-rgb|prophoto-rgb|rec2020)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(color);
    if (m) return rgbIsDark(Number(m[1]), Number(m[2]), Number(m[3]));

    // Chrome preserves the other modern notations as written (Tailwind 4 emits
    // oklch); in all of them the first component is lightness.
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

  // The measurement cannot happen before DOMContentLoaded - at document_start
  // there is nothing styled to read - but the theme goes on as soon as the
  // settings read resolves, which is far earlier. In filter mode that gap put
  // invert(1) over a site serving its own dark theme, so the page rendered
  // blinding white from first paint until the verdict, on every single visit.
  //
  // The last verdict for the host is remembered so the next load can theme that
  // gap the way the previous one ended. It is a hint, not a decision: the
  // measurement still runs and overrules it in either direction, so a site that
  // changes its mind corrects itself within one load. Kept in storage.local -
  // it is a per-machine observation about a page, not a preference worth
  // syncing across the profile's devices.
  const HINT_KEY = "nativeDarkHosts";
  const HINT_LIMIT = 200; // oldest fall off; a hint is only ever an optimisation

  function rememberVerdict(dark) {
    chrome.storage.local.get({ [HINT_KEY]: [] }, (stored) => {
      if (chrome.runtime.lastError) return;
      const list = (Array.isArray(stored[HINT_KEY]) ? stored[HINT_KEY] : []).filter(
        (h) => h !== HOST
      );
      if (dark) list.push(HOST);
      chrome.storage.local.set({ [HINT_KEY]: list.slice(-HINT_LIMIT) }, () => {
        if (chrome.runtime.lastError) {
          /* quota or a dead bridge - the hint is disposable, so let it go */
        }
      });
    });
  }

  function checkNativeDark() {
    if (!IS_TOP || !settings || !document.body) return;
    // rememberVerdict below is a chrome.* call, and those throw outright once
    // the extension is reloaded, disabled or updated. The dead-check poll never
    // gets here first: the rechecks that reach this run 1s and 3s in, against a
    // 5s poll. On a page the engine stepped aside from there is no poll at all -
    // nothing is injected there, so applyTheme stops it, while these timers keep
    // running - which is why the frame has to reclaim itself from this path too.
    if (!alive()) {
      teardown();
      return;
    }
    // Measured only while the result could matter; when the extension or the
    // site is off, or auto-skip is off, the verdict is simply "not stepping
    // aside" and the page is never touched for it.
    const worth = settings.enabled && !siteDisabled(settings) && settings.autoSkipNativeDark;
    const verdict = worth ? measurePageDark() : false;
    // Recorded only from a real measurement. A "false" that merely means "not
    // measured because the feature is off" must not erase what the last real
    // look at this site found.
    if (worth) rememberVerdict(verdict);
    if (verdict === nativeDark) return;
    nativeDark = verdict;
    // Carries the new verdict down to the subframes, along with whatever it did
    // to what this frame is painting them with.
    applyTheme();
  }

  function armDetection() {
    if (!IS_TOP || detectionArmed) return;
    detectionArmed = true;
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
      // Answered directly rather than through broadcast(): this frame has heard
      // nothing yet, whether or not the answer has changed since the last one
      // went out. That is also the whole of the fix for a frame that asks
      // before this one has settings or a hint - it gets the state as it stands
      // now, and the next applyTheme corrects it.
      try {
        e.source.postMessage(currentVerdict(), "*");
      } catch (err) {
        /* frame navigated away */
      }
    });
  } else {
    window.addEventListener("message", (e) => {
      if (e.source !== window.top) return;
      const d = e.data;
      if (!d || d.type !== MSG_VERDICT || typeof d.dark !== "boolean") return;
      const filter = readAncestorFilter(d.filter);
      const same =
        d.dark === nativeDark && JSON.stringify(filter) === JSON.stringify(ancestorFilter);
      if (same) return;
      nativeDark = d.dark;
      ancestorFilter = filter;
      // Re-renders the sheet: the media rule is built from what arrived here,
      // so a frame that has just learnt what it is sitting inside has to build
      // it again.
      if (settings) applyTheme();
    });
    // Asked at script start rather than after the settings read, so the round
    // trip overlaps that read instead of following it: until the answer lands
    // this frame assumes nothing is filtering it and leaves its media alone.
    try {
      window.top.postMessage(MSG_QUERY, "*");
    } catch (e) {
      /* detached frame */
    }
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
    // Every route by which this frame's own answer can move ends here - the
    // settings read, a settings change, a fresh verdict, the remembered hint -
    // so this is the one place the frames inside it have to be told. Ahead of
    // the work below because it reads the same state that decides it, and a
    // no-op in a subframe and whenever the answer has not actually moved.
    broadcast();
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
    // Whether to theme is answered above from the shared settings; how to paint
    // is answered here, from this site's own theme if it has one.
    const view = effective(settings);
    const css = buildCss(view);
    if (style.textContent !== css) style.textContent = css;

    if (view.mode === "filter") stopShadow();
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

  function begin(stored) {
    settings = stored;
    // Replay anything that landed while the read was in flight.
    if (pending) {
      mergeChanges(pending);
      pending = null;
    }
    applyTheme();
    // Releases the pre-paint stylesheet registered by the service worker.
    // Strictly before detection is armed: early.css paints <html> dark, and on
    // a page that is already past DOMContentLoaded - every tab open at install
    // or re-enable time - the first measurement runs synchronously from
    // armDetection(). A light site that leaves <body> transparent would have
    // had nothing else to measure, so the engine read the pre-paint sheet's own
    // colour and switched itself off on a white page.
    document.documentElement.setAttribute(READY_ATTR, "");
    armDetection();
  }

  // Both reads are issued at once and the theme waits for the pair. Chaining
  // them would be simpler, but the hint has to be in place before applyTheme
  // runs, so chaining would put a second storage round-trip in front of every
  // page's theme - doubling the window early.css exists to cover, to save a
  // flash that only filter mode suffers.
  //
  // Only the top frame carries a hint: a subframe never measures, and nothing
  // in its own CSS is spoiled by not having one - it waits for the verdict the
  // top frame sends.
  let hintRead = !IS_TOP;
  let firstSettings = null;

  function beginWhenReady() {
    if (!hintRead || !firstSettings) return;
    begin(firstSettings);
  }

  if (IS_TOP) {
    chrome.storage.local.get({ [HINT_KEY]: [] }, (local) => {
      const list = chrome.runtime.lastError || !local ? [] : local[HINT_KEY];
      nativeDark = Array.isArray(list) && list.includes(HOST);
      hintRead = true;
      beginWhenReady();
    });
  }
  chrome.storage.sync.get(DEFAULTS, (stored) => {
    firstSettings = stored;
    beginWhenReady();
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
