import { describe, expect, test } from "bun:test";
import { HIDDEN_BUTTONS_KEY, ROW_BUTTONS, readHiddenButtons, toggleButton } from "../core/row-buttons";

describe("row buttons", () => {
  test("every button shows until one is hidden", () => {
    expect(readHiddenButtons(null)).toEqual([]);
  });

  test("hidden buttons are stored as a comma list; unknown names are dropped", () => {
    expect(readHiddenButtons("bell,new-session,gone")).toEqual(["bell", "new-session"]);
  });

  test("toggling shows or hides one, in the list's order", () => {
    expect(toggleButton([], "github", false)).toEqual(["github"]);
    expect(toggleButton(["github"], "bell", false)).toEqual(["bell", "github"]);
    expect(toggleButton(["bell", "github"], "bell", true)).toEqual(["github"]);
  });

  test("each button has a label for the menu", () => {
    expect(ROW_BUTTONS.map((b) => b.id)).toEqual(["session", "bell", "run", "watch", "new-session", "github"]);
    expect(ROW_BUTTONS.every((b) => b.label.length > 0)).toBe(true);
    expect(HIDDEN_BUTTONS_KEY).toBe("pr-watch.hiddenButtons");
  });
});
