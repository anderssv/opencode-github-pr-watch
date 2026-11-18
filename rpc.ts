import { Rpc } from "@opencode/schema/rpc";

const row = {
  type: "object",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    url: { type: "string" },
    detail: { type: "string" },
    tone: { type: "string", enum: ["pending", "waiting", "failed", "done"] },
    runUrl: { type: "string" },
    waitingFor: { type: "string", enum: ["code-review", "run-approval"] },
    sessionID: { type: "string" },
    sessionTitle: { type: "string" },
    author: { type: "string" },
    state: { type: "string", enum: ["OPEN", "MERGED", "CLOSED"] },
    draft: { type: "boolean" },
    attention: { type: "boolean", enum: [true] },
    track: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", enum: ["Checks", "Review", "Merge", "Deploy", "Run"] },
          state: { type: "string", enum: ["done", "running", "waiting", "failed", "upcoming"] },
          detail: { type: "string" },
        },
        required: ["name", "state"],
        additionalProperties: false,
      },
    },
    runLinks: {
      type: "array",
      items: { type: "object", properties: { label: { type: "string" }, url: { type: "string" } }, required: ["label", "url"], additionalProperties: false },
    },
  },
  required: ["id", "label", "url", "detail", "tone"],
  additionalProperties: false,
} as const;

const myPr = {
  type: "object",
  properties: {
    repo: { type: "string" },
    number: { type: "number" },
    title: { type: "string" },
    url: { type: "string" },
    draft: { type: "boolean" },
    createdAt: { type: "string" },
    closedAt: { type: "string" },
  },
  required: ["repo", "number", "title", "url", "draft", "createdAt"],
  additionalProperties: false,
} as const;

/** What the desktop and terminal UI parts read from the server part: the session's watches, and when they change. */
export const PrWatch = Rpc.define({
  id: "pr-watch",
  methods: {
    list: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
      output: { type: "object", properties: { watches: { type: "array", items: row } }, required: ["watches"], additionalProperties: false },
    },
    listAll: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: {
          sessions: {
            type: "array",
            items: {
              type: "object",
              properties: { sessionID: { type: "string" }, title: { type: "string" }, directory: { type: "string" }, watches: { type: "array", items: row } },
              required: ["sessionID", "title", "watches"],
              additionalProperties: false,
            },
          },
        },
        required: ["sessions"],
        additionalProperties: false,
      },
    },
    myPrs: {
      input: { type: "object", properties: { merged: { type: "boolean" } }, additionalProperties: false },
      output: {
        type: "object",
        properties: {
          open: { type: "array", items: myPr },
          merged: { type: "array", items: myPr },
          watched: { type: "array", items: { type: "string" } },
          watchedRows: { type: "array", items: row },
        },
        required: ["open", "merged", "watched", "watchedRows"],
        additionalProperties: false,
      },
    },
    myPrTopics: {
      input: { type: "object", properties: { sessionID: { type: "string" }, merged: { type: "boolean" } }, required: ["sessionID"], additionalProperties: false },
      output: {
        type: "object",
        properties: {
          topics: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, prs: { type: "array", items: { type: "string" } } },
              required: ["name", "prs"],
              additionalProperties: false,
            },
          },
        },
        required: ["topics"],
        additionalProperties: false,
      },
    },
    watch: {
      input: { type: "object", properties: { sessionID: { type: "string" }, pr: { type: "string" } }, required: ["sessionID", "pr"], additionalProperties: false },
      output: { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false },
    },
    unwatch: {
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
      output: { type: "object", additionalProperties: false },
    },
    // Every watch checks GitHub now, instead of at its next turn; ignored if asked within the last 20 seconds.
    watches: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { rows: { type: "array", items: row }, me: { type: "string" } },
        required: ["rows"],
        additionalProperties: false,
      },
    },
    checkNow: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object", properties: { checking: { type: "boolean" } }, required: ["checking"], additionalProperties: false },
    },
  },
  events: {
    changed: {
      // The watch's new row, or no row when it stopped: the GUI patches its store with it.
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" }, id: { type: "string" }, row },
        required: ["sessionID"],
        additionalProperties: false,
      },
    },
  },
});
