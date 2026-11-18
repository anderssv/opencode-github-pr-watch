export interface DetectedMerge {
  readonly repo?: string;
  readonly pr?: string;
}

const MERGE_VALUE_FLAGS = new Set(["--subject", "-t", "--body", "-b", "--body-file", "-F", "--match-head-commit", "--author-email", "-A"]);
const RERUN_VALUE_FLAGS = new Set(["--job", "-j"]);
const NO_VALUE_FLAGS = new Set<string>();

const isRedirect = (token: string) => /^\d*[<>]/.test(token);
const unquote = (token: string) => token.replace(/^["']|["']$/g, "");

interface Invocation {
  readonly tokens: readonly string[];
  readonly repo?: string;
  readonly target?: string;
}

// Finds `gh <subcommand>` where gh is the command being run (not text passed to echo or grep), and reads its repo
// and first positional argument.
function invocations(command: string, subcommand: string, valueFlags: ReadonlySet<string>): Invocation[] {
  command = command.replace(/\\\r?\n/g, " ");
  const pattern = new RegExp(`(?:^|[;&|(\\n]|\\bdo\\b|\\bthen\\b)\\s*gh ${subcommand}\\b([^;|&\\n)]*)`, "g");
  return [...command.matchAll(pattern)].map((match) => {
    const tokens = (match[1]!.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).filter((t) => !isRedirect(t)).map(unquote);
    let repo: string | undefined;
    let target: string | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token === "--repo" || token === "-R") repo = tokens[++i];
      else if (token.startsWith("--repo=")) repo = token.slice("--repo=".length);
      else if (valueFlags.has(token)) i++;
      else if (!token.startsWith("-") && target === undefined && /^(#?\d+|https?:\/\/\S+|[\w.-]+\/[\w.-]+#\d+|\$.*)$/.test(token)) target = token;
    }
    return { tokens, repo, target };
  });
}

// Only literal arguments are used. A command whose target or repo comes from a shell variable (typical in loops) is
// skipped, because guessing its value could start a watch on the wrong PR.
const usesVariable = ({ repo, target }: Invocation) => [repo, target].some((value) => value?.includes("$"));

export function findPrMerges(command: string): DetectedMerge[] {
  return [
    ...invocations(command, "pr merge", MERGE_VALUE_FLAGS)
      .filter((inv) => !inv.tokens.includes("--disable-auto") && !usesVariable(inv))
      .map(({ repo, target }) => ({ repo, pr: target })),
    ...apiCalls(command, "merge"),
  ];
}

// `gh api … repos/<owner>/<repo>/pulls/<n>/<action>` (the REST form the agent sometimes uses instead of `gh pr …`).
function apiCalls(command: string, action: string): DetectedMerge[] {
  const gh = String.raw`(?:gh|"?\$\{?GH\}?"?|\S*/gh)`;
  const pattern = new RegExp(
    String.raw`(?:^|[;&|(\n]|\bdo\b|\bthen\b)\s*${gh} api\b[^;|&\n)]*?/?repos/([\w.-]+/[\w.-]+)/pulls/(\d+)/${action}\b`,
    "g",
  );
  return [...command.matchAll(pattern)].map((m) => ({ repo: m[1]!, pr: m[2]! }));
}

export function findRunReruns(command: string): { repo?: string; run: string }[] {
  return invocations(command, "run rerun", RERUN_VALUE_FLAGS)
    .filter((inv) => inv.target !== undefined && /^\d+$/.test(inv.target) && !usesVariable(inv))
    .map(({ repo, target }) => (repo ? { repo, run: target! } : { run: target! }));
}

export function findBranchUpdates(command: string): DetectedMerge[] {
  const cli = invocations(command, "pr update-branch", NO_VALUE_FLAGS)
    .filter((inv) => !usesVariable(inv))
    .map(({ repo, target }) => ({ repo, pr: target }));
  return [...cli, ...apiCalls(command, "update-branch")];
}


/** `gh pr update-branch` on a PR that wasn't behind: no new commit is coming. */
export const alreadyUpToDate = (output: string) => /already up[- ]to[- ]date/i.test(output);

const COMMENT_VALUE_FLAGS = new Set(["--body", "-b", "--body-file", "-F", "--editor", "-e"]);

/** `gh pr comment <n> --body "@dependabot rebase"`: asks a bot to push a fresh commit, like a branch update. */
export function findBotRefreshes(command: string): DetectedMerge[] {
  return invocations(command, "pr comment", COMMENT_VALUE_FLAGS)
    .filter((inv) => !usesVariable(inv) && inv.tokens.some((token, i) => (token === "--body" || token === "-b") && /^@[\w-]+(\[bot\])? \w+/.test(inv.tokens[i + 1] ?? "")))
    .map(({ repo, target }) => ({ repo, pr: target }));
}

/**
 * The folder a command ran in: where the shell started, moved by any `cd` the command opens with (`cd x; …` or
 * `cd x && …`). A merge's gh calls without --repo must run there to find the right repository.
 */
export function commandDirectory(command: string, start: string, home: string): string {
  let dir = start;
  let rest = command.trimStart();
  for (;;) {
    const match = rest.match(/^cd\s+("([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(;|&&)\s*/);
    if (!match) return dir;
    const target = match[2] ?? match[3] ?? match[4]!;
    dir = target.startsWith("~") ? home + target.slice(1) : target.startsWith("/") ? target : `${dir.replace(/\/$/, "")}/${target}`;
    rest = rest.slice(match[0].length);
  }
}

const CREATE_VALUE_FLAGS = new Set([
  "--title", "-t", "--body", "-b", "--body-file", "-F", "--base", "-B", "--head", "-H", "--assignee", "-a",
  "--label", "-l", "--milestone", "-m", "--project", "-p", "--reviewer", "-r", "--template", "-T", "--recover",
]);

/** `gh pr create`: the new PR's link comes from the command's output. */
export function findPrCreates(command: string): { repo?: string }[] {
  return invocations(command, "pr create", CREATE_VALUE_FLAGS)
    .filter((inv) => !usesVariable(inv))
    .map(({ repo }) => (repo ? { repo } : {}));
}

/** `git push` of commits (not only tags, not a deletion), for the PR of the branch it pushed. */
export function findGitPushes(command: string): boolean {
  const pushes = [...command.matchAll(/(?:^|[;&|(\n]|\bdo\b|\bthen\b)\s*git\s+push\b([^;&|\n)]*)/g)];
  return pushes.some((m) => !/(^|\s)(--tags|--delete|-d)(\s|$)/.test(m[1] ?? ""));
}

/** The PR links in a command's output, each once. */
export function prUrlsIn(text: string): string[] {
  return [...new Set([...text.matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g)].map((m) => m[0]))];
}
