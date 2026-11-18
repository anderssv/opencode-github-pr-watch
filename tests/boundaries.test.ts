import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Filters, grouping and the pill only choose what is shown; whether a watch starts, runs or ends is decided by the
// watch lifecycle alone. Keeping the two from importing each other keeps it that way.
const VIEW = ["core/prs-view.ts", "core/store.ts", "core/panel-text.ts", "core/panel-operations.ts", "core/demo.ts"];
const LIFECYCLE = ["index.ts", "core/watcher.ts", "core/policy.ts", "core/lifecycle.ts", "core/actor.ts", "core/watch-rows.ts"];

const imports = (file: string) =>
  [...readFileSync(join(import.meta.dir, "..", file), "utf8").matchAll(/from "(\.{1,2}\/[^"]+)"/g)].map((m) => m[1]!.replace(/^.*\//, ""));
const names = (files: readonly string[]) => files.map((f) => f.replace(/^.*\//, "").replace(/\.ts$/, ""));

describe("views and the watch lifecycle are kept apart", () => {
  test("lifecycle code doesn't use the views' choices", () => {
    for (const file of LIFECYCLE) expect({ file, imports: imports(file).filter((i) => names(VIEW).includes(i)) }).toEqual({ file, imports: [] });
  });

  test("views don't start, judge or end watches", () => {
    const changing = ["watcher", "policy", "lifecycle"];
    for (const file of VIEW) expect({ file, imports: imports(file).filter((i) => changing.includes(i)) }).toEqual({ file, imports: [] });
  });
});
