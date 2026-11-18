import { describe, expect, test } from "bun:test";
import { alreadyUpToDate, commandDirectory, findBotRefreshes, findBranchUpdates, findPrMerges, findRunReruns } from "../core/merge-detection";

describe("findPrMerges", () => {
  test("finds a merge with a PR number and --repo", () => {
    const merges = findPrMerges("gh pr merge 613 --repo acme/billing --squash");

    expect(merges).toEqual([{ repo: "acme/billing", pr: "613" }]);
  });

  test("reads the repo from -R and --repo=", () => {
    expect(findPrMerges("gh pr merge 5 -R acme/api")).toEqual([{ repo: "acme/api", pr: "5" }]);
    expect(findPrMerges("gh pr merge --repo=acme/api 5")).toEqual([{ repo: "acme/api", pr: "5" }]);
  });

  test("reads a PR URL", () => {
    const merges = findPrMerges("gh pr merge https://github.com/acme/platform/pull/2319 --auto --squash");

    expect(merges).toEqual([{ repo: undefined, pr: "https://github.com/acme/platform/pull/2319" }]);
  });

  test("a merge without a PR argument targets the current branch", () => {
    expect(findPrMerges("gh pr merge --squash --delete-branch")).toEqual([{}]);
  });

  test("stops reading arguments at a shell separator", () => {
    const merges = findPrMerges("gh pr merge --squash 2>&1 | tail -3; sleep 25 && gh run list --limit 4");

    expect(merges).toEqual([{}]);
  });

  test("finds several merges in one command", () => {
    const merges = findPrMerges("gh pr merge 1 -R o/a --squash && gh pr merge 2 -R o/b --squash");

    expect(merges).toEqual([
      { repo: "o/a", pr: "1" },
      { repo: "o/b", pr: "2" },
    ]);
  });

  test("skips a PR given as a shell variable", () => {
    expect(findPrMerges('for n in 1 2; do gh pr merge $n --repo "acme/$r" --squash; done')).toEqual([]);
  });

  test("skips --disable-auto", () => {
    expect(findPrMerges("gh pr merge 5 --disable-auto")).toEqual([]);
  });

  test("does not mistake a flag's value for the PR", () => {
    expect(findPrMerges("gh pr merge -t Release -b notes 42 --squash")).toEqual([{ pr: "42" }]);
    expect(findPrMerges('gh pr merge --subject "Release v1.2" 42')).toEqual([{ pr: "42" }]);
  });

  test("only counts gh when it is the command being run", () => {
    expect(findPrMerges('echo "gh pr merge 627 --repo o/a"')).toEqual([]);
    expect(findPrMerges('grep "gh pr merge" history.log')).toEqual([]);
    expect(findPrMerges("for n in 1; do gh pr merge 7 -R o/a; done")).toEqual([{ repo: "o/a", pr: "7" }]);
    expect(findPrMerges("cd repo && gh pr merge 8")).toEqual([{ pr: "8" }]);
  });

  test("ignores commands without gh pr merge", () => {
    expect(findPrMerges("gh pr view 5 --json state && git merge main")).toEqual([]);
  });
});

describe("findRunReruns", () => {
  test("finds a rerun with a run ID and repo", () => {
    expect(findRunReruns("gh run rerun 37900707000 --failed --repo acme/api")).toEqual([
      { repo: "acme/api", run: "37900707000" },
    ]);
  });

  test("reads -R and works in chained commands", () => {
    expect(findRunReruns("cd x && gh run rerun 42 -R o/a; echo done")).toEqual([{ repo: "o/a", run: "42" }]);
  });

  test("skips reruns without a literal run ID", () => {
    expect(findRunReruns("gh run rerun --failed")).toEqual([]);
    expect(findRunReruns("gh run rerun $id")).toEqual([]);
  });

  test("only counts gh when it is the command being run", () => {
    expect(findRunReruns('echo "gh run rerun 42"')).toEqual([]);
  });
});

