// WeEdit — Tauri backend entry point.
//
// We expose a small set of plain fs commands instead of leaning on the
// tauri-plugin-fs scope system: project files live at user-chosen paths and the
// scope dance gets verbose fast. Phase 3 will add ffmpeg-sidecar commands here.

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::thread;
use std::time::Duration;
use tauri::Emitter;

// Cooperative-cancel flags for in-flight ffmpeg exports keyed by exportId.
// The exporting task polls its flag inside the wait-loop; `ffmpeg_cancel`
// flips it; the export then kills the child on the next poll tick.
// This avoids the previous race where cancel and the waiter both tried to
// take ownership of the same Child.
static FFMPEG_CANCEL_FLAGS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Helper that runs a closure on Tauri's blocking thread pool and unwraps the
/// JoinHandle so commands stay tidy. Subprocess spawning + child.wait() are
/// blocking calls — running them on the main async runtime backs up IPC and
/// freezes the UI, so every long-running command funnels through this.
async fn run_blocking<T, F>(label: &'static str, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| format!("{label} task join error: {e}"))?
}

#[tauri::command]
fn read_project_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("read failed: {e}"))
}

#[tauri::command]
fn write_project_file(path: String, content: String) -> Result<(), String> {
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir failed: {e}"))?;
    }
    fs::write(&path, content).map_err(|e| format!("write failed: {e}"))
}

#[tauri::command]
fn ensure_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| format!("mkdir failed: {e}"))
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[derive(serde::Serialize)]
struct DirEntry {
    name: String,
    path: String,
    is_directory: bool,
    size_bytes: Option<u64>,
    modified: Option<u64>,
}

#[tauri::command]
async fn list_directory(path: String) -> Result<Vec<DirEntry>, String> {
    run_blocking("list_directory", move || list_directory_blocking(path)).await
}

fn list_directory_blocking(path: String) -> Result<Vec<DirEntry>, String> {
    let read = fs::read_dir(&path).map_err(|e| format!("Failed to read {path}: {e}"))?;
    let mut out = Vec::new();
    for entry in read {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            // Skip dotfiles — keep the list focused on user content.
            continue;
        }
        let entry_path = entry.path().to_string_lossy().to_string();
        let modified = metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);
        let is_directory = metadata.is_dir();
        out.push(DirEntry {
            name,
            path: entry_path,
            is_directory,
            size_bytes: if metadata.is_file() {
                Some(metadata.len())
            } else {
                None
            },
            modified,
        });
    }
    // Directories first, then alphabetical (case-insensitive).
    out.sort_by(|a, b| match (a.is_directory, b.is_directory) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

/// Authenticates a Windows SMB share via `net use`. The password is passed on
/// the command line, which on Windows is per-process — fine for a local user
/// app but not great for shared / multi-user machines.
#[tauri::command]
async fn smb_authenticate(
    target: String,
    username: Option<String>,
    password: Option<String>,
) -> Result<(), String> {
    run_blocking("smb_authenticate", move || {
        smb_authenticate_blocking(target, username, password)
    })
    .await
}

fn smb_authenticate_blocking(
    target: String,
    username: Option<String>,
    password: Option<String>,
) -> Result<(), String> {
    let mut cmd = Command::new("net");
    cmd.arg("use").arg(&target);
    if let Some(pw) = &password {
        cmd.arg(pw);
    }
    if let Some(user) = &username {
        cmd.arg(format!("/user:{user}"));
    }
    cmd.arg("/persistent:no");
    let output = cmd
        .output()
        .map_err(|e| format!("Failed to run `net use`: {e}"))?;
    if !output.status.success() {
        // net writes its English messages to stdout, not stderr.
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        let msg = if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            stderr.trim().to_string()
        };
        // System error 1219 = "Multiple connections to a server..." — already
        // connected with different creds. Treat as success.
        if msg.contains("1219") {
            return Ok(());
        }
        return Err(msg);
    }
    Ok(())
}

// ── ffmpeg / ffprobe (used by the importer for multi-track audio extraction) ──

