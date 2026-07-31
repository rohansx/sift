import { Badge } from "@/components/ui/badge";
import type { DeltaSeverity, ThemeState } from "../../../src/types.ts";

/**
 * The terminal's colour vocabulary, one for one.
 *
 * `sift report` paints regressed red, new yellow, resolved green and muted dim,
 * and someone reading the browser next to the terminal is reading the same
 * incident — a state that is red in one place and blue in the other costs them
 * a second look every time. Tailwind's palette rather than a new set of theme
 * tokens: only `destructive` exists as a token, and inventing four more to
 * express five states is a design system nobody asked for.
 */
const TONE: Record<ThemeState, string> = {
  regressed: "",
  active: "",
  new: "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400",
  resolved: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  muted: "text-muted-foreground",
};

function variantFor(state: ThemeState) {
  if (state === "regressed") return "destructive" as const;
  if (state === "muted") return "secondary" as const;
  return "outline" as const;
}

/**
 * A theme's state, or NEW when this is the window it first appeared in.
 *
 * The isNewHere override matches renderIssuesList exactly, including the part
 * where regressed wins: a theme that came back is not news for being back, it
 * is a regression, and that is the more urgent of the two words.
 */
export function ThemeStateBadge({ state, isNewHere = false }: { state: ThemeState; isNewHere?: boolean }) {
  const showNew = isNewHere && state !== "regressed";
  const effective: ThemeState = showNew ? "new" : state;
  const text = effective === "regressed" ? "REGRESSED" : effective === "new" ? "NEW" : effective;
  return (
    <Badge variant={variantFor(effective)} className={TONE[effective]}>
      {text}
    </Badge>
  );
}

/** The delta view's severities, which are the same words scored differently. */
export function SeverityBadge({ severity }: { severity: DeltaSeverity }) {
  if (severity === "regression") return <Badge variant="destructive">REGRESSED</Badge>;
  if (severity === "new") return <Badge variant="outline" className={TONE.new}>NEW</Badge>;
  if (severity === "notable")
    return (
      <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-400">
        notable
      </Badge>
    );
  return <Badge variant="secondary">info</Badge>;
}
