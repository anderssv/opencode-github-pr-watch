import { describe, expect, test } from "bun:test";
import { conditionalGet, isPlainGet, parseHttp, type EtagStore } from "../core/etag";

const raw = (status: string, headers: Record<string, string>, body = "") =>
  [`HTTP/2.0 ${status}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), "", body].join("\r\n");

describe("parseHttp: gh api -i's answer", () => {
  test("status, ETag and body", () => {
    expect(parseHttp(raw("200 OK", { Etag: 'W/"abc"', "Content-Type": "application/json" }, '{"a":1}'))).toEqual({ status: 200, etag: 'W/"abc"', body: '{"a":1}' });
    expect(parseHttp(raw("304 Not Modified", {}))).toEqual({ status: 304, body: "" });
  });
});

describe("isPlainGet: which gh calls can be asked conditionally", () => {
  test("gh api <path>, with headers at most", () => {
    expect(isPlainGet(["api", "repos/o/r/actions/runs?head_sha=abc"])).toBe(true);
    expect(isPlainGet(["api", "repos/o/r/contents/x.yml", "-H", "Accept: application/vnd.github.raw"])).toBe(true);
  });

  test("not GraphQL, writes, jq or anything else", () => {
    expect(isPlainGet(["api", "graphql", "-f", "query=x"])).toBe(false);
    expect(isPlainGet(["api", "-X", "POST", "repos/o/r/x"])).toBe(false);
    expect(isPlainGet(["api", "repos/o/r/commits/x/pulls", "--jq", ".[0].number"])).toBe(false);
    expect(isPlainGet(["api", "--allow-escape-sequences", "repos/o/r/actions/jobs/1/logs"])).toBe(false);
    expect(isPlainGet(["run", "list"])).toBe(false);
  });
});

describe("conditionalGet: an unchanged answer costs nothing", () => {
  const store = (): EtagStore => new Map();

  test("the first time asked plainly; then with the ETag, and a 304 gives the kept answer", async () => {
    const kept = store();
    const sent: (string | undefined)[] = [];
    const answers = [raw("200 OK", { ETag: '"v1"' }, "body 1"), raw("304 Not Modified", {})];
    const fetch = async (etag?: string) => (sent.push(etag), answers.shift()!);
    expect(await conditionalGet(kept, "k", fetch)).toBe("body 1");
    expect(await conditionalGet(kept, "k", fetch)).toBe("body 1");
    expect(sent).toEqual([undefined, '"v1"']);
  });

  test("a changed answer replaces the kept one", async () => {
    const kept = store();
    const answers = [raw("200 OK", { ETag: '"v1"' }, "old"), raw("200 OK", { ETag: '"v2"' }, "new")];
    const fetch = async () => answers.shift()!;
    await conditionalGet(kept, "k", fetch);
    expect(await conditionalGet(kept, "k", fetch)).toBe("new");
    expect(kept.get("k")).toEqual({ etag: '"v2"', body: "new" });
  });

  test("an error status fails with GitHub's message", async () => {
    const fetch = async () => raw("404 Not Found", {}, '{"message":"Not Found","status":"404"}');
    await expect(conditionalGet(store(), "k", fetch)).rejects.toThrow("Not Found (HTTP 404)");
  });

  test("a 304 with nothing kept (after a restart) asks again plainly", async () => {
    const sent: (string | undefined)[] = [];
    const answers = [raw("200 OK", { ETag: '"v1"' }, "fresh")];
    const kept = store();
    kept.set("k", { etag: '"v0"', body: undefined as unknown as string });
    const fetch = async (etag?: string) => (sent.push(etag), etag ? raw("304 Not Modified", {}) : answers.shift()!);
    expect(await conditionalGet(kept, "k", fetch)).toBe("fresh");
    expect(sent).toEqual(['"v0"', undefined]);
  });
});

describe("conditionalGet: a missing file isn't asked for again for an hour", () => {
  test("a 404 is kept and answered from memory, then asked again", async () => {
    let now = 0;
    const kept: EtagStore = new Map();
    let calls = 0;
    const fetch = async () => (calls++, raw("404 Not Found", {}, '{"message":"Not Found"}'));
    await expect(conditionalGet(kept, "k", fetch, () => now)).rejects.toThrow("Not Found (HTTP 404)");
    await expect(conditionalGet(kept, "k", fetch, () => now)).rejects.toThrow("Not Found (HTTP 404)");
    expect(calls).toBe(1);
    now = 60 * 60_000 + 1;
    await expect(conditionalGet(kept, "k", fetch, () => now)).rejects.toThrow("Not Found (HTTP 404)");
    expect(calls).toBe(2);
  });
});