/// Resolves an ffmpeg-family binary (ffmpeg or ffprobe). Looks at PATH first,
/// then common Windows install locations. Returns the resolved path string or
/// None if the binary isn't found.
fn find_ffmpeg_binary(name: &str) -> Option<String> {
    if Command::new(name).arg("-version").output().is_ok() {
        return Some(name.to_string());
    }
    if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
        let candidates = [
            format!("{local_appdata}\\Microsoft\\WinGet\\Links\\{name}.exe"),
            format!("{local_appdata}\\Microsoft\\WindowsApps\\{name}.exe"),
            format!("C:\\ffmpeg\\bin\\{name}.exe"),
            format!("C:\\Program Files\\ffmpeg\\bin\\{name}.exe"),
        ];
        for c in &candidates {
            if Path::new(c).is_file() {
                return Some(c.clone());
            }
        }
        // Glob winget packages
        let packages = PathBuf::from(format!("{local_appdata}\\Microsoft\\WinGet\\Packages"));
        if let Ok(entries) = fs::read_dir(&packages) {
            for entry in entries.flatten() {
                let dir_name = entry.file_name().to_string_lossy().to_lowercase();
                if dir_name.contains("ffmpeg") {
                    // Look for the binary anywhere under this package dir.
                    if let Some(found) = find_in_dir(&entry.path(), &format!("{name}.exe")) {
                        return Some(found);
                    }
                }
            }
        }
    }
    None
}

