import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Switch } from "@/components/motion/switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { RangeSlider } from "@/components/motion/range-slider";
import { Button } from "@/components/motion/button/base";
import { TextShimmer } from "@/components/motion/text-shimmer";
import { EASE_OUT, SPRING_LAYOUT } from "@/lib/ease";
import {
  MODE_HINT,
  RANGES,
  SLIDERS,
  STEPS,
  bare,
  blockingEntry,
  type Mode,
  type SliderKey
} from "@/lib/settings";
import { useSettings } from "@/lib/use-settings";

const SLIDER_LABEL: Record<SliderKey, string> = {
  brightness: "Brightness",
  contrast: "Contrast",
  sepia: "Sepia",
  grayscale: "Grayscale"
};

// Shown only if the settings read is slow enough to notice. Rendering the UI
// with default values first and snapping to the real ones is the jump we are
// avoiding, so nothing real is drawn until the values are known.
function Skeleton() {
  return (
    <div id="skeleton" className="flex flex-col gap-3 p-4" aria-hidden>
      <TextShimmer className="text-xs">Loading settings</TextShimmer>
      <div className="h-8 rounded-full bg-card" />
      <div className="h-9 rounded-lg bg-card" />
      <div className="h-10 rounded-lg bg-card" />
      <div className="h-10 rounded-lg bg-card" />
    </div>
  );
}

