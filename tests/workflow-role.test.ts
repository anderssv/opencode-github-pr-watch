import { describe, expect, test } from "bun:test";
import { environmentsPrompt, matchWorkflow, parseEnvironments, parseRole, rolePrompt } from "../core/workflow-role";

describe("rolePrompt", () => {
  test("gives the model the workflow's name, path, jobs and file, and asks for deploy or other", () => {
    const prompt = rolePrompt({
      name: "Deploy OpenAPI Docs to GitHub Pages",
      path: ".github/workflows/deploy-openapi.yml",
      jobs: ["build", "deploy"],
      file: "on: push\njobs:\n  deploy:\n    environment: github-pages",
    });
    expect(prompt).toContain("Deploy OpenAPI Docs to GitHub Pages");
    expect(prompt).toContain("deploy-openapi.yml");
    expect(prompt).toContain("- build");
    expect(prompt).toContain("github-pages");
    expect(prompt).toContain('{"role": "deploy" | "other"}');
  });
});

describe("parseRole", () => {
  test("only the two roles are accepted", () => {
    expect(parseRole('{"role": "deploy"}')).toBe("deploy");
    expect(parseRole('{"role": "other"}')).toBe("other");
    expect(parseRole('{"role": "rm -rf"}')).toBeUndefined();
    expect(parseRole("??")).toBeUndefined();
  });
});

describe("matchWorkflow", () => {
  const workflows = [
    { id: 1, name: "MAIN - Deployment pipeline", path: ".github/workflows/main.yml" },
    { id: 2, name: "CodeQL", path: ".github/workflows/codeql.yml" },
  ];

  test("by name or file, ignoring case", () => {
    expect(matchWorkflow("main - deployment pipeline", workflows)).toBe(1);
    expect(matchWorkflow("main.yml", workflows)).toBe(1);
    expect(matchWorkflow(".github/workflows/codeql.yml", workflows)).toBe(2);
  });

  test("nothing for an unknown name", () => {
    expect(matchWorkflow("deploy", workflows)).toBeUndefined();
  });
});

describe("environmentsPrompt: which environments a workflow's jobs use for a pull request", () => {
  test("asks for the names as JSON, with the event and base branch", () => {
    const prompt = environmentsPrompt("jobs: {}", "main");
    expect(prompt).toContain("pull request into main");
    expect(prompt).toContain('"environments"');
  });

  test("reads the answer; anything else is no answer", () => {
    expect(parseEnvironments('{"environments": ["prod", "dev"]}')).toEqual(["prod", "dev"]);
    expect(parseEnvironments("no idea")).toBeUndefined();
  });
});
