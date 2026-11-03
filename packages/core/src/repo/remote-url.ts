/**
 * Turns a git remote URL into a stable repository id, so every clone of a
 * repository gets the same one however it was cloned:
 *
 *   git@github.com:Org/Repo.git          → github.com/org/repo
 *   https://user@github.com/org/repo/    → github.com/org/repo
 *   ssh://git@github.com:22/org/repo.git → github.com/org/repo
 *   C:\repos\thing.git, file:///c:/repos/thing → file:c:/repos/thing
 *
 * Credentials, ports, `.git`, trailing slashes and letter case are dropped.
 * Azure DevOps ssh (`v3/org/project/repo`) and https (`org/project/_git/repo`)
 * forms map to the same id. Returns null for an empty or unparseable URL.
 */
export function normalizeRemoteUrl(raw: string): string | null {
  const url = raw.trim();
  if (url === "") return null;

  const local = localPath(url);
  if (local !== undefined) return local === "" ? null : `file:${local.toLowerCase()}`;

  let host: string;
  let path: string;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(url);
  if (scheme) {
    const rest = scheme[2] ?? "";
    const slash = rest.indexOf("/");
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    path = slash === -1 ? "" : rest.slice(slash + 1);
    host = authority.slice(authority.lastIndexOf("@") + 1);
    // ssh://host:org/repo (scp-style path after a scheme) vs ssh://host:22/org/repo.
    const colon = host.indexOf(":");
    if (colon !== -1) {
      const after = host.slice(colon + 1);
      if (!/^\d*$/.test(after)) path = `${after}/${path}`;
      host = host.slice(0, colon);
    }
  } else {
    // scp-like: [user@]host:path
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(url);
    if (!scp) return null;
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  }

  host = host.toLowerCase().replace(/^\[|\]$/g, "");
  path = path
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "")
    .join("/")
    .replace(/\.git$/i, "")
    .toLowerCase();
  if (host === "" || path === "") return null;

  if (host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com") {
    // v3/org/project/repo → dev.azure.com/org/project/repo
    return `dev.azure.com/${path.replace(/^v3\//, "")}`;
  }
  if (host === "dev.azure.com" || host.endsWith(".visualstudio.com")) {
    const azureHost = host === "dev.azure.com" ? "" : `${host.split(".")[0]}/`;
    return `dev.azure.com/${azureHost}${path.replace("/_git/", "/")}`;
  }
  return `${host}/${path}`;
}

/** A local-path remote, normalized (forward slashes, no `.git`, no trailing slash); undefined if `url` isn't one. */
function localPath(url: string): string | undefined {
  let p: string;
  if (/^file:\/\//i.test(url)) {
    p = decodeURIComponent(url.slice("file://".length));
    // file:///C:/x → /C:/x
    if (/^\/[a-z]:[\\/]/i.test(p)) p = p.slice(1);
  } else if (
    /^[a-z]:[\\/]/i.test(url) ||
    url.startsWith("/") ||
    url.startsWith("\\\\") ||
    url.startsWith(".")
  ) {
    p = url;
  } else return undefined;
  return p
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
}

/**
 * `cwd` relative to repository `root`, with `/` separators: `""` at the root,
 * null when `cwd` is outside it. Drive letters compare case-insensitively.
 */
export function repoRelativePath(root: string, cwd: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root);
  const c = norm(cwd);
  const fold = /^[a-z]:\//i.test(r) ? (s: string) => s.toLowerCase() : (s: string) => s;
  if (fold(c) === fold(r)) return "";
  return fold(c).startsWith(`${fold(r)}/`) ? c.slice(r.length + 1) : null;
}
