/**
 * What the Salu iPhone app needs for a project (`salu remote phone`): the GitHub repo as owner/name, the project's
 * name, a fine-grained token limited to that repo, and the signing key. Pure helpers; the command prints them.
 */

/** owner/name of a GitHub remote (https, ssh or scp form), or null when the remote is not on github.com. */
export function githubRepo(url: string): { owner: string; repo: string } | null {
  const m = url.trim().match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::\d+)?\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/**
 * GitHub's new fine-grained token page with the name, owner, 90 days and Contents read and write filled in.
 * GitHub can't preselect the repository from a link, so the person still picks "Only select repositories" and
 * this repo; the app's Test connection then shows whether the token reaches anything else.
 */
export function tokenUrl(owner: string, repo: string): string {
  const q = new URLSearchParams({
    name: `salu phone ${repo}`.slice(0, 40),
    description: `Salu iPhone app: reads and writes the salu/inbox branch of ${owner}/${repo}. Repository access: only ${repo}.`,
    target_name: owner,
    expires_in: '90',
    contents: 'write',
  });
  return `https://github.com/settings/personal-access-tokens/new?${q}`;
}
