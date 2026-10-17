export interface ReleaseCheck {
  version: string;
  url: string;
  state: "newer" | "current" | "unknown";
}

function parts(version: string): number[] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  return match ? match.slice(1, 4).map(Number) : null;
}

type GithubRelease = { tag_name?: string; html_url?: string; prerelease?: boolean; draft?: boolean };
let latestRelease: Promise<GithubRelease | null> | null = null;

async function fetchLatestRelease(force: boolean): Promise<GithubRelease | null> {
  if (force) latestRelease = null;
  if (latestRelease) return latestRelease;
  const repository = import.meta.env.VITE_GITHUB_REPO?.trim() || "keredson/openpill";
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository)) {
    throw new Error("Release checks are not configured for this site yet.");
  }
  latestRelease = fetch(
    `https://api.github.com/repos/${repository}/releases?per_page=20`,
    { headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(10000) }
  ).then(async (response) => {
    if (!response.ok) throw new Error("Could not check GitHub releases. Please try again later.");
    const releases = await response.json() as GithubRelease[];
    return releases.find((release) => !release.draft && !release.prerelease) ?? null;
  }).catch((error) => {
    latestRelease = null;
    throw error;
  });
  return latestRelease;
}

export async function checkLatestRelease(installedVersion: string, force = false): Promise<ReleaseCheck | null> {
  const release = await fetchLatestRelease(force);
  if (!release) return null;
  if (!release.tag_name || !release.html_url) throw new Error("The latest release is missing version information.");
  const latest = parts(release.tag_name);
  const installed = parts(installedVersion);
  let state: ReleaseCheck["state"] = "unknown";
  if (latest && installed) {
    const comparison = latest.findIndex((value, index) => value !== installed[index]);
    state = comparison < 0 || latest[comparison] <= installed[comparison] ? "current" : "newer";
  }
  return { version: release.tag_name, url: release.html_url, state };
}
