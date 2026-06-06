// Single source of truth for the public-facing WeEdit links (website, GitHub,
// release downloads). Used by the web banner and anywhere else that needs to
// point users at the desktop download.

export const GITHUB_OWNER = "minecartchris";
export const GITHUB_REPO = "WeEdit";

/** The repository home. */
export const GITHUB_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`;

/** The "latest release" page — always redirects to the newest published release. */
export const LATEST_RELEASE_URL = `${GITHUB_URL}/releases/latest`;

/** GitHub API endpoint for the latest release (tag + assets), no auth required. */
export const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;

/** Public marketing site / landing page. */
export const WEBSITE_URL = "https://weedit.minecartchris.cc";
