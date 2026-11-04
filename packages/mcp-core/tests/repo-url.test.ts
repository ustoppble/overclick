import { describe, expect, it } from "vitest";
import { ProjectCreateInputSchema, ProjectUpdateInputSchema } from "../src/index";

const create = (repo_url: string) => ProjectCreateInputSchema.safeParse({ name: "P", organization: "General", repo_url });
const update = (repo_url: string | null) => ProjectUpdateInputSchema.safeParse({ project_id: "OC", repo_url });

describe("project repo_url is a place the board may later reach", () => {
  it.each([
    "https://github.com/example/repo",
    "https://git.example.com:8443/team/repo.git",
    "ssh://git@git.example.com/team/repo.git",
    "file:///Users/me/lab",
  ])("accepts %s", (url) => {
    expect(create(url).success).toBe(true);
    expect(update(url).success).toBe(true);
  });

  it("keeps clearing repo_url with null", () => {
    expect(update(null).success).toBe(true);
  });

  it.each([
    "ext::sh -c id",
    "git://git.example.com/repo",
    "ftp://git.example.com/repo",
    "http://git.example.com/repo",
    "javascript:alert(1)",
    "data:text/plain,x",
    "https://user:secret@git.example.com/repo",
    "ssh://git:secret@git.example.com/repo",
    "https://",
    "not a url",
  ])("rejects %s", (url) => {
    expect(create(url).success).toBe(false);
    expect(update(url).success).toBe(false);
  });
});
