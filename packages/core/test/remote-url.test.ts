import { describe, expect, it } from "vitest";
import { normalizeRemoteUrl, repoRelativePath } from "../src/index.js";

describe("normalizeRemoteUrl", () => {
  it.each([
    "git@github.com:Org/Repo.git",
    "git@github.com:org/repo",
    "https://github.com/org/repo.git",
    "https://github.com/org/repo/",
    "https://user:secret-token@github.com/Org/Repo.git",
    "http://github.com/org/repo",
    "ssh://git@github.com/org/repo.git",
    "ssh://git@github.com:22/org/repo.git",
    "ssh://git@github.com:org/repo.git",
    "git://github.com/org/repo.git",
    "git+ssh://git@github.com/org/repo.git",
    "  https://GitHub.com/org/repo.git\n",
  ])("maps %j to github.com/org/repo", (url) => {
    expect(normalizeRemoteUrl(url)).toBe("github.com/org/repo");
  });

  it("keeps nested group paths (GitLab subgroups)", () => {
    expect(normalizeRemoteUrl("git@gitlab.com:a/b/c.git")).toBe("gitlab.com/a/b/c");
    expect(normalizeRemoteUrl("https://gitlab.com/a/b/c")).toBe("gitlab.com/a/b/c");
  });

  it("unifies Azure DevOps ssh and https forms", () => {
    const id = "dev.azure.com/org/proj/repo";
    expect(normalizeRemoteUrl("git@ssh.dev.azure.com:v3/org/proj/repo")).toBe(id);
    expect(normalizeRemoteUrl("https://org@dev.azure.com/org/proj/_git/repo")).toBe(id);
  });

  it("normalizes local-path remotes across platforms", () => {
    const win = "file:c:/repos/thing";
    expect(normalizeRemoteUrl("C:\\repos\\thing.git")).toBe(win);
    expect(normalizeRemoteUrl("c:/repos/thing/")).toBe(win);
    expect(normalizeRemoteUrl("file:///C:/repos/thing.git")).toBe(win);
    expect(normalizeRemoteUrl("/srv/git/thing.git")).toBe("file:/srv/git/thing");
    expect(normalizeRemoteUrl("file:///srv/git/thing")).toBe("file:/srv/git/thing");
    expect(normalizeRemoteUrl("\\\\server\\share\\thing.git")).toBe("file://server/share/thing");
  });

  it("returns null for nothing usable", () => {
    for (const bad of ["", "   ", "not a url", "https://github.com/", "git@github.com:"]) {
      expect(normalizeRemoteUrl(bad)).toBeNull();
    }
  });
});

describe("repoRelativePath", () => {
  it("gives the cwd relative to the root with forward slashes", () => {
    expect(repoRelativePath("/home/dev/proj", "/home/dev/proj/apps/web")).toBe("apps/web");
    expect(repoRelativePath("/home/dev/proj", "/home/dev/proj")).toBe("");
    expect(repoRelativePath("/home/dev/proj/", "/home/dev/proj/")).toBe("");
  });

  it("matches git's forward-slash root against a Windows cwd", () => {
    expect(repoRelativePath("C:/Users/dev/proj", "c:\\Users\\dev\\proj\\packages\\core")).toBe(
      "packages/core",
    );
  });

  it("is null outside the repository", () => {
    expect(repoRelativePath("/home/dev/proj", "/home/dev/project")).toBeNull();
    expect(repoRelativePath("/home/dev/proj", "/tmp")).toBeNull();
  });
});
