/** The icons a PR line can show, in the order they appear, each of which the user can hide. */
export const ROW_BUTTONS: readonly { readonly id: "session" | "run" | "watch" | "new-session" | "github"; readonly label: string; readonly hint?: string }[] = [
  { id: "session", label: "Open the watching session" },
  { id: "run", label: "Open the workflow run" },
  { id: "watch", label: "Watch or stop watching", hint: "When hidden, only unwatch_pr stops a watch" },
  { id: "new-session", label: "New session about this PR" },
  { id: "github", label: "Open the PR on GitHub" },
];

export type RowButton = (typeof ROW_BUTTONS)[number]["id"];

/** One choice for every session and the pill: how a line looks, not what the list shows. */
export const HIDDEN_BUTTONS_KEY = "pr-watch.hiddenButtons";

/** Stored as a comma list; unknown names are dropped, and nothing stored means every button shows. */
export function readHiddenButtons(stored: string | null): RowButton[] {
  if (!stored) return [];
  const names = stored.split(",");
  return ROW_BUTTONS.map((b) => b.id).filter((id) => names.includes(id));
}

/** The hidden buttons after showing or hiding one. */
export function toggleButton(hidden: readonly RowButton[], button: RowButton, show: boolean): RowButton[] {
  return ROW_BUTTONS.map((b) => b.id).filter((id) => (id === button ? !show : hidden.includes(id)));
}
