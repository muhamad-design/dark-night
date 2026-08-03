// Settings shape and the pure rules around it. Kept free of React and of the
// chrome APIs so the same functions can be exercised directly by the harness.

export type Mode = "dynamic" | "filter";

export interface Settings {
  enabled: boolean;
  mode: Mode;
  brightness: number;
  contrast: number;
  sepia: number;
  grayscale: number;
  themeImages: boolean;
  disabledSites: string[];
  autoSkipNativeDark: boolean;
  forcedSites: string[];
  siteOverrides: Record<string, SiteTheme>;
}

// The controls a site can keep its own copy of - everything that decides how a
// page is painted. The policy settings (the master switch, the exclusion list,
// auto-skip) are deliberately not here: those are decisions about *whether* to
// theme, and they already have per-site answers of their own.
export const THEME_KEYS = [
  "mode",
  "brightness",
  "contrast",
  "sepia",
  "grayscale",
  "themeImages"
] as const;

export type SiteTheme = Pick<Settings, (typeof THEME_KEYS)[number]>;

export const DEFAULTS: Settings = {
  enabled: true,
  mode: "dynamic",
  brightness: 100,
  contrast: 100,
  sepia: 0,
  grayscale: 0,
  // Off by default: an extension that repaints a page has no way of knowing
  // whether a given image is a screenshot that should follow the theme or a
  // photograph that should not, and getting a photograph wrong is the more
  // visible failure. Opt in per site if the pages you read are mostly the
  // former.
  themeImages: false,
  disabledSites: [],
  autoSkipNativeDark: true,
  forcedSites: [],
  siteOverrides: {}
};

export const SLIDERS = ["brightness", "contrast", "sepia", "grayscale"] as const;
export type SliderKey = (typeof SLIDERS)[number];

export const RANGES: Record<SliderKey, [number, number]> = {
  brightness: [50, 150],
  contrast: [50, 150],
  sepia: [0, 100],
  grayscale: [0, 100]
};

// Every range spans 100, so one step size gives all four sliders the same ten
// intervals and the same tick spacing. The slider draws a tick per step and
// stops drawing them past 50, so a fine step would silently render no ticks
// at all.
export const STEPS: Record<SliderKey, number> = {
  brightness: 10,
  contrast: 10,
  sepia: 10,
  grayscale: 10
};

export const MODE_HINT: Record<Mode, string> = {
  dynamic: "Repaints the page with a dark palette. Keeps photos true to colour.",
  filter: "Inverts the whole page. Works anywhere, less precise on complex layouts."
};

export const bare = (host: string) => host.replace(/^www\./, "");

// Must mirror siteDisabled() in content.js, or the popup reports the wrong
// state on a subdomain of a disabled site.
export function matches(host: string, entry: string) {
  const d = bare(entry);
  return host === d || host.endsWith("." + d);
}

// The entry responsible for excluding a host. It is not always the host itself:
// browsing docs.example.com while "example.com" is excluded is a parent match,
// and removing that entry would re-enable every other subdomain. An exact entry
// wins over a parent one regardless of list order, so the button always offers
// the narrowest thing it can remove first.
export function blockingEntry(host: string | null, disabledSites: string[]) {
  if (!host) return null;
  const h = bare(host);
  if (disabledSites.includes(h)) return h;
  return disabledSites.find((d) => matches(h, d)) ?? null;
}

export function pickTheme(s: Settings): SiteTheme {
  return {
    mode: s.mode,
    brightness: s.brightness,
    contrast: s.contrast,
    sepia: s.sepia,
    grayscale: s.grayscale,
    themeImages: s.themeImages
  };
}

// The theme a host is painted with: its own if it has one, otherwise the shared
// settings. Matched on the exact host, unlike the exclusion list, which matches
// suffixes. Excluding a domain is meant to cover everything under it; a visual
// tuning is a response to one site's design, and docs.example.com rarely wants
// what example.com wanted.
export function siteTheme(host: string | null, overrides: Record<string, SiteTheme>) {
  return host ? overrides[bare(host)] : undefined;
}

// A value synced from another version - or a corrupt one - must not brick the
// popup, so everything is coerced back into range on read.
export function sanitize(raw: Partial<Settings> | Record<string, unknown>): Settings {
  const s = { ...DEFAULTS, ...(raw as Partial<Settings>) };
  s.enabled = s.enabled !== false;
  s.autoSkipNativeDark = s.autoSkipNativeDark !== false;
  Object.assign(s, clampTheme(s as unknown as Record<string, unknown>));
  s.disabledSites = cleanSites(s.disabledSites);
  s.forcedSites = cleanSites(s.forcedSites);
  s.siteOverrides = cleanOverrides(s.siteOverrides);
  return s;
}

// One set of range rules, applied to the shared settings and to a site's own
// copy alike - two sets would drift, and a site override is the same six values
// with the same meanings.
function clampTheme(raw: Record<string, unknown>): SiteTheme {
  const out = {
    mode: raw.mode === "filter" ? "filter" : "dynamic",
    // Unlike `enabled`, this defaults to off, so anything that is not exactly
    // true is false.
    themeImages: raw.themeImages === true
  } as SiteTheme;
  for (const key of SLIDERS) {
    const [min, max] = RANGES[key];
    const n = Number(raw[key]);
    out[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : DEFAULTS[key];
  }
  return out;
}

function cleanSites(raw: unknown): string[] {
  return Array.isArray(raw)
    ? [...new Set(raw.filter((d) => typeof d === "string" && d).map(bare))]
    : [];
}

// Stored as one object under a single key, so the whole map shares
// chrome.storage.sync's 8KB per-item budget - a few hundred sites' worth. A
// write past it is rejected, which the popup already reports and rolls back
// rather than leaving a saved-looking state that was never stored.
function cleanOverrides(raw: unknown): Record<string, SiteTheme> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, SiteTheme> = {};
  for (const [host, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!host || !value || typeof value !== "object" || Array.isArray(value)) continue;
    out[bare(host)] = clampTheme({ ...DEFAULTS, ...(value as Record<string, unknown>) });
  }
  return out;
}
