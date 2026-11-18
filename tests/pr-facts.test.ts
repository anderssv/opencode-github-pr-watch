import { describe, expect, test } from "bun:test";
import { factsFrom, nextStep, pipelineChecks, setBookkeepingJobs, summaryLine } from "../core/pr-facts";
import { aJob, aPrView, aRun, aFacts } from "./mothers";

const MERGED_AT = "2026-10-12T10:00:00Z";
const NOW = Date.parse("2026-10-12T10:30:00Z");

describe("factsFrom: before merge", () => {
  test("reads review, branch and passing checks", () => {
    const facts = factsFrom(aPrView({ reviewDecision: "APPROVED", mergeStateStatus: "CLEAN" }), [], NOW);

    expect(facts).toMatchObject({ state: "OPEN", review: "APPROVED", branch: "OK", checks: "PASS" });
  });

  test("knows whether auto-merge is enabled", () => {
    expect(factsFrom(aPrView({ autoMergeRequest: { mergeMethod: "SQUASH" } }), [], NOW).autoMerge).toBe(true);
    expect(factsFrom(aPrView({ autoMergeRequest: null }), [], NOW).autoMerge).toBe(false);
  });

  test("an empty review decision means no review is required", () => {
    expect(factsFrom(aPrView({ reviewDecision: "" }), [], NOW).review).toBe("NOT_REQUIRED");
  });

  test.each([
    ["BEHIND", "BEHIND"],
    ["DIRTY", "CONFLICT"],
    ["UNKNOWN", "UNKNOWN"],
    ["BLOCKED", "OK"],
  ] as const)("merge state %s means branch %s", (mergeStateStatus, branch) => {
    expect(factsFrom(aPrView({ mergeStateStatus }), [], NOW).branch).toBe(branch);
  });

  test("failing checks are named", () => {
    const view = aPrView({
      statusCheckRollup: [
        { name: "Build", status: "COMPLETED", conclusion: "SUCCESS" },
        { name: "Trivy", status: "COMPLETED", conclusion: "FAILURE" },
        { context: "legacy", state: "ERROR" },
      ],
    });

    expect(factsFrom(view, [], NOW)).toMatchObject({ checks: "FAIL", failingChecks: ["Trivy", "legacy"] });
  });

  test("running checks are pending, skipped ones count as passing", () => {
    const view = aPrView({
      statusCheckRollup: [
        { name: "Build", status: "IN_PROGRESS" },
        { name: "Deploy", status: "COMPLETED", conclusion: "SKIPPED" },
      ],
    });

    expect(factsFrom(view, [], NOW).checks).toBe("PENDING");
  });

  test("no checks at all", () => {
    expect(factsFrom(aPrView({ statusCheckRollup: [] }), [], NOW).checks).toBe("NONE");
  });

  describe("only the build pipeline counts, not GitHub code scanning", () => {
    const pipelineJob = { name: "Build and test", workflowName: "MAIN - Deployment pipeline", status: "COMPLETED", conclusion: "SUCCESS" };

    test("a code scanning result is ignored, whatever it says", () => {
      const view = aPrView({
        statusCheckRollup: [
          pipelineJob,
          { name: "Trivy", workflowName: "", status: "COMPLETED", conclusion: "FAILURE" },
          { name: "Hadolint", workflowName: "", status: "IN_PROGRESS" },
        ],
      });

      expect(factsFrom(view, [], NOW)).toMatchObject({ checks: "PASS", failingChecks: [] });
    });

    test("the CodeQL analysis workflow is ignored", () => {
      const view = aPrView({
        statusCheckRollup: [pipelineJob, { name: "Analyze java-kotlin", workflowName: "CodeQL", status: "COMPLETED", conclusion: "FAILURE" }],
      });

      expect(factsFrom(view, [], NOW).checks).toBe("PASS");
    });

    test("the pipeline's own vulnerability scan still counts", () => {
      const view = aPrView({
        statusCheckRollup: [
          pipelineJob,
          { name: "SCAN - Vulnerability scan container", workflowName: "MAIN - Deployment pipeline", status: "COMPLETED", conclusion: "FAILURE" },
        ],
      });

      expect(factsFrom(view, [], NOW)).toMatchObject({ checks: "FAIL", failingChecks: ["SCAN - Vulnerability scan container"] });
    });

    test("pipelineChecks keeps status contexts and pipeline jobs only", () => {
      const legacy = { context: "ci/legacy", state: "SUCCESS" };
      const checks = [pipelineJob, legacy, { name: "Trivy", workflowName: "", status: "COMPLETED", conclusion: "NEUTRAL" }];

      expect(pipelineChecks(checks)).toEqual([pipelineJob, legacy]);
    });
  });

  describe("required checks on the base branch", () => {
    const passed = (name: string) => ({ name, workflowName: "Platform - Deploy pipeline", status: "COMPLETED", conclusion: "SUCCESS" });
    const required = ["Build status - core", "Build status - api-specs"];

    test("a required check that never reported keeps the PR from being ready", () => {
      const facts = factsFrom(aPrView({ statusCheckRollup: [passed("Build status - core")] }), [], NOW, required);

      expect(facts).toMatchObject({ checks: "MISSING", missingChecks: ["Build status - api-specs"] });
      expect(nextStep(facts, NOW)).toBe("WAIT_CHECKS");
    });

    test("every required check reported and passed", () => {
      const view = aPrView({ statusCheckRollup: [passed("Build status - core"), passed("Build status - api-specs")] });

      expect(factsFrom(view, [], NOW, required)).toMatchObject({ checks: "PASS", missingChecks: [] });
    });

    test("while other checks still run, a missing required check may just not have started yet", () => {
      const view = aPrView({ statusCheckRollup: [{ name: "Build status - core", workflowName: "Core", status: "IN_PROGRESS" }] });

      expect(factsFrom(view, [], NOW, required).checks).toBe("PENDING");
    });

    test("a failing check wins over a missing one", () => {
      const view = aPrView({ statusCheckRollup: [{ ...passed("Build status - core"), conclusion: "FAILURE" }] });

      expect(factsFrom(view, [], NOW, required).checks).toBe("FAIL");
    });

    test("a required status context counts by its context name", () => {
      const view = aPrView({ statusCheckRollup: [passed("Build status - core"), { context: "Build status - api-specs", state: "SUCCESS" }] });

      expect(factsFrom(view, [], NOW, required).checks).toBe("PASS");
    });

    test("without known required checks nothing is missing", () => {
      expect(factsFrom(aPrView(), [], NOW).missingChecks).toEqual([]);
    });
  });
});