export default function App() {
  const { settings, loaded, currentSite, status, statusIsError, save, setStatus } = useSettings();
  const listRef = useRef<HTMLUListElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const focusAfterRemove = useRef<number | null>(null);
  const [slowLoad, setSlowLoad] = useState(false);

  // A storage read normally resolves in a few milliseconds. Flashing a skeleton
  // for that long is worse than showing nothing, so it only appears if the read
  // is actually slow.
  useEffect(() => {
    if (loaded) return;
    const t = setTimeout(() => setSlowLoad(true), 120);
    return () => clearTimeout(t);
  }, [loaded]);

  const entry = blockingEntry(currentSite, settings.disabledSites);
  const host = currentSite ? bare(currentSite) : null;
  const excludedByParent = !!entry && entry !== host;

  function toggleSite() {
    if (!host) return;
    if (entry) {
      const next = settings.disabledSites.filter((d) => d !== entry);
      save({ disabledSites: next });
      // A broader rule can still cover this host, so do not claim it is back on
      // until the state after the removal actually says so.
      const remaining = blockingEntry(currentSite, next);
      setStatus(
        remaining ? `Removed ${entry} - still excluded by ${remaining}` : `Re-enabled ${entry}`
      );
    } else {
      save({ disabledSites: [...settings.disabledSites, host] });
      setStatus(`Excluded ${host}`);
    }
  }

  function removeSite(site: string, index: number) {
    save({ disabledSites: settings.disabledSites.filter((d) => d !== site) });
    setStatus(`Re-enabled ${site}`);
    focusAfterRemove.current = index;
  }

  // Restoring focus has to happen after the list has re-rendered, and it has to
  // be an effect rather than a rAF callback: rAF is paused in a background tab,
  // which would silently strand keyboard users.
  useEffect(() => {
    const index = focusAfterRemove.current;
    if (index === null) return;
    focusAfterRemove.current = null;
    const rows = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-remove]");
    if (rows?.length) rows[Math.min(index, rows.length - 1)]?.focus();
    else summaryRef.current?.focus();
  }, [settings.disabledSites]);

  if (!loaded) {
    return (
      <div className="flex flex-col" data-loaded="false">
        {slowLoad ? <Skeleton /> : null}
      </div>
    );
  }

  const count = settings.disabledSites.length;
  const off = !settings.enabled;

  return (
    <div className="flex flex-col" data-loaded="true">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="text-[15px] font-semibold tracking-tight text-foreground">Dark Night</span>
        <Switch
          checked={settings.enabled}
          onCheckedChange={(next) => save({ enabled: next })}
          ariaLabel="Dark mode on all sites"
        />
      </header>

      {/* Per-site ------------------------------------------------------- */}
      <section className="border-b border-border px-4 py-3">
        <div
          id="siteName"
          className="mb-2 truncate font-mono text-xs text-muted-foreground"
          title={currentSite ?? undefined}
        >
          {currentSite ?? "Not available on this page"}
        </div>
        <Button
          id="siteToggle"
          variant={entry ? "primary" : "secondary"}
          size="sm"
          disabled={!currentSite || off}
          onClick={toggleSite}
          className="w-full justify-center"
        >
          {entry ? (excludedByParent ? `Enable ${entry}` : "Enable for this site") : "Disable for this site"}
        </Button>
        {/* Exit-only. An entrance animation gates the content on a frame loop:
            under reduced motion or a stalled rAF the note is left invisible. */}
        <AnimatePresence initial={false}>
          {(excludedByParent || !currentSite) && (
            <motion.p
              id="siteNote"
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.22, ease: EASE_OUT }}
              className="overflow-hidden text-[11px] leading-snug text-muted-foreground"
            >
              <span className="mt-2 block">
                {excludedByParent
                  ? `Excluded by the rule for ${entry}.`
                  : "Chrome does not allow theming here."}
              </span>
            </motion.p>
          )}
        </AnimatePresence>
      </section>

      {/* Engine --------------------------------------------------------- */}
      <section className="border-b border-border px-4 py-3" inert={off ? true : undefined}>
        <Tabs
          value={settings.mode}
          onValueChange={(v) => save({ mode: v as Mode })}
          variant="segment"
        >
          {/* TabsTrigger wraps its button in a positioning div, so the flex
              child is that wrapper, not the button. Widening the wrapper from
              here keeps the vendored beUI component untouched. */}
          <TabsList className="flex w-full [&>div]:flex-1 [&>div]:basis-0">
            <TabsTrigger value="dynamic" className="w-full">
              Dynamic
            </TabsTrigger>
            <TabsTrigger value="filter" className="w-full">
              Filter
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {/* Keyed so the text swaps immediately on a mode change, and with no
            entrance animation so opening the popup never fades anything in. */}
        <p id="modeHint" className="mt-2 text-[11px] leading-snug text-muted-foreground">
          <span key={settings.mode} className="block">
            {MODE_HINT[settings.mode]}
          </span>
        </p>
      </section>

      {/* Sliders -------------------------------------------------------- */}
      <section className="flex flex-col gap-3 px-4 py-3" inert={off ? true : undefined}>
        {SLIDERS.map((key) => (
          <div key={key} data-slider={key}>
            <div className="mb-1 flex items-baseline justify-between">
              <span className="text-xs text-foreground">{SLIDER_LABEL[key]}</span>
              <span data-value={key} className="font-mono text-xs tabular-nums text-muted-foreground">
                {settings[key]}%
              </span>
            </div>
            <RangeSlider
              value={settings[key]}
              min={RANGES[key][0]}
              max={RANGES[key][1]}
              step={STEPS[key]}
              showTicks
              onValueChange={(v) => save({ [key]: v }, { defer: true })}
              formatValueText={(v) => `${SLIDER_LABEL[key]} ${v}%`}
            />
          </div>
        ))}
      </section>

      <footer className="flex items-center justify-between px-4 pb-3" inert={off ? true : undefined}>
        <Button
          id="reset"
          variant="ghost"
          size="sm"
          onClick={() => {
            save({ brightness: 100, contrast: 100, sepia: 0, grayscale: 0 });
            setStatus("Sliders reset");
          }}
        >
          Reset sliders
        </Button>
        <kbd className="rounded-md border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          Alt+Shift+D
        </kbd>
      </footer>

      {/* Excluded sites -------------------------------------------------- */}
      <section className="border-t border-border">
        <details className="group">
          <summary
            ref={summaryRef as never}
            tabIndex={0}
            id="excludedToggle"
            className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <span aria-hidden className="inline-block text-[9px] transition-transform group-open:rotate-90">
              ▶
            </span>
            <span id="excludedCount">
              {count ? `${count} site${count === 1 ? "" : "s"} excluded` : "No sites excluded"}
            </span>
          </summary>
          <ul ref={listRef} id="excludedList" className="max-h-44 overflow-y-auto px-3 pb-2">
            {/* Rows animate on exit only - see the note above. */}
            <AnimatePresence initial={false}>
              {settings.disabledSites.map((site, i) => (
                <motion.li
                  key={site}
                  exit={{ opacity: 0, height: 0 }}
                  transition={SPRING_LAYOUT}
                  className="flex items-center gap-2 overflow-hidden"
                >
                  <span className="flex-1 truncate py-1 pl-1 font-mono text-sm text-foreground">
                    {site}
                  </span>
                  <button
                    data-remove={site}
                    type="button"
                    aria-label={`Re-enable ${site}`}
                    onClick={() => removeSite(site, i)}
                    className="grid size-8 shrink-0 place-items-center rounded-md text-base text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
                  >
                    ×
                  </button>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </details>
      </section>

      {/* Status ---------------------------------------------------------- */}
      <AnimatePresence initial={false}>
        {status && (
          <motion.p
            id="status"
            role="status"
            aria-live="polite"
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.24, ease: EASE_OUT }}
            className="overflow-hidden border-t border-border"
            data-error={statusIsError ? "true" : "false"}
          >
            <span
              className="block px-4 py-2 text-[11px] leading-snug"
              style={{ color: statusIsError ? "var(--danger)" : "var(--muted-foreground)" }}
            >
              {status}
            </span>
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