describe("findBranchUpdates", () => {
  test("finds a branch update with a PR number and repo", () => {
    expect(findBranchUpdates("gh pr update-branch 1260 --rebase --repo acme/registry")).toEqual([
      { repo: "acme/registry", pr: "1260" },
    ]);
  });

  test("an update without a PR argument targets the current branch", () => {
    expect(findBranchUpdates("gh pr update-branch")).toEqual([{}]);
  });

  test("skips variables and text that only mentions the command", () => {
    expect(findBranchUpdates("for n in 1; do gh pr update-branch $n; done")).toEqual([]);
    expect(findBranchUpdates('echo "gh pr update-branch 5"')).toEqual([]);
  });

  test("finds the REST API form", () => {
    expect(findBranchUpdates("gh api -X PUT repos/acme/web/pulls/1733/update-branch 2>&1; echo")).toEqual([
      { repo: "acme/web", pr: "1733" },
    ]);
    expect(findBranchUpdates("gh api --method PUT /repos/o/r/pulls/5/update-branch")).toEqual([{ repo: "o/r", pr: "5" }]);
  });

  test("the REST API form skips variables and other endpoints", () => {
    expect(findBranchUpdates("gh api -X PUT repos/o/r/pulls/$n/update-branch")).toEqual([]);
    expect(findBranchUpdates("gh api repos/o/r/pulls/5/reviews")).toEqual([]);
    expect(findBranchUpdates('echo "gh api -X PUT repos/o/r/pulls/5/update-branch"')).toEqual([]);
  });
});

describe("API forms", () => {
  test("gh api PUT …/pulls/<n>/update-branch is a branch update", () => {
    expect(findBranchUpdates('"$GH" api -X PUT repos/acme/billing/pulls/625/update-branch 2>&1')).toEqual([
      { repo: "acme/billing", pr: "625" },
    ]);
  });

  test("gh api PUT …/pulls/<n>/merge is a merge", () => {
    expect(findPrMerges("gh api -X PUT repos/o/r/pulls/7/merge -f merge_method=squash")).toEqual([{ repo: "o/r", pr: "7" }]);
  });

  test("other API calls are ignored", () => {
    expect(findPrMerges("gh api repos/o/r/pulls/7")).toEqual([]);
    expect(findBranchUpdates("gh api repos/o/r/pulls/7/reviews")).toEqual([]);
  });

  test("only when gh is the command being run", () => {
    expect(findBranchUpdates('echo "gh api -X PUT repos/o/r/pulls/7/update-branch"')).toEqual([]);
  });
});

describe("multi-line commands", () => {
  test("joins backslash-continued lines", () => {
    expect(findBranchUpdates("gh pr update-branch \\\n  1746 \\\n  --repo acme/web")).toEqual([
      { repo: "acme/web", pr: "1746" },
    ]);
  });

  test("a target that is not a PR reference is ignored", () => {
    expect(findPrMerges("gh pr merge \\")).toEqual([{}]);
  });
});

describe("alreadyUpToDate (plan 9)", () => {
  test("gh's answer when there was nothing to update", () => {
    expect(alreadyUpToDate("✓ PR branch already up-to-date")).toBe(true);
    expect(alreadyUpToDate("✓ PR branch updated")).toBe(false);
  });
});

describe("findBotRefreshes (plan 27)", () => {
  test("a comment that commands a bot", () => {
    expect(findBotRefreshes('gh pr comment 2560 --repo acme/platform --body "@dependabot rebase"')).toEqual([{ repo: "acme/platform", pr: "2560" }]);
    expect(findBotRefreshes("gh pr comment 12 -b '@dependabot recreate'")).toEqual([{ pr: "12" }]);
  });

  test("not an ordinary comment", () => {
    expect(findBotRefreshes('gh pr comment 12 --body "Looks good"')).toEqual([]);
    expect(findBotRefreshes('echo "gh pr comment 12 --body @dependabot rebase"')).toEqual([]);
  });
});

describe("commandDirectory: the folder a command ran in, for its gh calls without --repo", () => {
  test("a leading cd, absolute, under ~, or relative to where the shell started", () => {
    expect(commandDirectory("cd ~/src/app; gh pr merge 1", "/base", "/home/me")).toBe("/home/me/src/app");
    expect(commandDirectory("cd /work/app && gh pr merge 1", "/base", "/home/me")).toBe("/work/app");
    expect(commandDirectory("cd app && cd sub; gh pr merge 1", "/base", "/home/me")).toBe("/base/app/sub");
    expect(commandDirectory('cd "/my work/app"; gh pr merge 1', "/base", "/home/me")).toBe("/my work/app");
  });

  test("no cd first: where the shell started", () => {
    expect(commandDirectory("gh pr merge 1", "/base", "/home/me")).toBe("/base");
    expect(commandDirectory("echo cd /x; gh pr merge 1", "/base", "/home/me")).toBe("/base");
  });
});
