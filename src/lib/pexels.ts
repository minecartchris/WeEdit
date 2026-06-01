// Thin Pexels API client (photos + videos). Free tier is 200 requests/hr.
// Pexels CORS-permissive so fetch() works from the webview directly.
//
// Docs: https://www.pexels.com/api/documentation/

const PEXELS_API = "https://api.pexels.com";

export interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  photographer: string;
  photographer_url: string;
  alt: string;
  src: {
    original: string;
    large2x: string;
    large: string;
    medium: string;
    small: string;
    tiny: string;
  };
}

export interface PexelsVideoFile {
  id: number;
  quality: string; // e.g. "hd", "sd", "hls"
  file_type: string; // e.g. "video/mp4"
  width: number;
  height: number;
  fps: number;
  link: string;
}

export interface PexelsVideoPic {
  id: number;
  picture: string;
  nr: number;
}

export interface PexelsVideo {
  id: number;
  width: number;
  height: number;
  duration: number;
  url: string;
  image: string;
  user: { id: number; name: string; url: string };
  video_files: PexelsVideoFile[];
  video_pictures: PexelsVideoPic[];
}

interface PhotosResponse {
  photos: PexelsPhoto[];
  total_results: number;
  page: number;
  per_page: number;
  next_page?: string;
}

interface VideosResponse {
  videos: PexelsVideo[];
  total_results: number;
  page: number;
  per_page: number;
  next_page?: string;
}

async function pexelsFetch<T>(path: string, key: string): Promise<T> {
  const res = await fetch(`${PEXELS_API}${path}`, {
    headers: { Authorization: key },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Pexels ${path} failed (${res.status}): ${body || "no body"}`);
  }
  return res.json();
}

export async function searchPhotos(
  key: string,
  query: string,
  page = 1,
): Promise<{ photos: PexelsPhoto[]; nextPage: number | null }> {
  const data = await pexelsFetch<PhotosResponse>(
    `/v1/search?query=${encodeURIComponent(query)}&page=${page}&per_page=24`,
    key,
  );
  return { photos: data.photos, nextPage: data.next_page ? page + 1 : null };
}

export async function searchVideos(
  key: string,
  query: string,
  page = 1,
): Promise<{ videos: PexelsVideo[]; nextPage: number | null }> {
  const data = await pexelsFetch<VideosResponse>(
    `/videos/search?query=${encodeURIComponent(query)}&page=${page}&per_page=12`,
    key,
  );
  return { videos: data.videos, nextPage: data.next_page ? page + 1 : null };
}

/** Pick the highest-quality MP4 ≤ 1080p (above 1080 wastes disk for short B-roll). */
export function bestVideoFile(video: PexelsVideo): PexelsVideoFile | null {
  const mp4s = video.video_files.filter((f) => f.file_type === "video/mp4");
  if (mp4s.length === 0) return null;
  const ranked = [...mp4s].sort((a, b) => {
    // Score: closer to 1080p the better; prefer mid-range over excessive 4k.
    const score = (f: PexelsVideoFile) => {
      const h = f.height;
      if (h >= 1080 && h <= 1440) return 1000 + h;
      if (h > 1440) return 800 - (h - 1440); // penalize ultra-HD
      return h; // anything below 1080 is just by raw height
    };
    return score(b) - score(a);
  });
  return ranked[0];
}

/** "1080p · 24s · 1920×1080" style helper for the result cards. */
export function describeVideo(video: PexelsVideo): string {
  const best = bestVideoFile(video);
  const res = best ? `${best.width}×${best.height}` : `${video.width}×${video.height}`;
  return `${video.duration}s · ${res}`;
}
