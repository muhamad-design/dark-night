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
  disabledSites: string[];
  autoSkipNativeDark: boolean;
  forcedSites: string[];
}

export const DEFAULTS: Settings = {
  enabled: true,
  mode: "dynamic",
  brightness: 100,
  contrast: 100,
  sepia: 0,
  grayscale: 0,
  disabledSites: [],
  autoSkipNativeDark: true,
  forcedSites: []
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
// intervals and the same tick spacing. beUI draws a tick per step and stops
// drawing them past 50, so a fine step would silently render no ticks at all.
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

// A value synced from another version - or a corrupt one - must not brick the
// popup, so everything is coerced back into range on read.
export function sanitize(raw: Partial<Settings> | Record<string, unknown>): Settings {
  const s = { ...DEFAULTS, ...(raw as Partial<Settings>) };
  s.enabled = s.enabled !== false;
  s.mode = s.mode === "filter" ? "filter" : "dynamic";
  for (const key of SLIDERS) {
    const [min, max] = RANGES[key];
    const n = Number(s[key]);
    s[key] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : DEFAULTS[key];
  }
  s.autoSkipNativeDark = s.autoSkipNativeDark !== false;
  s.disabledSites = cleanSites(s.disabledSites);
  s.forcedSites = cleanSites(s.forcedSites);
  return s;
}

function cleanSites(raw: unknown): string[] {
  return Array.isArray(raw)
    ? [...new Set(raw.filter((d) => typeof d === "string" && d).map(bare))]
    : [];
}
