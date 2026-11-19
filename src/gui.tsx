import { createSignal, For, Index, onCleanup, onMount, Show, type JSX } from "solid-js";
import { createStore } from "solid-js/store";
import { ComposerPill, createKeyed, Panel, Plugin, Style, type ComposerPillTone, type IconName } from "@opencode/plugin/gui";
import { PRS_TAB } from "../core/panel-tab";
import type { MyPr, MyPrSort } from "../core/my-prs";
import type { Topic } from "../core/topics";
import { activities as trackActivities, errorText, panelOperations, type LoadedPrs, type PanelPort, type PanelSession } from "../core/panel-operations";
import { DEMO_KEY, demoPort } from "../core/demo";
import { emptyStore, sessionRows, update, type Change, type Store } from "../core/store";
import { lineDetail, pillView, prOfRow } from "../core/panel-text";
import { ALL_STATUSES, choiceWrites, prsView, readSessionChoices, STATUS_LABELS, statusSummary, toggleStatus, type Grouping, type PrsChoices } from "../core/prs-view";
import { PrWatch } from "../rpc";
import { STAGE_MARKS as STAGE_MARK, type Stage, type StageState } from "../core/progress";
import { COLLAPSED_GROUPS_KEY, groupKey, readCollapsed, toggleCollapsed } from "../core/collapsed-groups";
import { HIDDEN_BUTTONS_KEY, ROW_BUTTONS, readHiddenButtons, toggleButton, type RowButton } from "../core/row-buttons";

interface Row {
  readonly id: string;
  readonly label: string;
  readonly url: string;
  readonly detail: string;
  readonly tone: "pending" | "waiting" | "failed" | "done";
  readonly track?: readonly Stage[];
  readonly attention?: true;
  readonly updating?: true;
  readonly runUrl?: string;
  readonly waitingFor?: "code-review" | "run-approval";
  readonly runLinks?: readonly { readonly label: string; readonly url: string }[];
  /** The session watching it, in the panel's list. */
  readonly sessionID?: string;
  readonly sessionTitle?: string;
}

const LOOK: Record<Row["tone"], { icon: IconName; tone?: ComposerPillTone }> = {
  pending: { icon: "status-active" },
  waiting: { icon: "circle-exclamation", tone: "warning" },
  failed: { icon: "circle-x", tone: "danger" },
  done: { icon: "circle-check", tone: "success" },
};

type PrGroupView = { readonly name: string; readonly kind: "repo" | "topic" | "all"; readonly prs: readonly MyPr[] };

// The icon each button shows on a PR line, for the menu that hides them.
const BUTTON_ICONS: Record<RowButton, IconName> = {
  session: "speech-bubble",
  run: "settings-gear",
  watch: "eye",
  "new-session": "new-session",
  github: "github",
};

const STAGE_LOOK: Record<StageState, Record<string, string>> = {
  done: { color: "var(--text-success, #3fb950)" },
  running: { opacity: "0.85" },
  waiting: { color: "var(--text-warning, #d29922)" },
  failed: { color: "var(--text-danger, #e5534b)" },
  upcoming: { opacity: "0.4" },
};

const TITLE = "Watched pull requests";
const SORTS: readonly { value: MyPrSort; label: string }[] = [
  { value: "name", label: "Sort by: Name" },
  { value: "newest", label: "Sort by: Newest PR" },
  { value: "oldest", label: "Sort by: Oldest PR" },
];
const SELECT_STYLE = { flex: "1 1 150px", "min-width": "150px", "box-sizing": "border-box" as const, height: "30px", padding: "4px 6px", "border-radius": "6px", background: "transparent", color: "inherit", border: "1px solid rgba(127,127,127,0.4)" };

