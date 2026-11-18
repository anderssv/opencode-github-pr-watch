import type { DebugLog } from "../core/debug-log";
import type { CatalogModel, JudgeModelInput, ModelRef, SessionView } from "../core/model-guard";
import type { Diagnosis } from "../core/advice";
import type { PhaseLimit } from "../core/timing";
import type { Snapshot, Watch, WatchPorts, WatchSettings } from "../core/watcher";
import type { JobView, PrFacts, PrView, RunWithJobs } from "../core/pr-facts";

export const aModel = (providerID: string, id: string, overrides: Partial<CatalogModel> = {}): CatalogModel => ({
  providerID,
  id,
  enabled: true,
  ...overrides,
});

export const aSession = (providerID = "github-copilot", id = "claude-opus", directory = "/repo") => ({
  directory,
  model: { providerID, id },
});

export const judgeInput = (overrides: Partial<JudgeModelInput> = {}): JudgeModelInput => ({
  pinned: { providerID: "github-copilot", directory: "/repo" },
  session: aSession(),
  pluginDirectory: "/repo",
  catalog: [aModel("github-copilot", "claude-opus"), aModel("github-copilot", "claude-haiku")],
  preferences: ["haiku"],
  ...overrides,
});

export const aWatch = (overrides: Partial<Watch> = {}): Watch => ({
  id: "acme/api#42",
  sessionID: "ses_parent",
  repo: "acme/api",
  pr: 42,
  pinned: { providerID: "github-copilot", directory: "/repo" },
  startedAt: 0,
  lastChangeAt: 0,
  ...overrides,
});

export const settings = (overrides: Partial<WatchSettings> = {}): WatchSettings => ({
  pluginDirectory: "/repo",
  preferences: ["haiku"],
  stuckMs: 30 * 60_000,
  ...overrides,
});

export class FakePorts implements WatchPorts {
  readonly judged: { model: ModelRef; directory: string; prompt: string }[] = [];
  readonly notifications: { sessionID: string; text: string; wake: boolean; alert?: boolean }[] = [];
  private snapshots: Snapshot[];
  private verdicts: string[];
  sessionView: SessionView = aSession();
  models: CatalogModel[] = [aModel("github-copilot", "claude-opus"), aModel("github-copilot", "claude-haiku")];
  time = 0;
  judgeError?: Error;
  debug?: DebugLog;
  sessionError?: Error;
  notifyError?: Error;

  constructor(init: { snapshots?: Snapshot[]; verdicts?: string[] } = {}) {
    this.snapshots = init.snapshots ?? [];
    this.verdicts = init.verdicts ?? [];
  }

  async snapshot(): Promise<Snapshot> {
    const next = this.snapshots.shift() ?? { text: "" };
    if (next.facts) this.lastFacts = next.facts;
    return next;
  }
  async session(): Promise<SessionView> {
    if (this.sessionError) throw this.sessionError;
    return this.sessionView;
  }
  async catalog(): Promise<CatalogModel[]> {
    return this.models;
  }
  async judge(model: ModelRef, directory: string, prompt: string): Promise<string> {
    if (this.judgeError) throw this.judgeError;
    this.judged.push({ model, directory, prompt });
    return this.verdicts.shift() ?? "";
  }
  readonly alerts: boolean[] = [];
  async notify(sessionID: string, text: string, wake = false, alert = wake): Promise<void> {
    if (this.notifyError) throw this.notifyError;
    this.notifications.push({ sessionID, text, wake });
    this.alerts.push(alert);
  }
  diagnosis?: Diagnosis;
  limit?: PhaseLimit;
  autoMergeActor?: string;
  replacement?: number;
  botAdvice?: string;
  async adviseBot(): Promise<string | undefined> {
    return this.botAdvice;
  }
  async replacementFor(): Promise<number | undefined> {
    return this.replacement;
  }
  async lastAutoMergeActor(): Promise<string | undefined> {
    return this.autoMergeActor;
  }
  stall?: string;
  async phaseLimit(): Promise<PhaseLimit | undefined> {
    return this.limit;
  }
  async evaluateStall(): Promise<string | undefined> {
    return this.stall;
  }
  failuresBefore = 0;
  readonly countedFailures: string[] = [];
  async diagnose(_model: ModelRef, _watch: Watch, _facts: PrFacts): Promise<Diagnosis | undefined> {
    return this.diagnosis;
  }
  async countFailure(_id: string, signature: string): Promise<number> {
    this.countedFailures.push(signature);
    return this.failuresBefore;
  }
  /** What a fresh read right before sending shows; undefined = same as the last snapshot. */
  live?: { owned: boolean; facts?: PrFacts };
  async current(): Promise<{ owned: boolean; facts?: PrFacts }> {
    return this.live ?? { owned: true, ...(this.lastFacts ? { facts: this.lastFacts } : {}) };
  }
  private lastFacts?: PrFacts;
  now(): number {
    return this.time;
  }
}

export const aPrView = (overrides: Partial<PrView> = {}): PrView => ({
  state: "OPEN",
  isDraft: false,
  baseRefName: "main",
  title: "fix: something",
  url: "https://github.com/acme/api/pull/42",
  reviewDecision: "APPROVED",
  mergeStateStatus: "CLEAN",
  autoMergeRequest: null,
  mergedAt: null,
  mergeCommit: null,
  statusCheckRollup: [{ name: "Build and test", status: "COMPLETED", conclusion: "SUCCESS" }],
  ...overrides,
});

export const aJob = (overrides: Partial<JobView> = {}): JobView => ({
  name: "Build and test",
  status: "completed",
  conclusion: "success",
  startedAt: "2026-10-12T10:01:00Z",
  ...overrides,
});

export const aRun = (overrides: Partial<RunWithJobs> = {}): RunWithJobs => ({
  databaseId: 1,
  workflowName: "MAIN - Deployment pipeline",
  event: "push",
  createdAt: "2026-10-12T10:00:05Z",
  status: "completed",
  conclusion: "success",
  url: "https://github.com/acme/api/actions/runs/1",
  jobs: [aJob()],
  ...overrides,
});

export const aFacts = (overrides: Partial<PrFacts> = {}): PrFacts => ({
  state: "OPEN",
  draft: false,
  baseRefName: "main",
  review: "APPROVED",
  branch: "OK",
  checks: "PASS",
  failingChecks: [],
  missingChecks: [],
  deploy: "NOT_MERGED",
  waitingJobs: [],
  waitingChecks: [],
  unfinishedJobs: [],
  unaffectedPipelines: [],
  autoMerge: false,
  deployingOnBase: [],
  ...overrides,
});

export const aSnapshot = (text: string, facts?: Partial<PrFacts>): Snapshot => (facts ? { text, facts: aFacts(facts) } : { text });
