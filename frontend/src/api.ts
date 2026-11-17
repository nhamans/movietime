export interface VideoItem {
  id: number;
  file_path: string;
  raw_filename: string;
  clean_title: string;
  segment: string;
  segment_display: string;
  category: string;
  category_display: string;
  is_special: boolean;
  extension: string;
  duration_seconds: number;
  resolution: string;
  video_codec: string;
  audio_codec: string;
  thumbnail_path: string | null;
  thumbnail_url: string;
  file_size_bytes: number;
  created_at: string;
  progress_seconds: number;
  is_completed: boolean;
  last_watched_at: string | null;
  stream_mode: 'direct' | 'transcode';
}

export interface SubtitleTrack {
  label: string;
  filename: string;
  url: string;
}

export interface ConnectionProbe {
  speed_kbps: number;
  speed_mbps: number;
  source_bitrate_kbps: number;
  source_bitrate_mbps: number;
  recommended_quality: 'original' | '1080p' | '720p' | '480p' | '360p';
  probe_ms: number;
}

export interface NetworkTelemetry {
  speed_kbps: number;
  speed_mbps: number;
  is_streaming: boolean;
  active_mode: string;
  active_quality: string;
}

export interface VideoDetails extends VideoItem {
  next_video: VideoItem | null;
  prev_video: VideoItem | null;
  folder_playlist: VideoItem[];
  subtitles: SubtitleTrack[];
  connection_probe?: ConnectionProbe;
}

export interface SegmentItem {
  id: string;
  name: string;
  count: number;
  is_special: boolean;
}

export interface CategoryItem {
  id: string;
  name: string;
  count: number;
}

export interface NavigationData {
  show_special_folder: boolean;
  segments: SegmentItem[];
  categories_by_segment: Record<string, CategoryItem[]>;
  all_categories: CategoryItem[];
  extensions: string[];
  resolutions: string[];
}

export interface ScannerStatus {
  is_scanning: boolean;
  files_scanned: number;
  total_files_discovered: number;
  new_videos_added: number;
  updated_videos: number;
  missing_files_pruned: number;
  current_file: string;
  last_error: string | null;
  last_scan_completed_at: string | null;
}

export interface CpuInfo {
  logical_cores: number;
  cpu_profile: 'auto' | 'low_power' | 'balanced' | 'high_performance';
  ffmpeg_threads: number;
  description: string;
}

export interface AppSettings {
  smb_path: string;
  smb_username: string;
  has_password: boolean;
  smb_domain: string;
  show_special_folder: boolean;
  auto_scan_interval_hours: number;
  network_profile: 'vpn_high_latency' | 'local_lan';
  cpu_profile: 'auto' | 'low_power' | 'balanced' | 'high_performance';
  cpu_info?: CpuInfo;
  last_scan_at: string | null;
  resolved_smb_root: string;
  database_file_path: string;
  thumbnails_dir_path: string;
  smb_connected: boolean;
  connection_message: string;
  ffmpeg_installed: boolean;
  ffprobe_installed: boolean;
  total_indexed_videos: number;
  special_indexed_videos: number;
  scanner: ScannerStatus;
}

const API_BASE = '';

export async function fetchNavigation(): Promise<NavigationData> {
  const res = await fetch(`${API_BASE}/api/navigation`);
  if (!res.ok) throw new Error('Failed to load navigation');
  return res.json();
}

export async function fetchVideos(params: {
  segment?: string;
  category?: string;
  search?: string;
  extension?: string;
  resolution?: string;
  sort_by?: string;
}): Promise<{ total: number; show_special_folder: boolean; videos: VideoItem[] }> {
  const qs = new URLSearchParams();
  if (params.segment && params.segment !== 'all') qs.set('segment', params.segment);
  if (params.category && params.category !== 'all') qs.set('category', params.category);
  if (params.search?.trim()) qs.set('search', params.search.trim());
  if (params.extension && params.extension !== 'all') qs.set('extension', params.extension);
  if (params.resolution && params.resolution !== 'all') qs.set('resolution', params.resolution);
  if (params.sort_by) qs.set('sort_by', params.sort_by);

  const res = await fetch(`${API_BASE}/api/videos?${qs.toString()}`);
  if (!res.ok) throw new Error('Failed to load videos');
  return res.json();
}

export async function fetchContinueWatching(): Promise<{ videos: VideoItem[] }> {
  const res = await fetch(`${API_BASE}/api/continue-watching`);
  if (!res.ok) throw new Error('Failed to load continue watching');
  return res.json();
}

export async function fetchVideoDetails(videoId: number): Promise<VideoDetails> {
  const res = await fetch(`${API_BASE}/api/videos/${videoId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: 'Failed to load video' }));
    throw new Error(err.detail || 'Failed to load video');
  }
  return res.json();
}

export async function saveWatchProgress(
  videoId: number,
  progressSeconds: number,
  isCompleted?: boolean
): Promise<void> {
  await fetch(`${API_BASE}/api/watch-history/${videoId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      progress_seconds: progressSeconds,
      is_completed: isCompleted,
    }),
  });
}

export async function fetchSettings(): Promise<AppSettings> {
  const res = await fetch(`${API_BASE}/api/settings`);
  if (!res.ok) throw new Error('Failed to load settings');
  return res.json();
}

export async function updateSettings(payload: {
  smb_path?: string;
  smb_username?: string;
  smb_password?: string;
  smb_domain?: string;
  show_special_folder?: boolean;
  auto_scan_interval_hours?: number;
  network_profile?: 'vpn_high_latency' | 'local_lan';
  cpu_profile?: 'auto' | 'low_power' | 'balanced' | 'high_performance';
}): Promise<AppSettings> {
  const res = await fetch(`${API_BASE}/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to update settings');
  return res.json();
}

export async function testSmbConnection(payload: {
  smb_path: string;
  smb_username?: string;
  smb_password?: string;
  smb_domain?: string;
}): Promise<{
  success: boolean;
  message: string;
  resolved_root: string;
  expected_db_path: string;
}> {
  const res = await fetch(`${API_BASE}/api/settings/test-connection`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Connection test request failed');
  return res.json();
}

export async function triggerLibraryScan(wait = false): Promise<ScannerStatus> {
  const res = await fetch(`${API_BASE}/api/scan?wait=${wait}`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error('Failed to trigger library scan');
  const data = await res.json();
  return data.scanner || data;
}

export async function fetchScanStatus(): Promise<ScannerStatus> {
  const res = await fetch(`${API_BASE}/api/scan/status`);
  if (!res.ok) throw new Error('Failed to fetch scan status');
  return res.json();
}

export async function fetchNetworkTelemetry(): Promise<NetworkTelemetry> {
  const res = await fetch(`${API_BASE}/api/network/telemetry`);
  if (!res.ok) throw new Error('Failed to fetch network telemetry');
  return res.json();
}

export function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return '0:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}h ${mins}m`;
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function formatClockTime(seconds: number): string {
  if (!seconds || seconds < 0) return '00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 2 : 0)} ${units[i]}`;
}
