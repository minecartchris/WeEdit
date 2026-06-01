// Freesound APIv2 client. Token-based auth (free API key); search + preview
// URLs work without OAuth. Token can be passed as `&token=` query param OR
// `Authorization: Token <key>` header — we use the header to keep query strings
// clean. Docs: https://freesound.org/docs/api/

const FREESOUND_API = "https://freesound.org/apiv2";

export interface FreesoundResult {
  id: number;
  name: string;
  username: string;
  duration: number; // seconds
  previews: {
    "preview-hq-mp3": string;
    "preview-lq-mp3": string;
    "preview-hq-ogg": string;
    "preview-lq-ogg": string;
  };
  url: string; // human-readable detail page
  license: string;
}

interface FreesoundSearchResponse {
  count: number;
  next: string | null;
  previous: string | null;
  results: FreesoundResult[];
}

export async function searchFreesound(
  key: string,
  query: string,
  page = 1,
  pageSize = 20,
): Promise<{ results: FreesoundResult[]; nextPage: number | null }> {
  const params = new URLSearchParams({
    query,
    page: String(page),
    page_size: String(pageSize),
    fields: "id,name,username,duration,previews,url,license",
  });
  const res = await fetch(`${FREESOUND_API}/search/text/?${params}`, {
    headers: { Authorization: `Token ${key}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Freesound search failed (${res.status}): ${text || "no body"}`);
  }
  const data = (await res.json()) as FreesoundSearchResponse;
  return { results: data.results, nextPage: data.next ? page + 1 : null };
}