fn find_in_dir(dir: &Path, target_name: &str) -> Option<String> {
    let entries = fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_file()
            && path.file_name().and_then(|n| n.to_str()) == Some(target_name)
        {
            return Some(path.to_string_lossy().to_string());
        }
        if path.is_dir() {
            if let Some(found) = find_in_dir(&path, target_name) {
                return Some(found);
            }
        }
    }
    None
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AudioStreamInfo {
    index: usize,
    codec: Option<String>,
    language: Option<String>,
    title: Option<String>,
    channels: Option<u32>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResult {
    audio_streams: Vec<AudioStreamInfo>,
}

/// Probes a video file with ffprobe and returns audio-stream metadata only.
/// Empty list = "ffprobe not available" (the caller can fall back to the
/// HTML5-element probe path and assume single mixed audio).
#[tauri::command]
async fn ffprobe_audio_streams(path: String) -> Result<ProbeResult, String> {
    run_blocking("ffprobe_audio_streams", move || ffprobe_audio_streams_blocking(path)).await
}

fn ffprobe_audio_streams_blocking(path: String) -> Result<ProbeResult, String> {
    let bin = find_ffmpeg_binary("ffprobe")
        .ok_or_else(|| "ffprobe not found. Install ffmpeg via `winget install ffmpeg` and restart WeEdit.".to_string())?;

    let output = Command::new(&bin)
        .args([
            "-v", "error",
            "-show_streams",
            "-select_streams", "a",
            "-of", "json",
            &path,
        ])
        .output()
        .map_err(|e| format!("Failed to run ffprobe: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("ffprobe failed: {}", stderr.trim()));
    }

    #[derive(serde::Deserialize)]
    struct FfprobeStream {
        // ffprobe always emits `index` — keep it parsed so our deserializer
        // doesn't choke on the field; we just don't need it ourselves.
        #[allow(dead_code)]
        index: usize,
        codec_name: Option<String>,
        channels: Option<u32>,
        tags: Option<FfprobeTags>,
    }
    #[derive(serde::Deserialize)]
    struct FfprobeTags {
        language: Option<String>,
        title: Option<String>,
        #[serde(rename = "LANGUAGE")]
        language_upper: Option<String>,
        #[serde(rename = "TITLE")]
        title_upper: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct FfprobeOutput {
        streams: Vec<FfprobeStream>,
    }

    let parsed: FfprobeOutput = serde_json::from_slice(&output.stdout)
        .map_err(|e| format!("ffprobe JSON parse error: {e}"))?;

    let audio_streams: Vec<AudioStreamInfo> = parsed
        .streams
        .into_iter()
        .enumerate()
        .map(|(audio_index, s)| AudioStreamInfo {
            // `audio_index` is the index AMONG audio streams (0, 1, 2…), which
            // is what `-map 0:a:N` accepts. We also keep ffprobe's global stream
            // index in `codec`/etc. lookups, but the audio-relative index is
            // what callers actually need.
            index: audio_index,
            codec: s.codec_name,
            channels: s.channels,
            language: s
                .tags
                .as_ref()
                .and_then(|t| t.language.clone().or_else(|| t.language_upper.clone())),
            title: s
                .tags
                .as_ref()
                .and_then(|t| t.title.clone().or_else(|| t.title_upper.clone())),
        })
        .collect();

    Ok(ProbeResult { audio_streams })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ExtractedTrack {
    index: usize,
    filepath: String,
}

/// Extracts each audio stream of `source_path` into its own file under
/// `output_dir`, with `-c copy` (no re-encode — fast and lossless). The output
/// filename pattern is `track-<i>.m4a`. Returns the list of {index, filepath}.
///
/// Only call when ffprobe reported >1 audio stream — for single-audio videos
/// the muxed audio in the original file is what we want.
#[tauri::command]
async fn ffmpeg_extract_audio_tracks(
    source_path: String,
    output_dir: String,
    track_count: usize,
) -> Result<Vec<ExtractedTrack>, String> {
    run_blocking("ffmpeg_extract_audio_tracks", move || {
        ffmpeg_extract_audio_tracks_blocking(source_path, output_dir, track_count)
    })
    .await
}

fn ffmpeg_extract_audio_tracks_blocking(
    source_path: String,
    output_dir: String,
    track_count: usize,
) -> Result<Vec<ExtractedTrack>, String> {
    let bin = find_ffmpeg_binary("ffmpeg")
        .ok_or_else(|| "ffmpeg not found. Install via `winget install ffmpeg` and restart WeEdit.".to_string())?;

    fs::create_dir_all(&output_dir).map_err(|e| format!("mkdir failed: {e}"))?;

    let mut results = Vec::with_capacity(track_count);
    for i in 0..track_count {
        // Pick an extension based on codec by probing per-stream? Too much for
        // an MVP — `.m4a` container handles AAC/Opus/MP3/etc via stream copy.
        let out_path = format!("{output_dir}/track-{i}.m4a");
        let output = Command::new(&bin)
            .args([
                "-y",                 // overwrite
                "-hide_banner",
                "-loglevel", "error",
                "-i", &source_path,
                "-map", &format!("0:a:{i}"),
                "-c", "copy",
                &out_path,
            ])
            .output()
            .map_err(|e| format!("Failed to run ffmpeg: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("ffmpeg extract track {i} failed: {}", stderr.trim()));
        }
        results.push(ExtractedTrack { index: i, filepath: out_path });
    }
    Ok(results)
}

// ── ffmpeg export (timeline → mp4 via filter_complex) ──

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExportEvent {
    id: String,
    /// 0..1 progress (estimated from out_time / total_duration_sec)
    percent: Option<f32>,
    speed: Option<String>,
    fps: Option<String>,
    eta_sec: Option<f32>,
    out_time_sec: Option<f32>,
    log: Option<String>,
    done: bool,
    error: Option<String>,
}

/// Runs ffmpeg with the given args (caller is responsible for full args
/// including -i, -filter_complex, -map, codec, output path). We append
/// `-progress pipe:1` so we can parse a deterministic stream of key=value
/// progress updates, and emit them as `ffmpeg-progress` events.
///
/// All the blocking work (spawning ffmpeg, draining stdout/stderr, waiting on
/// the child) runs on Tauri's blocking thread pool so it doesn't freeze the
/// IPC. Cancellation is cooperative: the cancel command flips an AtomicBool
/// that this task polls every 100ms.
#[tauri::command]
async fn ffmpeg_run(
    app: tauri::AppHandle,
    args: Vec<String>,
    export_id: String,
    total_duration_sec: f32,
) -> Result<(), String> {
    run_blocking("ffmpeg_run", move || {
        ffmpeg_run_blocking(app, args, export_id, total_duration_sec)
    })
    .await
}

fn ffmpeg_run_blocking(
    app: tauri::AppHandle,
    args: Vec<String>,
    export_id: String,
    total_duration_sec: f32,
) -> Result<(), String> {
    let bin = find_ffmpeg_binary("ffmpeg")
        .ok_or_else(|| "ffmpeg not found. Install via `winget install ffmpeg` and restart WeEdit.".to_string())?;

    // Append progress reporting.
    let mut full_args = args.clone();
    full_args.push("-progress".to_string());
    full_args.push("pipe:1".to_string());

    let mut child = Command::new(&bin)
        .args(&full_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn ffmpeg at {bin}: {e}"))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    // Register a cancellation flag — the cancel command flips this.
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut flags) = FFMPEG_CANCEL_FLAGS.lock() {
        flags.insert(export_id.clone(), cancel.clone());
    }

    let id_for_stdout = export_id.clone();
    let app_for_stdout = app.clone();
    let stdout_thread = thread::spawn(move || {
        let reader = BufReader::new(stdout);
        let mut current = ProgressBuf::default();
        for line in reader.lines() {
            let Ok(line) = line else { continue };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            if let Some((k, v)) = line.split_once('=') {
                current.set(k.trim(), v.trim());
                if k.trim() == "progress" {
                    let evt = current.to_event(&id_for_stdout, total_duration_sec, v.trim() == "end");
                    let _ = app_for_stdout.emit("ffmpeg-progress", evt);
                    current = ProgressBuf::default();
                }
            }
        }
    });

    let id_for_stderr = export_id.clone();
    let app_for_stderr = app.clone();
    let stderr_thread = thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else { continue };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let _ = app_for_stderr.emit(
                "ffmpeg-progress",
                ExportEvent {
                    id: id_for_stderr.clone(),
                    percent: None,
                    speed: None,
                    fps: None,
                    eta_sec: None,
                    out_time_sec: None,
                    log: Some(line.to_string()),
                    done: false,
                    error: None,
                },
            );
        }
    });

    // Poll loop: every 100ms, check if the child has exited or if cancel was
    // requested. This keeps ownership of the Child here so cancel doesn't
    // race the waiter for it.
    let mut cancelled = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if cancel.load(Ordering::Relaxed) {
                    cancelled = true;
                    let _ = child.kill();
                    // Block until kill actually takes effect so we don't leak.
                    match child.wait() {
                        Ok(status) => break status,
                        Err(e) => return Err(format!("ffmpeg wait after kill failed: {e}")),
                    }
                }
                thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("ffmpeg try_wait failed: {e}")),
        }
    };

    // Drop the cancel flag — task is over.
    if let Ok(mut flags) = FFMPEG_CANCEL_FLAGS.lock() {
        flags.remove(&export_id);
    }

    let _ = stdout_thread.join();
    let _ = stderr_thread.join();

    if cancelled {
        let _ = app.emit(
            "ffmpeg-progress",
            ExportEvent {
                id: export_id.clone(),
                percent: None,
                speed: None,
                fps: None,
                eta_sec: None,
                out_time_sec: None,
                log: None,
                done: true,
                error: Some("Cancelled".to_string()),
            },
        );
        return Err("Cancelled".to_string());
    }

    if !status.success() {
        let err = format!("ffmpeg exited with status {}", status.code().unwrap_or(-1));
        let _ = app.emit(
            "ffmpeg-progress",
            ExportEvent {
                id: export_id,
                percent: None,
                speed: None,
                fps: None,
                eta_sec: None,
                out_time_sec: None,
                log: None,
                done: true,
                error: Some(err.clone()),
            },
        );
        return Err(err);
    }

    let _ = app.emit(
        "ffmpeg-progress",
        ExportEvent {
            id: export_id,
            percent: Some(1.0),
            speed: None,
            fps: None,
            eta_sec: Some(0.0),
            out_time_sec: Some(total_duration_sec),
            log: None,
            done: true,
            error: None,
        },
    );
    Ok(())
}