describe("factsFrom: re-runs", () => {
  test("the latest attempt of a check decides, so a running re-run of a failed job is pending", () => {
    const view = aPrView({
      statusCheckRollup: [
        { name: "Build", workflowName: "Core", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-13T08:00:00Z" },
        { name: "Build", workflowName: "Core", status: "IN_PROGRESS", startedAt: "2026-10-13T08:20:00Z" },
      ],
    });

    expect(factsFrom(view, [], NOW)).toMatchObject({ checks: "PENDING", failingChecks: [] });
  });

  test("a failed check counts as pending while its workflow is running again", () => {
    const view = aPrView({
      statusCheckRollup: [{ name: "Scan", workflowName: "Platform - Deploy pipeline", status: "COMPLETED", conclusion: "FAILURE" }],
    });

    expect(factsFrom(view, [], NOW, [], ["Platform - Deploy pipeline"])).toMatchObject({ checks: "PENDING", failingChecks: [] });
    expect(factsFrom(view, [], NOW, [], ["Other"])).toMatchObject({ checks: "FAIL" });
  });

  test("a re-run that failed again still fails", () => {
    const view = aPrView({
      statusCheckRollup: [
        { name: "Build", workflowName: "Core", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-10-13T08:00:00Z" },
        { name: "Build", workflowName: "Core", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-10-13T08:20:00Z" },
      ],
    });

    expect(factsFrom(view, [], NOW)).toMatchObject({ checks: "FAIL", failingChecks: ["Build"] });
  });
});

describe("factsFrom: deploys still running on the base branch", () => {
  const dipChecks = [
    { name: "Detect changes", workflowName: "Web", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "Build status - web", workflowName: "Web", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "Build and test", workflowName: "Web", status: "COMPLETED", conclusion: "SKIPPED" },
    { name: "Build and test", workflowName: "Audit Log Archive", status: "COMPLETED", conclusion: "SUCCESS" },
  ];
  const deploying = (workflowName: string, deploy = "in_progress") =>
    aRun({ workflowName, status: "in_progress", conclusion: "", jobs: [aJob({ name: "DEPLOY - Prod", status: deploy, conclusion: deploy === "completed" ? "skipped" : "" })] });

  test("names a running deploy of a pipeline this PR builds", () => {
    const facts = factsFrom(aPrView({ statusCheckRollup: dipChecks }), [], NOW, [], [], [deploying("Audit Log Archive")]);

    expect(facts.deployingOnBase).toEqual(["Audit Log Archive"]);
    expect(nextStep(facts, NOW)).toBe("WAIT_DEPLOY");
  });

  test("ignores pipelines this PR doesn't build, and runs that skipped their deploy", () => {
    const facts = factsFrom(aPrView({ statusCheckRollup: dipChecks }), [], NOW, [], [], [deploying("Web"), deploying("Audit Log Archive", "completed")]);

    expect(facts.deployingOnBase).toEqual([]);
    expect(nextStep(facts, NOW)).toBe("READY");
  });

  test("shows in the summary", () => {
    expect(summaryLine(aFacts({ deployingOnBase: ["Audit Log Archive"] }), NOW)).toContain("next: WAIT_DEPLOY");
  });
});

describe("factsFrom: after merge", () => {
  const merged = aPrView({ state: "MERGED", mergedAt: MERGED_AT, mergeCommit: { oid: "abc" } });

  test("no merge-triggered run yet", () => {
    expect(factsFrom(merged, [aRun({ event: "schedule" })], NOW).deploy).toBe("NO_RUNS");
  });

  test("a running push run means the deploy is running", () => {
    expect(factsFrom(merged, [aRun({ status: "in_progress", conclusion: "" })], NOW).deploy).toBe("RUNNING");
  });

  test("a job waiting on an environment gate", () => {
    const run = aRun({ status: "waiting", conclusion: "", jobs: [aJob({ name: "DEPLOY - Prod", status: "waiting", conclusion: "" })] });

    expect(factsFrom(merged, [run], NOW)).toMatchObject({ deploy: "WAITING", waitingJobs: ["DEPLOY - Prod"] });
  });

  test("a failed push run means the deploy failed, scheduled failures don't count", () => {
    expect(factsFrom(merged, [aRun({ conclusion: "failure" })], NOW).deploy).toBe("FAILED");
    expect(factsFrom(merged, [aRun(), aRun({ event: "schedule", conclusion: "failure" })], NOW).deploy).toBe("SUCCEEDED");
  });

  test("push runs started before the merge are not this PR's deploy", () => {
    expect(factsFrom(merged, [aRun({ createdAt: "2026-10-11T09:00:00Z" })], NOW).deploy).toBe("NO_RUNS");
  });

  describe("monorepos with one pipeline per component", () => {
    const skippedDeploys = (name: string) =>
      aRun({
        workflowName: name,
        jobs: [aJob({ name: "Detect changes" }), aJob({ name: "DEPLOY - Prod", conclusion: "skipped" }), aJob({ name: "DEPLOY - Dev", conclusion: "skipped" })],
      });

    test("ignores pipelines whose deploy jobs were all skipped", () => {
      const ownDeploy = aRun({
        workflowName: "Platform - Deploy pipeline",
        status: "in_progress",
        conclusion: "",
        jobs: [aJob({ name: "DEPLOY - Prod", status: "in_progress", conclusion: "" })],
      });

      const facts = factsFrom(merged, [ownDeploy, skippedDeploys("Web - Deploy pipeline")], NOW);

      expect(facts).toMatchObject({ deploy: "RUNNING", unaffectedPipelines: ["Web - Deploy pipeline"] });
    });

    test("a failure in a pipeline that deployed nothing is not this PR's deploy failing", () => {
      const other = { ...skippedDeploys("Web - Deploy pipeline"), conclusion: "failure" };

      const deployed = aRun({ jobs: [aJob(), aJob({ name: "DEPLOY - Prod" })] });

      expect(factsFrom(merged, [deployed, other], NOW).deploy).toBe("SUCCEEDED");
    });

    test("a pipeline that hasn't decided yet still counts", () => {
      const deciding = aRun({
        status: "in_progress",
        conclusion: "",
        jobs: [aJob({ name: "Detect changes", status: "in_progress", conclusion: "" }), aJob({ name: "DEPLOY - Prod", status: "pending", conclusion: "" })],
      });

      expect(factsFrom(merged, [deciding], NOW)).toMatchObject({ deploy: "RUNNING", unaffectedPipelines: [] });
    });

    test("pipelines without deploy jobs still count", () => {
      const codeql = aRun({ workflowName: "CodeQL", conclusion: "failure", jobs: [aJob({ name: "Analyze", conclusion: "failure" })] });

      expect(factsFrom(merged, [aRun(), codeql], NOW).deploy).toBe("FAILED");
    });

    test("a pipeline whose deploys were skipped because a job failed is a failed deploy", () => {
      const scanFailed = aRun({
        conclusion: "failure",
        jobs: [aJob({ name: "Scan container", conclusion: "failure" }), aJob({ name: "DEPLOY - Dev", conclusion: "skipped" }), aJob({ name: "DEPLOY - Prod", conclusion: "skipped" })],
      });
      const codeql = aRun({ workflowName: "CodeQL", jobs: [aJob({ name: "Analyze java-kotlin" })] });

      expect(factsFrom(merged, [scanFailed, codeql], NOW)).toMatchObject({ deploy: "FAILED", unaffectedPipelines: [] });
    });
  });

  describe("a pipeline whose deploy jobs haven't appeared yet (terms#734)", () => {
    // GitHub lists a job only once it is about to run, so mid-build the deploy jobs don't exist on the run yet.
    const pages = aRun({
      workflowName: "Deploy OpenAPI Docs to GitHub Pages",
      jobs: [aJob({ name: "build" }), aJob({ name: "deploy" })],
    });
    const building = aRun({
      workflowName: "MAIN - Deployment pipeline",
      status: "in_progress",
      conclusion: "",
      jobs: [aJob({ name: "Build and test", status: "in_progress", conclusion: "" })],
    });

    test("a finished docs deploy doesn't count as deployed while a pipeline that usually deploys is still building", () => {
      expect(factsFrom(merged, [pages, { ...building, usuallyDeploys: true }], NOW).deploy).toBe("RUNNING");
    });

    test("a running workflow that never deploys still doesn't hold it back", () => {
      expect(factsFrom(merged, [pages, building], NOW).deploy).toBe("SUCCEEDED");
    });
  });

  describe("workflow roles judged by the model", () => {
    const pages = aRun({ workflowName: "Deploy OpenAPI Docs to GitHub Pages", role: "other", jobs: [aJob({ name: "deploy" })] });
    const main = aRun({ role: "deploy", jobs: [aJob(), aJob({ name: "DEPLOY - Prod" })] });

    test("a finished docs workflow doesn't make the PR deployed while the deploy pipeline builds", () => {
      const building = { ...main, status: "in_progress", conclusion: "", jobs: [aJob({ name: "Build and test", status: "in_progress", conclusion: "" })] };
      expect(factsFrom(merged, [pages, building], NOW).deploy).toBe("RUNNING");
    });

    test("a running or failing workflow that isn't part of the deploy doesn't affect it", () => {
      const pagesRunning = { ...pages, status: "in_progress", conclusion: "", jobs: [aJob({ name: "deploy", status: "in_progress", conclusion: "" })] };
      const codeqlFailed = aRun({ workflowName: "CodeQL", role: "other", conclusion: "failure", jobs: [aJob({ name: "Analyze", conclusion: "failure" })] });

      expect(factsFrom(merged, [main, pagesRunning, codeqlFailed], NOW)).toMatchObject({ deploy: "SUCCEEDED", unfinishedJobs: [] });
    });

    test("a deploy workflow counts even before its deploy jobs are listed", () => {
      const building = { ...main, status: "in_progress", conclusion: "", jobs: [aJob({ name: "Build and test", status: "in_progress", conclusion: "" })] };
      expect(factsFrom(merged, [building], NOW).deploy).toBe("RUNNING");
    });
  });

  describe("when no workflow was judged to deploy", () => {
    const pages = aRun({ workflowName: "Deploy OpenAPI Docs to GitHub Pages", role: "other", jobs: [aJob({ name: "deploy" })] });
    const codeql = aRun({ workflowName: "CodeQL", role: "other", jobs: [aJob({ name: "Analyze" })] });

    test("it says it can't tell, naming the workflows, instead of guessing", () => {
      expect(factsFrom(merged, [pages, codeql], NOW)).toMatchObject({
        deploy: "UNIDENTIFIED",
        undeterminedWorkflows: ["Deploy OpenAPI Docs to GitHub Pages", "CodeQL"],
      });
    });

    test("not while some workflows haven't been judged yet", () => {
      expect(factsFrom(merged, [pages, aRun({ workflowName: "MAIN - Deployment pipeline" })], NOW).deploy).not.toBe("UNIDENTIFIED");
    });
  });

  describe("workflows without deploy jobs next to a deploy pipeline", () => {
    const deployed = aRun({ jobs: [aJob(), aJob({ name: "DEPLOY - Prod" })] });
    const codeqlRunning = aRun({
      workflowName: "CodeQL",
      status: "in_progress",
      conclusion: "",
      jobs: [aJob({ name: "Analyze java-kotlin", status: "in_progress", conclusion: "", startedAt: "2026-10-12T10:01:00Z" })],
    });

    test("a still-running analysis doesn't hold back a finished deploy", () => {
      expect(factsFrom(merged, [deployed, codeqlRunning], NOW).deploy).toBe("SUCCEEDED");
    });

    test("its jobs are not deploy jobs that can look stuck", () => {
      expect(factsFrom(merged, [deployed, codeqlRunning], NOW).unfinishedJobs).toEqual([]);
    });
  });

  test("records when each unfinished job started", () => {
    const run = aRun({
      status: "in_progress",
      conclusion: "",
      jobs: [aJob({ name: "DEPLOY - Prod", status: "in_progress", conclusion: "", startedAt: "2026-10-12T10:05:00Z" })],
    });

    expect(factsFrom(merged, [run], NOW).unfinishedJobs).toEqual([{ name: "DEPLOY - Prod", since: Date.parse("2026-10-12T10:05:00Z") }]);
  });
});

describe("factsFrom: checks waiting for an environment approval", () => {
  const view = (...statusCheckRollup: object[]) => aPrView({ statusCheckRollup: statusCheckRollup as never });

  test("a check run waiting at an environment gate is named, and the checks stay pending", () => {
    const facts = factsFrom(
      view(
        { name: "CORE terraform / Plan", workflowName: "TERRAFORM - Apply", status: "WAITING" },
        { name: "Lint", workflowName: "CODE - Linting", status: "COMPLETED", conclusion: "SUCCESS" },
      ),
      [],
      NOW,
    );

    expect(facts).toMatchObject({ checks: "PENDING", waitingChecks: ["CORE terraform / Plan"] });
  });

  test("only the latest attempt counts: a rerun that moved on isn't waiting", () => {
    const facts = factsFrom(
      view(
        { name: "Plan", workflowName: "TF", status: "WAITING", startedAt: "2026-11-05T12:00:00Z" },
        { name: "Plan", workflowName: "TF", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-11-12T09:00:00Z" },
      ),
      [],
      NOW,
    );

    expect(facts.waitingChecks).toEqual([]);
  });

  test("running or queued checks are not waiting for approval", () => {
    const facts = factsFrom(view({ name: "Plan", workflowName: "TF", status: "IN_PROGRESS" }, { name: "Apply", workflowName: "TF", status: "QUEUED" }), [], NOW);

    expect(facts.waitingChecks).toEqual([]);
  });

  test("the summary names what waits", () => {
    const facts = aFacts({ checks: "PENDING", waitingChecks: ["CORE terraform / Plan"], review: "REVIEW_REQUIRED" });

    expect(summaryLine(facts, NOW)).toBe("summary: REVIEW_REQUIRED · checks PENDING (run approval needed: CORE terraform / Plan) · branch OK · next: CHECKS_WAITING");
  });
});

describe("nextStep", () => {
  test.each([
    [{ draft: true }, "DRAFT"],
    [{ branch: "CONFLICT" }, "RESOLVE_CONFLICT"],
    [{ checks: "FAIL" }, "FIX_CHECKS"],
    [{ review: "CHANGES_REQUESTED" }, "ADDRESS_REVIEW"],
    [{ branch: "BEHIND" }, "UPDATE_BRANCH"],
    [{ checks: "PENDING" }, "WAIT_CHECKS"],
    [{ checks: "PENDING", waitingChecks: ["Plan - prod"] }, "CHECKS_WAITING"],
    [{ review: "REVIEW_REQUIRED" }, "NEEDS_REVIEW"],
    [{}, "READY"],
  ] as const)("open PR %o: %s", (overrides, step) => {
    expect(nextStep(aFacts(overrides), NOW)).toBe(step);
  });

  test.each([
    ["RUNNING", "DEPLOYING"],
    ["WAITING", "DEPLOY_WAITING"],
    ["FAILED", "DEPLOY_FAILED"],
    ["SUCCEEDED", "DEPLOYED"],
  ] as const)("merged PR with deploy %s: %s", (deploy, step) => {
    expect(nextStep(aFacts({ state: "MERGED", mergedAt: NOW - 60_000, deploy }), NOW)).toBe(step);
  });

  test("merged without any deploy run: waits a little, then there is nothing to follow", () => {
    expect(nextStep(aFacts({ state: "MERGED", mergedAt: NOW - 5 * 60_000, deploy: "NO_RUNS" }), NOW)).toBe("WAIT_DEPLOY_START");
    expect(nextStep(aFacts({ state: "MERGED", mergedAt: NOW - 20 * 60_000, deploy: "NO_RUNS" }), NOW)).toBe("NO_DEPLOY");
  });

  test("merged where nothing that starts on a merge deploys: no waiting, nothing to follow", () => {
    const justMerged = { state: "MERGED" as const, mergedAt: NOW - 60_000, deployPossible: false };
    expect(nextStep(aFacts({ ...justMerged, deploy: "NO_RUNS" }), NOW)).toBe("NO_DEPLOY");
    expect(nextStep(aFacts({ ...justMerged, deploy: "UNIDENTIFIED" }), NOW)).toBe("NO_DEPLOY");
    expect(nextStep(aFacts({ ...justMerged, deploy: "NO_RUNS", deployPossible: true }), NOW)).toBe("WAIT_DEPLOY_START");
    expect(nextStep(aFacts({ ...justMerged, deploy: "RUNNING" }), NOW)).toBe("DEPLOYING");
  });

  test("closed", () => {
    expect(nextStep(aFacts({ state: "CLOSED" }), NOW)).toBe("CLOSED");
  });
});

describe("summaryLine", () => {
  test("matches the team's PR status vocabulary", () => {
    const facts = aFacts({ review: "REVIEW_REQUIRED", checks: "PASS", branch: "OK" });

    expect(summaryLine(facts, NOW)).toBe("summary: REVIEW_REQUIRED · checks PASS · branch OK · next: NEEDS_REVIEW");
  });

  test("names failing checks", () => {
    const facts = aFacts({ checks: "FAIL", failingChecks: ["Trivy"] });

    expect(summaryLine(facts, NOW)).toBe("summary: APPROVED · checks FAIL:Trivy · branch OK · next: FIX_CHECKS");
  });

  test("names required checks that never reported", () => {
    const facts = aFacts({ checks: "MISSING", missingChecks: ["Build status - api-specs"] });

    expect(summaryLine(facts, NOW)).toBe("summary: APPROVED · checks MISSING:Build status - api-specs · branch OK · next: WAIT_CHECKS");
  });

  test("shows the deploy once merged", () => {
    const facts = aFacts({ state: "MERGED", mergedAt: NOW - 60_000, deploy: "WAITING", waitingJobs: ["DEPLOY - Prod"] });

    expect(summaryLine(facts, NOW)).toBe("summary: MERGED · deploy WAITING:DEPLOY - Prod · next: DEPLOY_WAITING");
  });

  test("a closed PR has no deploy to show", () => {
    expect(summaryLine(aFacts({ state: "CLOSED" }), NOW)).toBe("summary: CLOSED · next: CLOSED");
  });
});

describe("factsFrom: the author", () => {
  test("whether the author is a bot comes from GitHub, not the name", () => {
    expect(factsFrom(aPrView({ author: { login: "app/renovate", is_bot: true } }), [], NOW).authorIsBot).toBe(true);
    expect(factsFrom(aPrView({ author: { login: "dependabot-fan", is_bot: false } }), [], NOW).authorIsBot).toBeUndefined();
  });
});

describe("factsFrom: the run to open", () => {
  const check = (status: string, conclusion: string, run: number) => ({
    name: `job ${run}`, workflowName: "MAIN", status, conclusion,
    detailsUrl: `https://github.com/o/r/actions/runs/${run}/job/${run * 10}`,
  });

  test("before merge: the PR's run still going, else a failed one, else the latest, as a run link", () => {
    expect(factsFrom(aPrView({ statusCheckRollup: [check("COMPLETED", "SUCCESS", 1), check("IN_PROGRESS", "", 2)] }), [], NOW).runUrl)
      .toBe("https://github.com/o/r/actions/runs/2");
    expect(factsFrom(aPrView({ statusCheckRollup: [check("COMPLETED", "FAILURE", 3), check("COMPLETED", "SUCCESS", 4)] }), [], NOW).runUrl)
      .toBe("https://github.com/o/r/actions/runs/3");
  });

  test("after merge: the deploy pipeline's run", () => {
    const merged = aPrView({ state: "MERGED", mergedAt: "2026-10-12T10:00:00Z", mergeCommit: { oid: "abc" } });
    const run = aRun({ status: "in_progress", conclusion: "", url: "https://github.com/o/r/actions/runs/9", jobs: [aJob({ name: "DEPLOY - Prod", status: "in_progress", conclusion: "" })] });
    expect(factsFrom(merged, [run], NOW).runUrl).toBe("https://github.com/o/r/actions/runs/9");
  });

  test("none without runs", () => {
    expect(factsFrom(aPrView({ statusCheckRollup: [] }), [], NOW).runUrl).toBeUndefined();
  });
});

describe("factsFrom: progress", () => {
  const check = (name: string, status: string, conclusion: string) => ({ name, workflowName: "MAIN", status, conclusion });

  test("checks done out of all that run; skipped ones don't count", () => {
    const view = aPrView({ statusCheckRollup: [check("a", "COMPLETED", "SUCCESS"), check("b", "COMPLETED", "SUCCESS"), check("c", "IN_PROGRESS", ""), check("d", "COMPLETED", "SKIPPED")] });
    expect(factsFrom(view, [], NOW).checksProgress).toEqual({ done: 2, total: 3, current: "c" });
  });

  test("deploy jobs done out of all in the deploy pipeline", () => {
    const merged = aPrView({ state: "MERGED", mergedAt: "2026-10-12T10:00:00Z", mergeCommit: { oid: "abc" } });
    const run = aRun({ status: "in_progress", conclusion: "", jobs: [aJob(), aJob({ name: "DEPLOY - Dev", status: "in_progress", conclusion: "" }), aJob({ name: "DEPLOY - Prod", status: "queued", conclusion: "" }), aJob({ name: "x", conclusion: "skipped" })] });
    expect(factsFrom(merged, [run], NOW).deployProgress).toEqual({ done: 1, total: 3, current: "DEPLOY - Dev" });
  });
});

describe("factsFrom and nextStep: merges with nothing to deploy (plan 18-20)", () => {
  const merged = aPrView({ state: "MERGED", mergedAt: MERGED_AT, mergeCommit: { oid: "abc" } });
  const justMerged = Date.parse(MERGED_AT) + 60_000;
  const skippedDeploys = (workflowName: string) =>
    aRun({ workflowName, jobs: [aJob({ name: "Detect changes" }), aJob({ name: "DEPLOY - Dev", conclusion: "skipped" }), aJob({ name: "DEPLOY - Prod", conclusion: "skipped" })] });

  test("every pipeline finished and none deployed: nothing to deploy, right away (platform#2585)", () => {
    const facts = factsFrom(merged, [skippedDeploys("Platform - Deploy pipeline"), skippedDeploys("Web - Deploy pipeline")], justMerged);
    expect(facts.deploy).toBe("NOTHING");
    expect(nextStep(facts, justMerged)).toBe("NOTHING_TO_DEPLOY");
  });

  test("workflows without deploy jobs don't turn it into 'deployed' (platform#2585's real runs)", () => {
    const sync = aRun({ workflowName: "Sync docs to stoe-docs", jobs: [aJob({ name: "sync" })] });
    const codeql = aRun({ workflowName: "CodeQL", jobs: [aJob({ name: "Analyze java-kotlin" })] });
    const facts = factsFrom(merged, [skippedDeploys("Platform - Deploy pipeline"), sync, codeql], justMerged);
    expect(facts.deploy).toBe("NOTHING");
  });

  test("not while a pipeline is still deciding", () => {
    const deciding = aRun({ status: "in_progress", conclusion: "", jobs: [aJob({ name: "Detect changes", status: "in_progress", conclusion: "" })] });
    expect(factsFrom(merged, [skippedDeploys("Web - Deploy pipeline"), deciding], justMerged).deploy).not.toBe("NOTHING");
  });

  test("a repo marked as not deploying ends at merge with nothing to deploy", () => {
    const facts = factsFrom(merged, [], justMerged, [], [], [], { noDeploy: true });
    expect(nextStep(facts, justMerged)).toBe("NOTHING_TO_DEPLOY");
  });

  test("only other workflows so far, just after the merge: wait for the deploy runs to appear", () => {
    const codeql = aRun({ workflowName: "CodeQL", role: "other", jobs: [aJob({ name: "Analyze" })] });
    const facts = factsFrom(merged, [codeql], justMerged);
    expect(nextStep(facts, justMerged)).toBe("WAIT_DEPLOY_START");
    expect(nextStep(facts, justMerged + 20 * 60_000)).toBe("DEPLOY_UNIDENTIFIED");
  });
});

describe("factsFrom: which failure this is (plan 4)", () => {
  test("a failing check: its job link, new on every attempt", () => {
    const view = aPrView({ statusCheckRollup: [{ name: "Build", workflowName: "MAIN", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/o/r/actions/runs/5/job/51" }] });
    expect(factsFrom(view, [], NOW).failureKey).toBe("https://github.com/o/r/actions/runs/5/job/51");
  });

  test("a failed deploy: the run link and its attempt", () => {
    const merged = aPrView({ state: "MERGED", mergedAt: "2026-10-12T10:00:00Z", mergeCommit: { oid: "abc" } });
    const run = aRun({ conclusion: "failure", attempt: 2, url: "https://github.com/o/r/actions/runs/9", jobs: [aJob({ name: "DEPLOY - Prod", conclusion: "failure" })] });
    expect(factsFrom(merged, [run], NOW).failureKey).toBe("https://github.com/o/r/actions/runs/9#2");
  });
});


describe("a failed deploy already covered by a later run (plan 1, platform#2362)", () => {
  const merged = aPrView({ state: "MERGED", mergedAt: "2026-10-12T10:00:00Z", mergeCommit: { oid: "abc" } });
  const failed = aRun({ conclusion: "failure", jobs: [aJob({ name: "DEPLOY - Dev", conclusion: "failure" })] });
  const later = { title: "Bump ktor (#2328)", url: "https://github.com/o/r/actions/runs/99" };

  test("counts as deployed, by that run", () => {
    const facts = factsFrom(merged, [failed], NOW, [], [], [], { deployedBy: later });
    expect(facts.deploy).toBe("SUCCEEDED");
    expect(facts.deployedBy).toEqual(later);
    expect(facts.runUrl).toBe(later.url);
  });

  test("only for a failed deploy", () => {
    expect(factsFrom(merged, [aRun({ jobs: [aJob({ name: "DEPLOY - Dev" })] })], NOW, [], [], [], { deployedBy: later }).deployedBy).toBeUndefined();
  });
});

describe("a deploy queued behind a run waiting for approval (plan 2, infra#759)", () => {
  const merged = aPrView({ state: "MERGED", mergedAt: "2026-10-12T10:00:00Z", mergeCommit: { oid: "abc" } });
  const queued = aRun({ status: "pending", conclusion: "", jobs: [] , usuallyDeploys: true });
  const blocker = { title: "Apply bass Team (#751)", url: "https://github.com/o/r/actions/runs/1", since: Date.parse("2026-10-04T08:00:00Z") };

  test("is blocked, not deploying", () => {
    const facts = factsFrom(merged, [queued], NOW, [], [], [], { blockedBy: blocker });
    expect(facts.deploy).toBe("BLOCKED");
    expect(facts.blockedBy).toEqual(blocker);
    expect(nextStep(facts, NOW)).toBe("DEPLOY_BLOCKED");
  });

  test("not once the run has jobs", () => {
    const started = aRun({ status: "in_progress", conclusion: "", jobs: [aJob({ name: "DEPLOY - Prod", status: "in_progress", conclusion: "" })] });
    expect(factsFrom(merged, [started], NOW, [], [], [], { blockedBy: blocker }).deploy).toBe("RUNNING");
  });
});

describe("which run failed (plan 16)", () => {
  test("a failing check: its workflow and run", () => {
    const view = aPrView({ statusCheckRollup: [{ name: "Build", workflowName: "MAIN", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/o/r/actions/runs/5/job/51" }] });
    expect(factsFrom(view, [], NOW).failedRun).toEqual({ workflow: "MAIN", url: "https://github.com/o/r/actions/runs/5" });
  });

  test("a failed deploy: its workflow and run", () => {
    const merged = aPrView({ state: "MERGED", mergedAt: "2026-10-12T10:00:00Z", mergeCommit: { oid: "abc" } });
    const run = aRun({ conclusion: "failure", url: "https://github.com/o/r/actions/runs/9", jobs: [aJob({ name: "DEPLOY - Prod", conclusion: "failure" })] });
    expect(factsFrom(merged, [run], NOW).failedRun).toEqual({ workflow: "MAIN - Deployment pipeline", url: "https://github.com/o/r/actions/runs/9", jobs: ["DEPLOY - Prod"] });
  });
});

describe("matrix deploy jobs (plan 17)", () => {
  test("the failed jobs are named, matrix value included", () => {
    const merged = aPrView({ state: "MERGED", mergedAt: "2026-10-12T10:00:00Z", mergeCommit: { oid: "abc" } });
    const run = aRun({
      workflowName: "Terraform Organizations", conclusion: "failure", url: "u",
      jobs: [aJob({ name: "Apply acme-eu Organization" }), aJob({ name: "Apply acme Organization", conclusion: "failure" })],
      role: "deploy",
    });
    expect(factsFrom(merged, [run], NOW).failedRun?.jobs).toEqual(["Apply acme Organization"]);
  });
});

describe("bookkeeping jobs: change detection and status jobs don't mean a pipeline was built", () => {
  const checks = (name: string) => [
    { name, workflowName: "Web", status: "COMPLETED", conclusion: "SUCCESS" },
    { name: "Build", workflowName: "Web", status: "COMPLETED", conclusion: "SKIPPED" },
  ];
  const deploying = aRun({ workflowName: "Web", status: "in_progress", conclusion: "", jobs: [aJob({ name: "Deploy", status: "in_progress", conclusion: "" })] });
  const builds = (name: string) => factsFrom(aPrView({ statusCheckRollup: checks(name) }), [], NOW, [], [], [deploying]).deployingOnBase.length > 0;

  test("common names are recognised by default", () => {
    for (const name of ["Detect changes", "changes", "paths-filter", "Build status - web", "CI status", "All checks passed"]) expect(builds(name)).toBe(false);
    expect(builds("Web / Detect changes")).toBe(false);
    expect(builds("Unit tests")).toBe(true);
    expect(builds("Apply changes")).toBe(true);
  });

  test("the names can be configured", () => {
    setBookkeepingJobs(["gatekeeper"]);
    try {
      expect(builds("Gatekeeper")).toBe(false);
      expect(builds("Detect changes")).toBe(true);
    } finally {
      setBookkeepingJobs(undefined);
    }
  });
});

describe("who is asked to review", () => {
  test("people by login, teams by name", () => {
    const view = aPrView({ reviewRequests: [{ login: "octocat" }, { name: "platform-approvers", slug: "o/platform-approvers" }] } as never);
    expect(factsFrom(view, [], NOW).reviewers).toEqual(["octocat", "platform-approvers"]);
  });

  test("none asked: none listed", () => {
    expect(factsFrom(aPrView({}), [], NOW).reviewers).toBeUndefined();
  });
});
