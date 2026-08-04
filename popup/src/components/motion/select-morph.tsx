"use client";

import { Check, ChevronDown } from "lucide-react";
import {
  AnimatePresence,
  motion,
  type Transition,
  useReducedMotion,
  type Variants,
} from "motion/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

// Shared-layout morph: trigger box grows into the panel and back, one surface.
const MORPH: Transition = { type: "spring", duration: 0.5, bounce: 0.22 };
// Trigger and panel header share this row so the morph stays seamless. Sized
// down from the library's default: this is a 320px popup, and a control that
// reads as a label on a section has to be smaller than the controls under it.
const ROW = "flex w-full items-center justify-between gap-1.5 px-2.5 py-1 text-xs";

const LIST: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.035, delayChildren: 0.08 } },
};
const ITEM: Variants = {
  hidden: { opacity: 0, y: -6, filter: "blur(3px)" },
  show: { opacity: 1, y: 0, filter: "blur(0px)" },
};

interface MorphContextValue {
  value: string | undefined;
  open: boolean;
  setOpen: (open: boolean) => void;
  select: (value: string) => void;
  register: (value: string, label: string) => void;
  unregister: (value: string) => void;
  labelFor: (value: string | undefined) => string | undefined;
  placeholder: string;
  setPlaceholder: (p: string) => void;
  reduce: boolean;
  layoutId: string;
  triggerId: string;
  listId: string;
  disabled: boolean;
}

const MorphContext = createContext<MorphContextValue | null>(null);

function useMorphContext(component: string) {
  const ctx = useContext(MorphContext);
  if (!ctx) throw new Error(`${component} must be used within <MorphSelect>`);
  return ctx;
}