#[tauri::command]
fn ffmpeg_cancel(export_id: String) -> Result<(), String> {
    if let Ok(flags) = FFMPEG_CANCEL_FLAGS.lock() {
        if let Some(flag) = flags.get(&export_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

#[derive(Default)]
struct ProgressBuf {
    out_time_ms: Option<u64>,
    fps: Option<String>,
    speed: Option<String>,
}

impl ProgressBuf {
    fn set(&mut self, key: &str, value: &str) {
        match key {
            "out_time_ms" => {
                if let Ok(n) = value.parse::<u64>() {
                    self.out_time_ms = Some(n);
                }
            }
            "fps" => self.fps = Some(value.to_string()),
            "speed" => self.speed = Some(value.to_string()),
            _ => {}
        }
    }

    fn to_event(&self, id: &str, total_dur_sec: f32, done: bool) -> ExportEvent {
        // `out_time_ms` from -progress is actually MICROseconds despite the
        // name (ffmpeg quirk). Convert accordingly.
        let out_time_sec = self.out_time_ms.map(|us| us as f32 / 1_000_000.0);
        let percent = out_time_sec.map(|t| {
            if total_dur_sec > 0.0 {
                (t / total_dur_sec).clamp(0.0, 1.0)
            } else {
                0.0
            }
        });
        let speed_num = self.speed.as_deref().and_then(parse_speed);
        let eta_sec = match (out_time_sec, speed_num) {
            (Some(t), Some(sp)) if sp > 0.01 => Some(((total_dur_sec - t).max(0.0)) / sp),
            _ => None,
        };
        ExportEvent {
            id: id.to_string(),
            percent,
            speed: self.speed.clone(),
            fps: self.fps.clone(),
            eta_sec,
            out_time_sec,
            log: None,
            done,
            error: None,
        }
    }
}

fn parse_speed(s: &str) -> Option<f32> {
    // e.g. "1.23x" or "N/A"
    let s = s.trim().trim_end_matches('x');
    s.parse::<f32>().ok()
}

// ── HTTP downloads (used by the stock panel to pull Pexels assets) ──

#[tauri::command]
async fn http_download(url: String, output_path: String) -> Result<String, String> {
    if let Some(parent) = Path::new(&output_path).parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("mkdir failed: {e}"))?;
    }

    let response = reqwest::get(&url)
        .await
        .map_err(|e| format!("HTTP error fetching {url}: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {} for {url}", response.status()));
    }

    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("body read failed: {e}"))?;
    tokio::fs::write(&output_path, &bytes)
        .await
        .map_err(|e| format!("write failed: {e}"))?;
    Ok(output_path)
}

