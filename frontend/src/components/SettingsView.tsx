import React, { useEffect, useState } from 'react';
import {
  HardDrive,
  ShieldAlert,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Database,
  FolderSync,
  Lock,
  Save,
  Wifi,
  Clock,
  Cpu,
} from 'lucide-react';
import {
  AppSettings,
  ScannerStatus,
  fetchSettings,
  updateSettings,
  testSmbConnection,
  triggerLibraryScan,
  fetchScanStatus,
} from '../api';

interface SettingsViewProps {
  onSettingsUpdated: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ onSettingsUpdated }) => {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [loading, setLoading] = useState(true);

  const [smbPath, setSmbPath] = useState('');
  const [smbUsername, setSmbUsername] = useState('');
  const [smbPassword, setSmbPassword] = useState('');
  const [smbDomain, setSmbDomain] = useState('');
  const [showSpecialFolder, setShowSpecialFolder] = useState(false);
  const [autoScanHours, setAutoScanHours] = useState(0);
  const [networkProfile, setNetworkProfile] = useState<'vpn_high_latency' | 'local_lan'>(
    'vpn_high_latency'
  );
  const [cpuProfile, setCpuProfile] = useState<
    'auto' | 'low_power' | 'balanced' | 'high_performance'
  >('auto');

  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);

  const [testingConn, setTestingConn] = useState(false);
  const [connTestResult, setConnTestResult] = useState<{
    success: boolean;
    message: string;
    expected_db_path?: string;
  } | null>(null);

  const [scanner, setScanner] = useState<ScannerStatus | null>(null);

  const loadCurrentSettings = async () => {
    setLoading(true);
    try {
      const data = await fetchSettings();
      setSettings(data);
      setSmbPath(data.smb_path);
      setSmbUsername(data.smb_username || '');
      setSmbPassword(data.has_password ? '********' : '');
      setSmbDomain(data.smb_domain || '');
      setShowSpecialFolder(data.show_special_folder);
      setAutoScanHours(data.auto_scan_interval_hours || 0);
      setNetworkProfile(data.network_profile || 'vpn_high_latency');
      setCpuProfile(data.cpu_profile || 'auto');
      setScanner(data.scanner);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCurrentSettings();
  }, []);

  // Poll scanner status while a scan is active
  useEffect(() => {
    if (!scanner?.is_scanning) return;
    const timer = setInterval(async () => {
      try {
        const status = await fetchScanStatus();
        setScanner(status);
        if (!status.is_scanning) {
          await loadCurrentSettings();
          onSettingsUpdated();
        }
      } catch {
        // ignore transient error
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [scanner?.is_scanning]);

  const handleSaveSourceConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveFeedback(null);
    try {
      const updated = await updateSettings({
        smb_path: smbPath,
        smb_username: smbUsername,
        smb_password: smbPassword,
        smb_domain: smbDomain,
        show_special_folder: showSpecialFolder,
        auto_scan_interval_hours: autoScanHours,
        network_profile: networkProfile,
        cpu_profile: cpuProfile,
      });
      setSettings(updated);
      setSaveFeedback('Settings saved to SQLite database.');
      onSettingsUpdated();
    } catch (err: any) {
      setSaveFeedback(`Error saving settings: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleSpecialVisibility = async (checked: boolean) => {
    setShowSpecialFolder(checked);
    try {
      const updated = await updateSettings({
        show_special_folder: checked,
      });
      setSettings(updated);
      onSettingsUpdated();
    } catch {
      // revert on error
      setShowSpecialFolder(!checked);
    }
  };

  const handleTestConnection = async () => {
    setTestingConn(true);
    setConnTestResult(null);
    try {
      const res = await testSmbConnection({
        smb_path: smbPath,
        smb_username: smbUsername,
        smb_password: smbPassword === '********' ? '' : smbPassword,
        smb_domain: smbDomain,
      });
      setConnTestResult(res);
    } catch (err: any) {
      setConnTestResult({
        success: false,
        message: err.message || 'Connection test failed',
      });
    } finally {
      setTestingConn(false);
    }
  };

  const handleStartScan = async () => {
    try {
      const st = await triggerLibraryScan(false);
      setScanner({ ...st, is_scanning: true });
    } catch (err: any) {
      alert(err.message || 'Failed to start library scan');
    }
  };

  if (loading || !settings) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-16 text-center">
        <div className="inline-block w-8 h-8 border-4 border-red-600 border-t-transparent rounded-full animate-spin" />
        <p className="mt-3 text-sm text-zinc-400">Loading settings & SMB configuration...</p>
      </div>
    );
  }

  const scanProgressPercent =
    scanner && scanner.total_files_discovered > 0
      ? Math.min(
          100,
          Math.round((scanner.files_scanned / scanner.total_files_discovered) * 100)
        )
      : 0;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Settings & Library Scanner</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Configure your router-attached SMB share (`\\10.10.10.10\Videos`), manage portable SQLite
          storage inside <code className="text-zinc-200">.media_cache/media_library.db</code>, and
          control restricted folder visibility.
        </p>
      </div>

      {/* 1. Content Privacy & Restricted "special" Folder Visibility Control */}
      <section className="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="p-2.5 rounded-xl bg-amber-500/15 border border-amber-500/30 text-amber-400 shrink-0 mt-0.5">
              <ShieldAlert className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">
                Content Privacy & Restricted Folder Visibility
              </h2>
              <p className="mt-1 text-xs sm:text-sm text-zinc-400 max-w-2xl">
                Any subfolder named <code className="text-amber-300 font-mono">special</code>{' '}
                (case-insensitive, at Level 1 or nested inside Level 2+ categories) is indexed in
                the background with <code className="text-zinc-300 font-mono">is_special = 1</code>{' '}
                and hidden by default from navigation, search, "Continue Watching", and direct stream
                endpoints.
              </p>
            </div>
          </div>

          <label className="relative inline-flex items-center cursor-pointer select-none shrink-0">
            <input
              type="checkbox"
              checked={showSpecialFolder}
              onChange={(e) => handleToggleSpecialVisibility(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-12 h-6 bg-zinc-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-amber-500" />
          </label>
        </div>

        <div className="pt-3 border-t border-zinc-800/80 flex flex-wrap items-center justify-between gap-3 text-xs">
          <label className="inline-flex items-center gap-2 cursor-pointer text-zinc-200 font-medium">
            <input
              type="checkbox"
              checked={showSpecialFolder}
              onChange={(e) => handleToggleSpecialVisibility(e.target.checked)}
              className="rounded border-zinc-700 bg-zinc-800 text-red-600 focus:ring-red-500"
            />
            <span>Show 'Special' Folder Content</span>
          </label>

          <span
            className={`px-2.5 py-1 rounded-full font-semibold ${
              showSpecialFolder
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                : 'bg-zinc-800 text-zinc-400'
            }`}
          >
            {showSpecialFolder
              ? `Visible (${settings.special_indexed_videos} special videos unlocked)`
              : `Hidden (${settings.special_indexed_videos} special videos restricted)`}
          </span>
        </div>
      </section>

      {/* 2. Library Scanner & Sync Controls */}
      <section className="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-red-600/15 border border-red-500/30 text-red-400">
              <FolderSync className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Library Scanner & Sync Controls</h2>
              <p className="text-xs text-zinc-400">
                Scans directory tree, sanitizes titles, runs FFprobe, and saves 10% timestamp
                thumbnails to <code className="text-zinc-300">.media_cache/thumbnails/</code>.
              </p>
            </div>
          </div>

          <button
            onClick={handleStartScan}
            disabled={scanner?.is_scanning}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white text-sm font-semibold shadow-lg shadow-red-600/25 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${scanner?.is_scanning ? 'animate-spin' : ''}`} />
            <span>{scanner?.is_scanning ? 'Scanning Library...' : 'Scan & Sync Library'}</span>
          </button>
        </div>

        {/* Real-time Scan Progress Indicator */}
        {scanner && (
          <div className="bg-zinc-950/80 border border-zinc-800/80 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-zinc-200">
                {scanner.is_scanning
                  ? `Scanning: ${scanner.current_file || 'Discovering files...'}`
                  : 'Scanner Idle'}
              </span>
              <span className="text-zinc-400">
                {scanner.files_scanned} / {scanner.total_files_discovered} files processed
              </span>
            </div>

            <div className="w-full h-2 bg-zinc-800 rounded-full overflow-hidden">
              <div
                className="h-full bg-red-600 transition-all duration-300"
                style={{
                  width: `${scanner.is_scanning ? Math.max(5, scanProgressPercent) : 100}%`,
                }}
              />
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1 text-xs">
              <div className="bg-zinc-900/90 p-2.5 rounded-lg border border-zinc-800">
                <span className="text-zinc-500 block">Total Indexed</span>
                <span className="text-sm font-bold text-white">
                  {settings.total_indexed_videos}
                </span>
              </div>
              <div className="bg-zinc-900/90 p-2.5 rounded-lg border border-zinc-800">
                <span className="text-zinc-500 block">New Added (Last Scan)</span>
                <span className="text-sm font-bold text-emerald-400">
                  +{scanner.new_videos_added}
                </span>
              </div>
              <div className="bg-zinc-900/90 p-2.5 rounded-lg border border-zinc-800">
                <span className="text-zinc-500 block">Updated (Last Scan)</span>
                <span className="text-sm font-bold text-blue-400">{scanner.updated_videos}</span>
              </div>
              <div className="bg-zinc-900/90 p-2.5 rounded-lg border border-zinc-800">
                <span className="text-zinc-500 block">Pruned Missing</span>
                <span className="text-sm font-bold text-amber-400">
                  {scanner.missing_files_pruned}
                </span>
              </div>
            </div>

            {settings.last_scan_at && (
              <p className="text-[11px] text-zinc-500">
                Last completed scan: {settings.last_scan_at} UTC
              </p>
            )}
          </div>
        )}
      </section>

      {/* 3. SMB Source Configuration Form */}
      <form
        onSubmit={handleSaveSourceConfig}
        className="bg-zinc-900/80 border border-zinc-800 rounded-2xl p-6 space-y-5"
      >
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-blue-500/15 border border-blue-500/30 text-blue-400">
            <HardDrive className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-bold text-white">SMB Network Share Configuration</h2>
            <p className="text-xs text-zinc-400">
              Supports Windows UNC paths (<code className="text-zinc-300">\\10.10.10.10\Videos</code>
              ), mounted CIFS paths (<code className="text-zinc-300">/mnt/smb/videos</code>), or
              local directories.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="md:col-span-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">
              Master SMB Root Path (SMB_ROOT)
            </label>
            <input
              type="text"
              value={smbPath}
              onChange={(e) => setSmbPath(e.target.value)}
              placeholder="\\10.10.10.10\Videos or /mnt/smb/videos"
              className="w-full px-3.5 py-2 text-sm font-mono bg-zinc-950 border border-zinc-800 rounded-xl text-white focus:outline-none focus:border-red-500"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">
              SMB Username (Optional)
            </label>
            <input
              type="text"
              value={smbUsername}
              onChange={(e) => setSmbUsername(e.target.value)}
              placeholder="e.g., admin or guest"
              className="w-full px-3.5 py-2 text-sm bg-zinc-950 border border-zinc-800 rounded-xl text-white focus:outline-none focus:border-red-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">
              SMB Password (Optional)
            </label>
            <div className="relative">
              <Lock className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="password"
                value={smbPassword}
                onChange={(e) => setSmbPassword(e.target.value)}
                placeholder="Leave blank if anonymous share"
                className="w-full pl-9 pr-3.5 py-2 text-sm bg-zinc-950 border border-zinc-800 rounded-xl text-white focus:outline-none focus:border-red-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">
              Workgroup / Domain (Optional)
            </label>
            <input
              type="text"
              value={smbDomain}
              onChange={(e) => setSmbDomain(e.target.value)}
              placeholder="WORKGROUP"
              className="w-full px-3.5 py-2 text-sm bg-zinc-950 border border-zinc-800 rounded-xl text-white focus:outline-none focus:border-red-500"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">
              Automatic Background Periodic Scan
            </label>
            <div className="relative">
              <Clock className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <select
                value={autoScanHours}
                onChange={(e) => setAutoScanHours(Number(e.target.value))}
                className="w-full pl-9 pr-3.5 py-2 text-sm bg-zinc-950 border border-zinc-800 rounded-xl text-white focus:outline-none focus:border-red-500"
              >
                <option value={0}>Manual Scan Only (Disabled)</option>
                <option value={1}>Every 1 Hour</option>
                <option value={6}>Every 6 Hours (Recommended)</option>
                <option value={12}>Every 12 Hours</option>
                <option value={24}>Every 24 Hours</option>
              </select>
            </div>
          </div>

          <div className="md:col-span-2">
            <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-1.5">
              Network & Storage Optimization Profile
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label
                onClick={() => setNetworkProfile('vpn_high_latency')}
                className={`p-3.5 rounded-xl border cursor-pointer transition-all flex items-start gap-3 ${
                  networkProfile === 'vpn_high_latency'
                    ? 'bg-red-600/15 border-red-500/60 text-white'
                    : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700'
                }`}
              >
                <input
                  type="radio"
                  name="networkProfile"
                  checked={networkProfile === 'vpn_high_latency'}
                  onChange={() => setNetworkProfile('vpn_high_latency')}
                  className="mt-1 accent-red-600"
                />
                <div>
                  <span className="text-sm font-bold block text-zinc-100">
                    SMB over VPN (High Latency Tunnel)
                  </span>
                  <span className="text-xs text-zinc-400 mt-0.5 block">
                    Uses SQLite DELETE journal mode (prevents SMB lock corruption), 2 MB read-ahead
                    buffers, 1 MB SMB2 pipelined chunks, and 256 KB fast FFmpeg probe.
                  </span>
                </div>
              </label>

              <label
                onClick={() => setNetworkProfile('local_lan')}
                className={`p-3.5 rounded-xl border cursor-pointer transition-all flex items-start gap-3 ${
                  networkProfile === 'local_lan'
                    ? 'bg-red-600/15 border-red-500/60 text-white'
                    : 'bg-zinc-950 border-zinc-800 text-zinc-400 hover:border-zinc-700'
                }`}
              >
                <input
                  type="radio"
                  name="networkProfile"
                  checked={networkProfile === 'local_lan'}
                  onChange={() => setNetworkProfile('local_lan')}
                  className="mt-1 accent-red-600"
                />
                <div>
                  <span className="text-sm font-bold block text-zinc-100">
                    Local Disk / Direct Gigabit LAN
                  </span>
                  <span className="text-xs text-zinc-400 mt-0.5 block">
                    Uses SQLite WAL mode for fast local concurrency, 256 KB low-latency chunks,
                    0.5s micro-fragments, and full 2 MB FFmpeg stream probing.
                  </span>
                </div>
              </label>
            </div>
          </div>

          {/* CPU Multi-Core Transcoding Profile (Auto-Detected Hardware Cores) */}
          <div className="md:col-span-2 pt-2">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <label className="block text-xs font-semibold uppercase tracking-wider text-zinc-400">
                CPU Multi-Core Transcoding Profile
              </label>
              {settings.cpu_info && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
                  <Cpu className="w-3 h-3" />
                  {settings.cpu_info.description}
                </span>
              )}
            </div>
            <div className="relative">
              <Cpu className="w-4 h-4 text-zinc-500 absolute left-3 top-1/2 -translate-y-1/2" />
              <select
                value={cpuProfile}
                onChange={(e) =>
                  setCpuProfile(
                    e.target.value as 'auto' | 'low_power' | 'balanced' | 'high_performance'
                  )
                }
                className="w-full pl-9 pr-3.5 py-2.5 text-sm bg-zinc-950 border border-zinc-800 rounded-xl text-white focus:outline-none focus:border-red-500"
              >
                <option value="auto">
                  Auto-Detect Hardware ({settings.cpu_info?.logical_cores || 4} Logical Cores Detected)
                </option>
                <option value="low_power">
                  Eco / Low-Power Laptop (Intel i3 / Dual-Core — 2 Threads Max)
                </option>
                <option value="balanced">
                  Balanced Multi-Core (Intel i5 / Ryzen 5 — 50% Cores)
                </option>
                <option value="high_performance">
                  High Performance Parallel (Intel i7 / i9 / Ryzen 7 — Max Parallel Threads)
                </option>
              </select>
            </div>
            <p className="mt-1.5 text-[11px] text-zinc-500">
              Automatically scales FFmpeg parallel worker threads based on the host CPU (e.g., 2
              threads on dual-core i3 to prevent UI freeze, or 6+ threads on 8-thread i7 for faster
              Blu-ray transcoding).
            </p>
          </div>
        </div>

        {/* Portable Database & Cache Location Info */}
        <div className="bg-zinc-950/90 border border-zinc-800/80 rounded-xl p-4 space-y-2 text-xs">
          <div className="flex items-center gap-2 text-zinc-300 font-semibold">
            <Database className="w-4 h-4 text-red-400" />
            <span>Portable SQLite Database & Thumbnail Storage (Inside SMB Root)</span>
          </div>
          <p className="font-mono text-zinc-400 break-all">
            DB File: <span className="text-zinc-200">{settings.database_file_path}</span>
          </p>
          <p className="font-mono text-zinc-400 break-all">
            Thumbnails: <span className="text-zinc-200">{settings.thumbnails_dir_path}</span>
          </p>
        </div>

        {/* Connection Test Result Banner */}
        {connTestResult && (
          <div
            className={`p-4 rounded-xl border text-xs flex items-start gap-3 ${
              connTestResult.success
                ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-200'
                : 'bg-red-500/10 border-red-500/40 text-red-200'
            }`}
          >
            {connTestResult.success ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
            )}
            <div className="space-y-1">
              <p className="font-semibold">{connTestResult.message}</p>
              {connTestResult.expected_db_path && (
                <p className="font-mono opacity-80">
                  Target DB: {connTestResult.expected_db_path}
                </p>
              )}
            </div>
          </div>
        )}

        {saveFeedback && (
          <p className="text-xs font-medium text-emerald-400">{saveFeedback}</p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <button
            type="button"
            onClick={handleTestConnection}
            disabled={testingConn}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-sm font-medium transition-colors"
          >
            <Wifi className="w-4 h-4 text-blue-400" />
            <span>{testingConn ? 'Testing SMB Access...' : 'Test SMB Connection'}</span>
          </button>

          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-red-600 hover:bg-red-500 text-white text-sm font-semibold shadow-lg shadow-red-600/25 transition-colors"
          >
            <Save className="w-4 h-4" />
            <span>{saving ? 'Saving...' : 'Save Configuration'}</span>
          </button>
        </div>
      </form>
    </div>
  );
};