export default Plugin.define({
  setup(ctx) {
    // Shared by the pill and the PRs tab, so hiding a button applies to every line.
    const [hiddenButtons, setHiddenButtons] = createSignal<readonly RowButton[]>(readHiddenButtons(localStorage.getItem(HIDDEN_BUTTONS_KEY)));
    const [collapsed, setCollapsed] = createSignal<readonly string[]>(readCollapsed(localStorage.getItem(COLLAPSED_GROUPS_KEY)));
    const toggleGroup = (key: string) => {
      const next = toggleCollapsed(collapsed(), key);
      setCollapsed(next);
      localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(next));
    };
    const shown = (button: RowButton) => !hiddenButtons().includes(button);
    const setButtonShown = (button: RowButton, show: boolean) => {
      const next = toggleButton(hiddenButtons(), button, show);
      localStorage.setItem(HIDDEN_BUTTONS_KEY, next.join(","));
      setHiddenButtons(next);
    };

    const demo = localStorage.getItem(DEMO_KEY) === "true";
    // The one store the pill and the PRs tab read. It changes only through update(): full refreshes replace its rows
    // or PR lists, and each watch's change event patches just that watch's row.
    const [store, setStore] = createSignal<Store<Row>>(emptyStore<Row>());
    const apply = (change: Change) => setStore((now) => update(now, change as Change<Row>));

    const appPort: PanelPort = {
      myPrs: async (merged) => (await ctx.client.rpc(PrWatch).myPrs({ merged })) as LoadedPrs,
      watches: async () => (await ctx.client.rpc(PrWatch).watches({})) as { rows: Row[]; me?: string; paused?: string },
      myPrTopics: async (sessionID, merged) => ((await ctx.client.rpc(PrWatch).myPrTopics({ sessionID, merged })) as { topics: Topic[] }).topics,
      watch: async (sessionID, pr) => ((await ctx.client.rpc(PrWatch).watch({ sessionID, pr })) as { message: string }).message,
      unwatch: async (id) => void (await ctx.client.rpc(PrWatch).unwatch({ id })),
      checkNow: async () => ((await ctx.client.rpc(PrWatch).checkNow({})) as { checking: boolean }).checking,
      session: async (sessionID) => {
        const current = await ctx.client.session.get({ sessionID: sessionID as never });
        return { model: current.model, agent: current.agent };
      },
      createSession: async (input) =>
        (await ctx.client.session.create({ title: input.title, location: { directory: input.directory as never }, model: input.model as never, agent: input.agent as never })).id,
      prompt: async (sessionID, text) => void (await ctx.client.session.prompt({ sessionID: sessionID as never, text })),
      openSession: (server, sessionID) => ctx.tabs.open({ server, id: sessionID as never }, { focus: true }),
      copy: (text) => ctx.system.copy(text),
    };
    const port = demo ? demoPort(() => ctx.sessions.current()?.id ?? "", Date.now) : appPort;

    // Work in progress, shown together on the PRs tab's top line with one spinner, and the latest result after it.
    const [running, setRunning] = createSignal<readonly string[]>([]);
    const tracker = trackActivities(setRunning);
    const [status, setStatus] = createSignal<string>();
    const say = (text: string) => {
      setStatus(text);
      setTimeout(() => setStatus((now) => (now === text ? undefined : now)), 6_000);
    };
    const ops = panelOperations(port, apply, { track: (text, work) => tracker.track(text, work), say });
    const refreshWatches = () => void ops.refreshWatches().catch(() => undefined);
    refreshWatches();
    const stopEvents = ctx.client.rpc(PrWatch).events.on("changed", (event) => {
      const data = event.data as { id?: string; row?: Row };
      if (data.id) apply({ kind: "row", id: data.id, ...(data.row ? { row: data.row } : {}) });
      else refreshWatches();
    });
    // The event can go quiet when the server part reloads, so everything is also read again now and then.
    const watchesTimer = setInterval(refreshWatches, 30_000);
    onCleanup(() => {
      stopEvents();
      clearInterval(watchesTimer);
    });
    const refresh = (ok: boolean) => {
      if (!ok) return;
      refreshWatches();
      loadMyPrs();
    };
    const stopWatching = (id: string) => void ops.stop(id).then(refresh);

    // Just waiting on a person (a review, a run approval, the merge): a pause. The host has no pause icon, so it's drawn
    // here at the host's small icon size, in the text colour like its icons.
    const PauseIcon = (): JSX.Element => (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-label="Waiting" style={{ display: "block" }}>
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" stroke-width="1.2" />
        <rect x="5.6" y="5" width="1.5" height="6" rx="0.5" fill="currentColor" />
        <rect x="8.9" y="5" width="1.5" height="6" rx="0.5" fill="currentColor" />
      </svg>
    );

    // An icon button whose label shows on hover; the host's IconButton only uses it for screen readers.
    const TipButton = (props: Parameters<typeof ctx.ui.IconButton>[0]): JSX.Element => (
      <ctx.ui.Tooltip value={props.label}>
        <ctx.ui.IconButton {...props} />
      </ctx.ui.Tooltip>
    );

    // A PR's way to production, stage by stage: green done, yellow waiting on a person, red failed, grey upcoming.
    // Each stage's name and mark, the detail ("3/5 · Build", "waiting for code review") on hover. A narrow panel wraps
    // between stages, never inside one.
    const Track = (props: { readonly stages: readonly Stage[]; readonly after?: string | undefined }): JSX.Element => (
      <div style={{ "font-size": "12px" }}>
        <Index each={props.stages}>
          {(s, i) => (
            <>
              {i > 0 ? <span style={{ opacity: "0.4" }}> · </span> : null}
              <span title={s().detail ? `${s().name}: ${s().detail}` : s().name} style={{ ...STAGE_LOOK[s().state], cursor: s().detail ? "help" : "default", "white-space": "nowrap" }}>
                {s().name}
                {STAGE_MARK[s().state] ? ` ${STAGE_MARK[s().state]}` : ""}
              </span>
            </>
          )}
        </Index>
        <Show when={props.after}>{(after) => <span style={{ opacity: "0.6", "white-space": "nowrap" }}> · {after()}</span>}</Show>
      </div>
    );

    // The one line every list shows for a PR: its watch status icon (when watched), text, then the buttons. Those that
    // only sometimes show (the run or runs) come first, so the ones always there (watch or stop, new session, the PR on
    // GitHub) stay in the same columns down the list.
    const PrLineView = (line: {
      readonly text: JSX.Element;
      readonly detail: string;
      /** Shown after the track, such as how old the PR is. */
      readonly after?: string;
      readonly url: string;
      readonly row?: Row;
      readonly onWatch?: () => void;
      readonly onStop?: () => void;
      readonly onNewSession?: () => void;
      /** Opens the session watching the PR. */
      readonly onOpenSession?: () => void;
    }): JSX.Element => {
      const runLinks = () => line.row?.runLinks ?? (line.row?.runUrl ? [{ label: "Open the run", url: line.row.runUrl }] : []);
      return (
        <div style={{ display: "flex", "align-items": "flex-start", gap: "8px", "min-width": "0" }}>
          {/* Every line has an icon here so the titles line up: the watch's state, or a dimmed ? when not watched. At the
              top, next to the title, when the text wraps. */}
          <span style={{ display: "inline-flex", "align-self": "flex-start", "margin-top": "2px" }}>
            <Show
              when={line.row}
              fallback={
                <span title="Not watched" style={{ display: "inline-flex", opacity: "0.4" }}>
                  <ctx.ui.Icon name="help" size="small" />
                </span>
              }
            >
              {(row) => (
              // The PR itself (a draft, conflicts, behind) and where it is, on hover.
              <span title={row().detail} style={{ display: "inline-flex" }}>
                <Show when={row().tone === "waiting" && !row().attention} fallback={<ctx.ui.Icon name={LOOK[row().tone].icon} size="small" />}>
                  <PauseIcon />
                </Show>
              </span>
            )}
            </Show>
          </span>
          <div style={{ flex: "1", "min-width": "0" }}>
            <div style={{ "overflow-wrap": "anywhere" }}>
              {line.text}
              <Show when={line.row?.updating}>
                <span class="pr-watch-spinning" title="Fetching the latest state from GitHub" style={{ display: "inline-flex", "vertical-align": "middle", "margin-left": "6px", opacity: "0.6" }}>
                  <ctx.ui.Icon name="refresh" size="small" />
                </span>
              </Show>
            </div>
            <Show when={line.row?.track} fallback={<div style={{ opacity: "0.6", "font-size": "12px" }}>{line.detail}</div>}>
              {(track) => <Track stages={track()} after={line.after} />}
            </Show>
          </div>
          <For each={shown("run") ? runLinks() : []}>
            {(link) => (
              // A gear for the build or deploy run; it turns while the run is still going.
              <span class={line.row?.tone === "pending" && !line.row.runLinks ? "pr-watch-spinning" : undefined} style={{ display: "inline-flex" }}>
                <TipButton icon="settings-gear" label={link.label} size="small" onClick={() => ctx.system.openExternal(link.url)} />
              </span>
            )}
          </For>
          <Show when={shown("session") && line.onOpenSession}>
            {(open) => <TipButton icon="speech-bubble" label={`Open the watching session: ${line.row?.sessionTitle ?? ""}`} size="small" onClick={() => open()()} />}
          </Show>
          <Show when={shown("watch") && line.onStop}>{(stop) => <TipButton icon="outline-eye-slash" label="Stop watching" size="small" onClick={() => stop()()} />}</Show>
          <Show when={shown("watch") && !line.onStop && line.onWatch}>{(watch) => <TipButton icon="eye" label="Watch in this session" size="small" onClick={() => watch()()} />}</Show>
          <Show when={shown("new-session") && line.onNewSession}>
            {(start) => <TipButton icon="new-session" label="New session about this PR" size="small" onClick={() => start()()} />}
          </Show>
          <Show when={shown("github")}>
            <TipButton icon="github" label="Open the PR" size="small" onClick={() => ctx.system.openExternal(line.url)} />
          </Show>
        </div>
      );
    };

    // A watch in the pill. Run watches (no PR) get no new-session button.
    const WatchLine = (props: { readonly row: Row; readonly session: PanelSession }): JSX.Element => {
      // Read live: rows are reused by position when the list reloads.
      const pr = () => prOfRow(props.row);
      return (
        <PrLineView
          text={props.row.label}
          detail={props.row.detail}
          url={props.row.url}
          row={props.row}
          onStop={() => stopWatching(props.row.id)}
          onNewSession={
            pr()
              ? () => void ops.startSession(props.session, pr()!)
              : undefined
          }
        />
      );
    };

    // The PR lists are in the store, so switching tabs or sessions shows the last list at once, and a reload replaces it
    // only when the new one has arrived.
    const [myPrsError, setMyPrsError] = createSignal<string>();
    const [myPrsLoading, setMyPrsLoading] = createSignal(0);
    const [showMerged, setShowMerged] = createSignal(false);
    const loadMyPrs = () => {
      const merged = showMerged();
      setMyPrsLoading((n) => n + 1);
      void ops
        .refreshPrs(merged)
        .then(() => setMyPrsError(undefined))
        .catch((err: unknown) => setMyPrsError(errorText(err)))
        .finally(() => setMyPrsLoading((n) => n - 1));
    };

    // Topics come from a light model on the server, for the PRs listed; like the lists they stay while new ones load.
    // The filters are each session's own; the search is kept while the app runs, but not stored.
    const [choiceStore, setChoiceStore] = createStore<Record<string, PrsChoices>>({});
    const choicesFor = (sessionID: string): PrsChoices => choiceStore[sessionID] ?? readSessionChoices((key) => localStorage.getItem(key), sessionID);
    const chooseFor = <K extends keyof PrsChoices>(sessionID: string, key: K, value: PrsChoices[K]) => {
      setChoiceStore(sessionID, { ...choicesFor(sessionID), [key]: value });
      for (const [storageKey, text] of choiceWrites(key, value, sessionID)) localStorage.setItem(storageKey, text);
    };
    const [topics, setTopics] = createSignal<readonly Topic[]>();
    const [topicsError, setTopicsError] = createSignal<string>();
    const loadTopics = (sessionID: string) => {
      if (choicesFor(sessionID).grouping !== "topic") return;
      setMyPrsLoading((n) => n + 1);
      void ops
        .loadTopics(sessionID, showMerged(), topics() !== undefined)
        .then((result) => {
          setTopics(result);
          setTopicsError(undefined);
        })
        .catch((err: unknown) => setTopicsError(errorText(err)))
        .finally(() => setMyPrsLoading((n) => n - 1));
    };

    // The gh user's open PRs, grouped by repo or topic, for the organisation picked in the dropdown, and on request the
    // PRs merged in the last 7 days.
    const MyPrsView = (props: { readonly session: { readonly id: string; readonly directory: string; readonly server: { readonly id: string } } }): JSX.Element => {
      const error = myPrsError;
      const load = () => {
        loadMyPrs();
        loadTopics(props.session.id);
      };
      const choices = () => choicesFor(props.session.id);
      const choose = <K extends keyof PrsChoices>(key: K, value: PrsChoices[K]) => chooseFor(props.session.id, key, value);
      const view = () => prsView(store(), choices(), props.session.id, topics());
      const openSession = (row: Row) => () => port.openSession(props.session.server.id, row.sessionID!);
      let statusMenu: HTMLDetailsElement | undefined;
      let buttonsMenu: HTMLDetailsElement | undefined;
      let buttonsArea: HTMLSpanElement | undefined;
      onMount(() => {
        load();
        // Watches update the store as they change; the PR search is refreshed on a timer and on reload.
        const timer = setInterval(load, 3 * 60_000);
        // The status dropdown is a <details>, which only closes on its own button: a click outside or Escape closes it too.
        const closeOutside = (event: PointerEvent) => {
          const target = event.target as Node;
          if (statusMenu?.open && !statusMenu.contains(target)) statusMenu.open = false;
          // The button that opens the button menu sits outside it, and counts as inside.
          if (buttonsMenu?.open && !buttonsArea?.contains(target)) buttonsMenu.open = false;
        };
        const closeOnEscape = (event: KeyboardEvent) => {
          if (event.key === "Escape") for (const menu of [statusMenu, buttonsMenu]) if (menu?.open) menu.open = false;
        };
        document.addEventListener("pointerdown", closeOutside);
        document.addEventListener("keydown", closeOnEscape);
        onCleanup(() => {
          clearInterval(timer);
          document.removeEventListener("pointerdown", closeOutside);
          document.removeEventListener("keydown", closeOnEscape);
        });
      });
      const PrLine = (line: { readonly pr: MyPr; readonly merged: boolean }): JSX.Element => {
        // Read live: rows are reused by position when the list reloads, so a line can show another PR next time.
        const row = () => view().watchOf(line.pr);
        return (
          <PrLineView
            text={
              <>
                <Show when={view().repoOnLine}>
                  <span style={{ opacity: "0.6" }}>{line.pr.repo.slice(line.pr.repo.indexOf("/") + 1)} </span>
                </Show>
                #{line.pr.number} {line.pr.title}
              </>
            }
            detail={lineDetail(line.pr, line.merged, row()?.detail, Date.now())}
            after={lineDetail(line.pr, line.merged, undefined, Date.now())}
            url={line.pr.url}
            row={row()}
            onStop={row() ? () => stopWatching(row()!.id) : undefined}
            onWatch={!row() && !line.merged ? () => void ops.watch(props.session.id, line.pr).then((ok) => ok && load()) : undefined}
            onOpenSession={row()?.sessionID ? openSession(row()!) : undefined}
            onNewSession={() => void ops.startSession(props.session, line.pr)}
          />
        );
      };

      const Groups = (groups: { readonly groups: readonly PrGroupView[]; readonly merged: boolean }): JSX.Element => (
        <Index each={groups.groups}>
          {(group, index) => {
            const slash = () => (group().kind === "repo" ? group().name.indexOf("/") : -1);
            const key = () => groupKey(group().kind, group().name, groups.merged);
            const open = () => !collapsed().includes(key());
            return (
              <section
                style={{
                  display: "flex", "flex-direction": "column", gap: "6px",
                  ...(index > 0 ? { "border-top": "1px solid rgba(127,127,127,0.2)", "padding-top": "12px" } : {}),
                }}
              >
                <div style={{ display: "flex", "align-items": "center", gap: "6px", "min-width": "0" }}>
                  <div
                    role="button"
                    tabindex="0"
                    aria-expanded={open()}
                    title={open() ? "Collapse this group" : "Expand this group"}
                    onClick={() => toggleGroup(key())}
                    onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && (event.preventDefault(), toggleGroup(key()))}
                    style={{ flex: "1", "min-width": "0", display: "flex", "align-items": "center", gap: "6px", cursor: "pointer" }}
                  >
                    <span style={{ width: "10px", opacity: "0.6", "font-size": "11px" }}>{open() ? "▾" : "▸"}</span>
                    <ctx.ui.Icon name={group().kind === "repo" ? "folder" : group().kind === "topic" ? "bullet-list" : "checklist"} size="small" />
                    <div style={{ flex: "1", "min-width": "0", "overflow-wrap": "anywhere" }}>
                      <span style={{ opacity: "0.6" }}>{group().name.slice(0, slash() + 1)}</span>
                      <span style={{ "font-weight": "600" }}>{group().name.slice(slash() + 1)}</span>
                    </div>
                  </div>
                  <span style={{ opacity: "0.6", "font-size": "12px" }}>{group().prs.length}</span>
                  <TipButton
                    icon="copy"
                    label={`Copy these ${group().prs.length} PRs as a list`}
                    size="small"
                    onClick={() => void ops.copy(group().name, group().prs)}
                  />
                </div>
                <Show when={open()}>
                  <div style={{ display: "flex", "flex-direction": "column", gap: "6px", "padding-left": "38px" }}>
                    <Index each={group().prs}>{(pr) => <PrLine pr={pr()} merged={groups.merged} />}</Index>
                  </div>
                </Show>
              </section>
            );
          }}
        </Index>
      );

      return (
        <div style={{ display: "flex", "flex-direction": "column", gap: "16px", padding: "12px", height: "100%", "overflow-y": "auto", "box-sizing": "border-box", "justify-content": "flex-start", "align-content": "flex-start" }}>
          {/* The top line: everything in progress with one spinner, else the latest result. Fixed height, so the list doesn't jump. */}
          <div role="status" style={{ display: "flex", "align-items": "center", gap: "8px", "font-size": "12px", "min-height": "18px", opacity: "0.85" }}>
            <Show when={running().length > 0} fallback={<span>{status() ?? ""}</span>}>
              <span class="pr-watch-spinning" style={{ display: "inline-flex" }}>
                <ctx.ui.Icon name="refresh" size="small" />
              </span>
              <span style={{ "min-width": "0", "overflow-wrap": "anywhere" }}>{running().join(" · ")}</span>
            </Show>
          </div>
          {/* About every watch, not the list: above the filters, where it's seen first. */}
          <Show when={store().paused}>{(text) => <div style={{ color: "var(--text-warning, #d29922)" }}>{text()}</div>}</Show>
          <input
            type="search"
            placeholder="Search title, repo or #number"
            aria-label="Search your PRs"
            value={choices().search}
            onInput={(event) => choose("search", event.currentTarget.value)}
            // A fixed height: the host's input styles otherwise let it fill the panel's height.
            style={{ ...SELECT_STYLE, flex: "0 0 auto", width: "100%", height: "32px", "min-height": "32px", "max-height": "32px", "box-sizing": "border-box", padding: "0 8px" }}
          />
          {/* Wraps when the panel is narrow: each control keeps at least SELECT_STYLE's min-width. */}
          <div style={{ display: "flex", "align-items": "center", gap: "8px", "flex-wrap": "wrap", "margin-top": "-8px" }}>
            <select
              aria-label="Organisation"
              value={choices().organisation}
              onChange={(event) => choose("organisation", event.currentTarget.value)}
              style={SELECT_STYLE}
            >
              <option value="">Org: All</option>
              <For each={view().organisations}>{(org) => <option value={org}>Org: {org}</option>}</For>
            </select>
            <select aria-label="Group by" value={choices().grouping}
              onChange={(event) => {
                choose("grouping", event.currentTarget.value as Grouping);
                loadTopics(props.session.id);
              }} style={SELECT_STYLE}>
              <option value="repo">Group by: Repo</option>
              <option value="topic">Group by: Topic</option>
              <option value="none">Group by: None</option>
            </select>
            <select aria-label="Sort" value={view().effectiveSort} onChange={(event) => choose("sort", event.currentTarget.value as MyPrSort)} style={SELECT_STYLE}>
              <For each={SORTS}>
                {(option) => (
                  <option value={option.value} disabled={option.value === "name" && view().sortByNameDisabled}>
                    {option.label}
                  </option>
                )}
              </For>
            </select>
            <details ref={statusMenu} style={{ ...SELECT_STYLE, position: "relative", padding: "0" }}>
              <summary style={{ cursor: "pointer", height: "100%", display: "flex", "align-items": "center", "box-sizing": "border-box", padding: "0 6px", margin: "0", "list-style": "none", "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" }}>
                {statusSummary(choices().statuses)} ▾
              </summary>
              <div
                style={{
                  position: "absolute", "z-index": "10", top: "calc(100% + 4px)", left: "0", "min-width": "100%", "box-sizing": "border-box",
                  display: "flex", "flex-direction": "column", gap: "6px", padding: "8px", "border-radius": "6px",
                  background: "var(--background-base, #1e1e1e)", border: "1px solid rgba(127,127,127,0.4)", "box-shadow": "0 4px 12px rgba(0,0,0,0.3)",
                }}
              >
                <label style={{ display: "flex", "align-items": "center", gap: "6px", cursor: "pointer", "white-space": "nowrap", "padding-bottom": "6px", "border-bottom": "1px solid rgba(127,127,127,0.25)" }}>
                  <input
                    type="checkbox"
                    checked={choices().statuses.length === ALL_STATUSES.length}
                    onChange={(event) => choose("statuses", toggleStatus(choices().statuses, "all", event.currentTarget.checked))}
                  />
                  All
                </label>
                <For each={ALL_STATUSES}>
                  {(status) => (
                    <label style={{ display: "flex", "align-items": "center", gap: "6px", cursor: "pointer", "white-space": "nowrap" }}>
                      <input
                        type="checkbox"
                        checked={choices().statuses.includes(status)}
                        onChange={(event) => choose("statuses", toggleStatus(choices().statuses, status, event.currentTarget.checked))}
                      />
                      {STATUS_LABELS[status]}
                    </label>
                  )}
                </For>
              </div>
            </details>
            {/* The host's own icon button, so it looks like the reload button next to it; a <summary> can't hold a
                button, so the button opens the menu and the summary stays hidden. Not the gear: on each line the gear
                opens the workflow run. */}
            <span ref={buttonsArea} style={{ position: "relative", display: "inline-flex" }}>
            <TipButton icon="sliders" label="Buttons on each PR line" size="small" onClick={() => buttonsMenu && (buttonsMenu.open = !buttonsMenu.open)} />
            <details ref={buttonsMenu} style={{ position: "absolute", top: "100%", right: "0" }}>
              <summary style={{ display: "none" }} />
              <div
                style={{
                  position: "absolute", "z-index": "10", top: "4px", right: "0", "box-sizing": "border-box",
                  // Never wider than the panel: it opens leftwards from the gear, so a narrow panel would cut it off.
                  width: "max-content", "max-width": "min(320px, calc(100vw - 48px))",
                  display: "flex", "flex-direction": "column", gap: "6px", padding: "8px", "border-radius": "6px",
                  background: "var(--background-base, #1e1e1e)", border: "1px solid rgba(127,127,127,0.4)", "box-shadow": "0 4px 12px rgba(0,0,0,0.3)",
                }}
              >
                <div style={{ "font-weight": "600", "padding-bottom": "6px", "border-bottom": "1px solid rgba(127,127,127,0.25)" }}>Buttons on each PR line</div>
                <For each={ROW_BUTTONS}>
                  {(button) => (
                    <label title={button.hint} style={{ display: "flex", "align-items": "center", gap: "6px", cursor: "pointer" }}>
                      <input type="checkbox" checked={shown(button.id)} onChange={(event) => setButtonShown(button.id, event.currentTarget.checked)} />
                      <ctx.ui.Icon name={BUTTON_ICONS[button.id]} size="small" />
                      {button.label}
                    </label>
                  )}
                </For>
              </div>
            </details>
            </span>
            <TipButton
              icon="refresh"
              size="small"
              label="Reload, and make every watch check GitHub now"
              onClick={() => {
                if (myPrsLoading() === 0) load();
                void ops.checkNow();
              }}
            />
          </div>
          <div style={{ display: "flex", "align-items": "center", gap: "16px", "flex-wrap": "wrap", "font-size": "12px", opacity: "0.85", "margin-top": "-8px" }}>
            <label style={{ display: "flex", "align-items": "center", gap: "6px", cursor: "pointer" }}>
              <input type="checkbox" checked={choices().drafts} onChange={(event) => choose("drafts", event.currentTarget.checked)} />
              Show drafts
            </label>
            <label style={{ display: "flex", "align-items": "center", gap: "6px", cursor: "pointer" }} title="Watched PRs opened by others, such as bots or colleagues">
              <input type="checkbox" checked={choices().others} onChange={(event) => choose("others", event.currentTarget.checked)} />
              Show PRs that aren't mine
            </label>
            <label style={{ display: "flex", "align-items": "center", gap: "6px", cursor: "pointer" }} title="Only the PRs and runs this session watches">
              <input type="checkbox" checked={choices().sessionOnly} onChange={(event) => choose("sessionOnly", event.currentTarget.checked)} />
              Current session only
            </label>
          </div>
          {/* GitHub paused or slowed (shown at the top) says more than a load error. */}
          <Show when={!store().paused && error()}>{(text) => <div style={{ color: "var(--text-danger, #c33)" }}>Could not load your PRs: {text()}</div>}</Show>
          <Show when={choices().grouping === "topic" && topicsError()}>
            {(text) => <div style={{ opacity: "0.8", "font-size": "12px" }}>Grouped by repo: {text()}</div>}
          </Show>
          <Show when={store().open !== undefined || store().rowsLoaded} fallback={<div style={{ opacity: "0.6" }}>Loading…</div>}>
            {(_) => (
              <>
                <Show when={view().runs.length > 0}>
                  <section style={{ display: "flex", "flex-direction": "column", gap: "6px" }}>
                    <div style={{ display: "flex", "align-items": "center", gap: "6px" }}>
                      <ctx.ui.Icon name="settings-gear" size="small" />
                      <span style={{ "font-weight": "600", flex: "1" }}>Workflow runs</span>
                      <span style={{ opacity: "0.6", "font-size": "12px" }}>{view().runs.length}</span>
                    </div>
                    <div style={{ display: "flex", "flex-direction": "column", gap: "6px", "padding-left": "22px" }}>
                      <Index each={view().runs}>
                        {(row) => (
                          <PrLineView
                            text={row().label}
                            detail={row().detail}
                            url={row().url}
                            row={row()}
                            onStop={() => stopWatching(row().id)}
                            onOpenSession={row().sessionID ? openSession(row()) : undefined}
                          />
                        )}
                      </Index>
                    </div>
                  </section>
                </Show>
                <Show when={view().openEmpty === undefined} fallback={<div style={{ opacity: "0.6" }}>{view().openEmpty}</div>}>
                  <Groups groups={view().open} merged={false} />
                </Show>
                <button
                  type="button"
                  onClick={() => {
                    setShowMerged(!showMerged());
                    load();
                  }}
                  style={{
                    all: "unset", cursor: "pointer", "font-weight": "600", "margin-top": "12px", "padding-top": "16px",
                    "border-top": "1px solid rgba(127,127,127,0.35)", "text-transform": "uppercase", "font-size": "11px",
                    "letter-spacing": "0.06em", opacity: "0.75",
                  }}
                >
                  {showMerged() ? "▾" : "▸"} Recently merged (7 days)
                </button>
                <Show when={showMerged()}>
                  <Show when={view().merged} fallback={<div style={{ opacity: "0.6" }}>Loading…</div>}>
                    {(merged) => (
                      <Show when={view().mergedEmpty === undefined} fallback={<div style={{ opacity: "0.6" }}>{view().mergedEmpty}</div>}>
                        <Groups groups={merged()} merged />
                      </Show>
                    )}
                  </Show>
                </Show>
              </>
            )}
          </Show>
        </div>
      );
    };

    ctx.add(Panel, {
      id: "watches",
      region: "side",
      list: () => [PRS_TAB],
      render: (props) => <MyPrsView session={props.session} />,
    });

    // The host gives plugin pill popovers a fixed 320px (w-80) and has no width option. This widens only ours, matched
    // by its heading; the selector is host markup, not API, so if it changes the popover just falls back to 320px.
    ctx.add(Style, `@keyframes pr-watch-spin { to { transform: rotate(360deg); } } .pr-watch-spinning svg { animation: pr-watch-spin 0.9s linear infinite; }`);
    ctx.add(Style, `[data-slot="session-plugin-pill-popover"][aria-label="${TITLE}"] { width: min(720px, calc(100vw - 56px)); }`);

    ctx.add(ComposerPill, {
      id: "watches",
      show: (input) => {
        const pill = pillView(sessionRows(store().rows, input.session.id));
        if (!pill) return undefined;
        return {
          icon: "github",
          label: pill.label,
          ...(LOOK[pill.worst].tone ? { tone: LOOK[pill.worst].tone } : {}),
          title: TITLE,
        };
      },
      // One line per PR: where it is, with buttons that open the PR and the run it's waiting on in the browser.
      menu: (input) => (
        <div style={{ display: "flex", "flex-direction": "column", gap: "6px", padding: "4px 0", width: "100%", "box-sizing": "border-box", "max-height": "min(480px, 60vh)", "overflow-y": "auto", "padding-right": "4px" }}>
          <Index each={sessionRows(store().rows, input.session.id)}>{(row) => <WatchLine row={row()} session={input.session} />}</Index>
        </div>
      ),
    });
  },
});