// ── yt-dlp integration (used by the Twitch panel to download VODs) ──

/// Resolves a yt-dlp binary to invoke. Strategy:
/// 1. User-configured custom path (from app config)
/// 2. "yt-dlp" on PATH (works if the dev process inherited the latest PATH)
/// 3. Common winget install locations on Windows
///
/// Returns the resolved path string or None if nothing is callable.
fn find_ytdlp(custom: Option<&str>) -> Option<String> {
    if let Some(p) = custom {
        let trimmed = p.trim();
        if !trimmed.is_empty() && Path::new(trimmed).is_file() {
            return Some(trimmed.to_string());
        }
    }

    if Command::new("yt-dlp").arg("--version").output().is_ok() {
        return Some("yt-dlp".to_string());
    }

    if let Ok(local_appdata) = std::env::var("LOCALAPPDATA") {
        let direct = [
            format!("{local_appdata}\\Microsoft\\WinGet\\Links\\yt-dlp.exe"),
            format!("{local_appdata}\\Microsoft\\WindowsApps\\yt-dlp.exe"),
            "C:\\Program Files\\yt-dlp\\yt-dlp.exe".to_string(),
        ];
        for c in &direct {
            if Path::new(c).is_file() {
                return Some(c.clone());
            }
        }

        // Fallback: hunt inside %LOCALAPPDATA%\Microsoft\WinGet\Packages\yt-dlp*
        let packages = PathBuf::from(format!("{local_appdata}\\Microsoft\\WinGet\\Packages"));
        if let Ok(entries) = fs::read_dir(&packages) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if name.contains("yt-dlp") {
                    let exe = entry.path().join("yt-dlp.exe");
                    if exe.is_file() {
                        return Some(exe.to_string_lossy().to_string());
                    }
                }
            }
        }
    }

    None
}

const YTDLP_INSTALL_HINT: &str = "yt-dlp not found. Install with `winget install yt-dlp` and restart WeEdit, or use the Locate button to point WeEdit at yt-dlp.exe.";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct YtdlpSearchResult {
    id: String,
    title: String,
    duration: Option<f32>,
    uploader: Option<String>,
}