export interface MorphSelectProps {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * Select whose trigger morphs into the panel via a shared layoutId - instead of
 * a separate dropdown opening, the trigger itself grows into the menu and
 * shrinks back, never detaching.
 */
export function MorphSelect({
  value,
  defaultValue,
  onValueChange,
  disabled = false,
  className,
  children,
}: MorphSelectProps) {
  const reduce = useReducedMotion() ?? false;
  const baseId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [internal, setInternal] = useState(defaultValue);
  // ref-counted: items render twice (hidden registrar + open panel), so a
  // label is only dropped once every copy with that value has unmounted.
  const [labels, setLabels] = useState<Map<string, { label: string; count: number }>>(new Map());
  const [placeholder, setPlaceholder] = useState("Select");

  const controlled = value !== undefined;
  const current = controlled ? value : internal;

  const select = useCallback(
    (next: string) => {
      if (!controlled) setInternal(next);
      onValueChange?.(next);
      setOpen(false);
    },
    [controlled, onValueChange],
  );

  const register = useCallback((v: string, label: string) => {
    setLabels((m) => {
      const next = new Map(m);
      next.set(v, { label, count: (m.get(v)?.count ?? 0) + 1 });
      return next;
    });
  }, []);
  const unregister = useCallback((v: string) => {
    setLabels((m) => {
      const entry = m.get(v);
      if (!entry) return m;
      const next = new Map(m);
      if (entry.count <= 1) next.delete(v);
      else next.set(v, { label: entry.label, count: entry.count - 1 });
      return next;
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  const ctx = useMemo<MorphContextValue>(
    () => ({
      value: current,
      open,
      setOpen,
      select,
      register,
      unregister,
      labelFor: (v) => (v === undefined ? undefined : labels.get(v)?.label),
      placeholder,
      setPlaceholder,
      reduce,
      layoutId: `${baseId}-surface`,
      triggerId: `${baseId}-trigger`,
      listId: `${baseId}-list`,
      disabled,
    }),
    [current, open, select, register, unregister, labels, placeholder, reduce, baseId, disabled],
  );

  return (
    <MorphContext.Provider value={ctx}>
      <div ref={rootRef} className={cn("relative", className)}>
        {children}
      </div>
    </MorphContext.Provider>
  );
}

export interface MorphSelectValueProps {
  placeholder?: string;
  className?: string;
}

export function MorphSelectValue({ placeholder, className }: MorphSelectValueProps) {
  const ctx = useMorphContext("MorphSelectValue");
  // surface the placeholder so the morph header (rendered by content) matches
  useEffect(() => {
    if (placeholder) ctx.setPlaceholder(placeholder);
  }, [placeholder, ctx.setPlaceholder]);
  const label = ctx.labelFor(ctx.value);
  return (
    <span className={cn(label ? "text-foreground" : "text-muted-foreground", className)}>
      {label ?? placeholder ?? "Select"}
    </span>
  );
}

export interface MorphSelectTriggerProps {
  className?: string;
  children: ReactNode;
}

export function MorphSelectTrigger({ className, children }: MorphSelectTriggerProps) {
  const ctx = useMorphContext("MorphSelectTrigger");
  return (
    <>
      {/* invisible sizer reserves the closed height (the morph surface is
          absolute, so this keeps surrounding layout from shifting). The value
          it holds is a hostname, so it truncates rather than widening the row
          past whatever max-width the caller put on the root. */}
      <div aria-hidden inert className={cn(ROW, "invisible rounded-lg border border-border")}>
        <span className="min-w-0 truncate">{children}</span>
        <ChevronDown className="size-3.5" />
      </div>

      <AnimatePresence initial={false} mode="popLayout">
        {!ctx.open ? (
          <motion.button
            key="trigger"
            layoutId={ctx.layoutId}
            type="button"
            id={ctx.triggerId}
            disabled={ctx.disabled}
            aria-haspopup="listbox"
            aria-expanded={ctx.open}
            aria-controls={ctx.listId}
            onClick={() => ctx.setOpen(true)}
            transition={ctx.reduce ? { duration: 0 } : MORPH}
            style={{ borderRadius: 8 }}
            className={cn(
              ROW,
              "absolute inset-x-0 top-0 z-10 border border-border-strong bg-card text-foreground outline-none transition-colors",
              "hover:border-(--color-muted-foreground) focus-visible:ring-2 focus-visible:ring-foreground/20",
              "disabled:pointer-events-none disabled:opacity-50",
              className,
            )}
          >
            <motion.span layout="position" className="min-w-0 truncate">
              {children}
            </motion.span>
            <motion.span layout="position" className="text-muted-foreground">
              <ChevronDown className="size-3.5" />
            </motion.span>
          </motion.button>
        ) : null}
      </AnimatePresence>
    </>
  );
}

export interface MorphSelectContentProps {
  className?: string;
  children: ReactNode;
}

export function MorphSelectContent({ className, children }: MorphSelectContentProps) {
  const ctx = useMorphContext("MorphSelectContent");
  const label = ctx.labelFor(ctx.value);
  return (
    <>
      {/* always-mounted, hidden - keeps item label registrations alive while
          closed so the trigger shows the selected value before first open */}
      <div className="hidden">{children}</div>

      <AnimatePresence initial={false} mode="popLayout">
        {ctx.open ? (
          <motion.div
            key="panel"
            layoutId={ctx.layoutId}
            id={ctx.listId}
            role="listbox"
            aria-labelledby={ctx.triggerId}
            transition={ctx.reduce ? { duration: 0 } : MORPH}
            style={{ borderRadius: 8 }}
            className={cn(
              // Hung from the trigger's right edge rather than stretched across
              // it: the trigger is a small label on a section header, and the
              // options it opens need more width than the label does. The
              // library's inset-x-0 would have tied the two together.
              "absolute right-0 top-0 z-30 min-w-full overflow-hidden border border-border-strong bg-card shadow-lg",
              className,
            )}
          >
            {/* header mirrors the trigger (continuous morph) and collapses the
                panel back into the trigger when clicked */}
            <motion.button
              type="button"
              layout="position"
              aria-expanded
              onClick={() => ctx.setOpen(false)}
              className={cn(ROW, "outline-none")}
            >
              <span className={cn("min-w-0 truncate", label ? "text-foreground" : "text-muted-foreground")}>
                {label ?? ctx.placeholder}
              </span>
              <motion.span
                animate={{ rotate: 180 }}
                transition={ctx.reduce ? { duration: 0 } : MORPH}
                className="text-muted-foreground"
              >
                <ChevronDown className="size-3.5" />
              </motion.span>
            </motion.button>

            <div className="h-px bg-border" />

            <motion.ul
              initial="hidden"
              animate="show"
              variants={ctx.reduce ? undefined : LIST}
              className="p-1"
            >
              {children}
            </motion.ul>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

export interface MorphSelectItemProps {
  value: string;
  /** What the trigger and panel header show for this item. Required once the
      children are richer than a string - otherwise the raw value leaks into
      the trigger. */
  label?: string;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

export function MorphSelectItem({
  value,
  label: labelProp,
  disabled = false,
  className,
  children,
}: MorphSelectItemProps) {
  const ctx = useMorphContext("MorphSelectItem");
  const selected = ctx.value === value;
  const label = labelProp ?? (typeof children === "string" ? children : value);

  useLayoutEffect(() => {
    ctx.register(value, label);
    return () => ctx.unregister(value);
  }, [ctx.register, ctx.unregister, value, label]);

  return (
    <motion.li variants={ctx.reduce ? undefined : ITEM}>
      <button
        type="button"
        role="option"
        aria-selected={selected}
        disabled={disabled}
        onClick={() => ctx.select(value)}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-none transition-colors",
          selected
            ? "bg-foreground/6 text-foreground"
            : "text-muted-foreground hover:bg-foreground/6 hover:text-foreground focus-visible:bg-foreground/6",
          "disabled:pointer-events-none disabled:opacity-50",
          className,
        )}
      >
        {children}
        {selected ? <Check className="size-3.5 shrink-0 text-accent" /> : null}
      </button>
    </motion.li>
  );
}