/// Search a YouTube channel via yt-dlp's flat-playlist extractor on the
/// `@handle/search?query=...` URL. Returns video metadata only — no downloads.
/// Used by the NCS audio integration.
#[tauri::command]
async fn ytdlp_search(
    custom_path: Option<String>,
    channel_handle: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<YtdlpSearchResult>, String> {
    run_blocking("ytdlp_search", move || {
        ytdlp_search_blocking(custom_path, channel_handle, query, limit)
    })
    .await
}

fn ytdlp_search_blocking(
    custom_path: Option<String>,
    channel_handle: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<YtdlpSearchResult>, String> {
    let bin = find_ytdlp(custom_path.as_deref()).ok_or_else(|| YTDLP_INSTALL_HINT.to_string())?;
    let n = limit.unwrap_or(20).clamp(1, 50);

    let search_url = format!(
        "https://www.youtube.com/@{}/search?query={}",
        channel_handle,
        url_encode(&query),
    );

    let n_str = n.to_string();
    let args: Vec<&str> = vec![
        "--flat-playlist",
        "--skip-download",
        "--quiet",
        "--no-warnings",
        "--playlist-end",
        &n_str,
        "--print",
        "%(id)s\t%(title)s\t%(duration)s\t%(uploader)s",
        &search_url,
    ];

    let output = Command::new(&bin)
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to run yt-dlp search: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("yt-dlp search failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let results: Vec<YtdlpSearchResult> = stdout
        .lines()
        .filter(|l| !l.is_empty())
        .filter_map(|line| {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts.len() < 2 {
                return None;
            }
            let id = parts[0].to_string();
            let title = parts[1].to_string();
            let duration = parts
                .get(2)
                .and_then(|s| {
                    if s.is_empty() || *s == "NA" {
                        None
                    } else {
                        s.parse::<f32>().ok()
                    }
                });
            let uploader = parts
                .get(3)
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty() && s != "NA");
            Some(YtdlpSearchResult {
                id,
                title,
                duration,
                uploader,
            })
        })
        .collect();

    Ok(results)
}

fn url_encode(s: &str) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => {
                write!(out, "%{:02X}", b).unwrap();
            }
        }
    }
    out
}

#[tauri::command]
async fn ytdlp_check(custom_path: Option<String>) -> Result<String, String> {
    run_blocking("ytdlp_check", move || {
        let bin = find_ytdlp(custom_path.as_deref()).ok_or_else(|| YTDLP_INSTALL_HINT.to_string())?;
        let output = Command::new(&bin)
            .arg("--version")
            .output()
            .map_err(|e| format!("Found yt-dlp at {bin} but couldn't run it: {e}"))?;
        if !output.status.success() {
            return Err(format!("yt-dlp at {bin} returned non-zero exit"));
        }
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok(format!("{version} ({bin})"))
    })
    .await
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadEvent {
    id: String,
    percent: Option<f32>,
    speed: Option<String>,
    eta: Option<String>,
    log: Option<String>,
}

#[tauri::command]
async fn ytdlp_download(
    app: tauri::AppHandle,
    custom_path: Option<String>,
    url: String,
    output_dir: String,
    download_id: String,
    audio_only: Option<bool>,
) -> Result<String, String> {
    run_blocking("ytdlp_download", move || {
        ytdlp_download_blocking(app, custom_path, url, output_dir, download_id, audio_only)
    })
    .await
}

fn ytdlp_download_blocking(
    app: tauri::AppHandle,
    custom_path: Option<String>,
    url: String,
    output_dir: String,
    download_id: String,
    audio_only: Option<bool>,
) -> Result<String, String> {
    let bin = find_ytdlp(custom_path.as_deref()).ok_or_else(|| YTDLP_INSTALL_HINT.to_string())?;

    fs::create_dir_all(&output_dir).map_err(|e| format!("mkdir failed: {e}"))?;

    // %(title)s gets sanitized by yt-dlp; %(id)s ensures uniqueness.
    let template = format!("{output_dir}/%(title)s [%(id)s].%(ext)s");

    // Audio-only mode picks the best audio-only stream without invoking ffmpeg
    // for format conversion, so it works on machines without ffmpeg on PATH.
    let mut args: Vec<&str> = vec![
        "--newline",         // progress on \n instead of \r so we can read line-by-line
        "--no-mtime",        // don't set file mtime from server
        "--no-part",         // write directly to .mp4, no .part rename dance
        "--print", "after_move:filepath",
        "-o", &template,
    ];
    if audio_only.unwrap_or(false) {
        args.push("-f");
        args.push("bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio");
    }
    args.push(&url);

    let mut child = Command::new(&bin)
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn yt-dlp at {bin}: {e}"))?;

    let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

    let id_out = download_id.clone();
    let app_out = app.clone();
    let stdout_thread = thread::spawn(move || -> Option<String> {
        let reader = BufReader::new(stdout);
        let mut filepath: Option<String> = None;
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => continue,
            };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }

            if let Some(prog) = parse_progress(line) {
                let _ = app_out.emit(
                    "ytdlp-progress",
                    DownloadEvent {
                        id: id_out.clone(),
                        percent: Some(prog.percent),
                        speed: Some(prog.speed),
                        eta: Some(prog.eta),
                        log: None,
                    },
                );
                continue;
            }

            // After-move filepath line (from --print after_move:filepath).
            if (line.contains('\\') || line.contains('/')) && Path::new(line).is_file() {
                filepath = Some(line.to_string());
            }

            // Emit non-progress lines as logs so the UI can show what's happening.
            let _ = app_out.emit(
                "ytdlp-progress",
                DownloadEvent {
                    id: id_out.clone(),
                    percent: None,
                    speed: None,
                    eta: None,
                    log: Some(line.to_string()),
                },
            );
        }
        filepath
    });

    let id_err = download_id.clone();
    let app_err = app.clone();
    let stderr_thread = thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines() {
            let Ok(line) = line else { continue };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let _ = app_err.emit(
                "ytdlp-progress",
                DownloadEvent {
                    id: id_err.clone(),
                    percent: None,
                    speed: None,
                    eta: None,
                    log: Some(line.to_string()),
                },
            );
        }
    });

    let status = child.wait().map_err(|e| format!("wait failed: {e}"))?;
    let filepath = stdout_thread
        .join()
        .map_err(|_| "stdout thread panicked".to_string())?;
    let _ = stderr_thread.join();

    if !status.success() {
        return Err(format!(
            "yt-dlp exited with status {}",
            status.code().unwrap_or(-1)
        ));
    }

    filepath.ok_or_else(|| "Could not determine downloaded file path".to_string())
}

struct ProgressLine {
    percent: f32,
    speed: String,
    eta: String,
}

/// Parses yt-dlp's `--newline` progress lines.
/// Example: `[download]   1.2% of    3.45GiB at  10.34MiB/s ETA 05:23`
fn parse_progress(line: &str) -> Option<ProgressLine> {
    let line = line.trim();
    if !line.starts_with("[download]") {
        return None;
    }
    let percent_pos = line.find('%')?;
    let before = &line[..percent_pos];
    let last_ws = before.rfind(char::is_whitespace)?;
    let percent: f32 = before[last_ws + 1..].parse().ok()?;

    let speed = line
        .find(" at ")
        .map(|i| {
            let rest = &line[i + 4..];
            if let Some(j) = rest.find(" ETA") {
                rest[..j].trim().to_string()
            } else {
                rest.split_whitespace()
                    .next()
                    .unwrap_or_default()
                    .to_string()
            }
        })
        .unwrap_or_default();

    let eta = line
        .find(" ETA ")
        .map(|i| line[i + 5..].trim().to_string())
        .unwrap_or_default();

    Some(ProgressLine {
        percent,
        speed,
        eta,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            read_project_file,
            write_project_file,
            ensure_dir,
            path_exists,
            list_directory,
            smb_authenticate,
            ytdlp_check,
            ytdlp_download,
            ytdlp_search,
            http_download,
            ffprobe_audio_streams,
            ffmpeg_extract_audio_tracks,
            ffmpeg_run,
            ffmpeg_cancel,
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
