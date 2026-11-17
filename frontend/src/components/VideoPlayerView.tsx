import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  SkipForward,
  SkipBack,
  Subtitles,
  Cpu,
  Folder,
  CheckCircle2,
  RotateCcw,
  Gauge,
  Activity,
} from 'lucide-react';
import {
  VideoItem,
  VideoDetails,
  fetchVideoDetails,
  fetchNetworkTelemetry,
  saveWatchProgress,
  formatClockTime,
  formatBytes,
} from '../api';

interface VideoPlayerViewProps {
  videoId: number;
  initialVideo?: VideoItem | null;
  onClose: () => void;
  onSelectVideo: (id: number) => void;
}

export const VideoPlayerView: React.FC<VideoPlayerViewProps> = ({
  videoId,
  initialVideo,
  onClose,
  onSelectVideo,
}) => {
  const [video, setVideo] = useState<VideoDetails | null>(() =>
    initialVideo
      ? {
          ...initialVideo,
          next_video: null,
          prev_video: null,
          folder_playlist: [initialVideo],
          subtitles: [],
        }
      : null
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(!initialVideo);
  const [isStreamStarting, setIsStreamStarting] = useState<boolean>(true);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [volume, setVolume] = useState<number>(1);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  // For transcoded/remuxed streams that use `?start=seconds` server-side seeking
  const [transcodeStartOffset, setTranscodeStartOffset] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [bufferedTime, setBufferedTime] = useState<number>(0);
  const [isBuffering, setIsBuffering] = useState<boolean>(false);
  const [duration, setDuration] = useState<number>(0);
  const [forceTranscode, setForceTranscode] = useState<boolean>(false);
  const [streamQuality, setStreamQuality] = useState<
    'auto' | 'original' | '1080p' | '720p' | '480p' | '360p'
  >(() => (localStorage.getItem('movietime_quality') as any) || 'auto');
  const [adaptiveTier, setAdaptiveTier] = useState<'original' | '1080p' | '720p' | '480p' | '360p'>('480p');
  const [isCheckingSpeed, setIsCheckingSpeed] = useState<boolean>(true);
  const [liveSpeedKbps, setLiveSpeedKbps] = useState<number>(0);
  const [probeSummary, setProbeSummary] = useState<string>('Checking SMB connection speed...');
  const stallCountRef = useRef<number>(0);

  // Seekbar hover thumbnail preview state
  const seekbarRef = useRef<HTMLDivElement | null>(null);
  const [hoverSeekTime, setHoverSeekTime] = useState<number | null>(null);
  const [hoverSeekX, setHoverSeekX] = useState<number>(0);
  const [debouncedSeekBucket, setDebouncedSeekBucket] = useState<number | null>(null);

  const resolvedQuality =
    streamQuality === 'auto' ? adaptiveTier : streamQuality;
  const [activeSubtitleUrl, setActiveSubtitleUrl] = useState<string>('off');
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);

  const isTranscodeStream =
    resolvedQuality !== 'original' ||
    forceTranscode ||
    (video ? video.stream_mode === 'transcode' : false);

  const effectiveCurrentTime = isTranscodeStream
    ? transcodeStartOffset + currentTime
    : currentTime;

  const effectiveBufferedTime = isTranscodeStream
    ? transcodeStartOffset + bufferedTime
    : bufferedTime;

  const effectiveDuration =
    duration > 0 && isFinite(duration)
      ? Math.max(duration, video?.duration_seconds || 0)
      : video?.duration_seconds || 0;

  useEffect(() => {
    let mounted = true;
    setError(null);
    setTranscodeStartOffset(0);
    setCurrentTime(0);
    setForceTranscode(false);
    setIsStreamStarting(true);
    setIsCheckingSpeed(true);
    setProbeSummary('Measuring SMB connection speed...');

    // Safety fallback: never wait more than 800ms on Step 1/2 (Checking SMB Connection Speed)
    // so the <video> stream ALWAYS starts immediately even if the VPN has a momentary latency spike!
    const maxWaitTimer = setTimeout(() => {
      if (mounted) {
        setIsCheckingSpeed(false);
      }
    }, 800);

    if (initialVideo && initialVideo.id === videoId) {
      setVideo((prev) =>
        prev && prev.id === videoId
          ? prev
          : {
              ...initialVideo,
              next_video: null,
              prev_video: null,
              folder_playlist: [initialVideo],
              subtitles: [],
            }
      );
      setLoading(false);
    } else {
      setLoading(true);
    }

    fetchVideoDetails(videoId)
      .then((data) => {
        if (!mounted) return;
        setVideo(data);
        setDuration(data.duration_seconds || 0);
        if (data.subtitles && data.subtitles.length > 0) {
          setActiveSubtitleUrl(data.subtitles[0].url);
        } else {
          setActiveSubtitleUrl('off');
        }

        // 1. Inspect pre-flight SMB Connection Speed Probe & choose best quality tier BEFORE starting stream!
        const probe = data.connection_probe;
        const chosenTier = probe?.recommended_quality || (data.stream_mode === 'direct' ? 'original' : '480p');
        if (probe) {
          setLiveSpeedKbps(probe.speed_kbps);
          setAdaptiveTier(chosenTier);
          setProbeSummary(
            `Speed: ${probe.speed_kbps} KB/s (${probe.speed_mbps} Mbps) → Auto-selected ${chosenTier.toUpperCase()}`
          );
        }
        setIsCheckingSpeed(false);

        const activeQual = streamQuality === 'auto' ? chosenTier : streamQuality;
        // Resume from saved position if > 5s and not completed
        if (data.progress_seconds > 5 && !data.is_completed && currentTime < 2) {
          if (data.stream_mode === 'transcode' || activeQual !== 'original') {
            setTranscodeStartOffset(Math.floor(data.progress_seconds));
          } else {
            setCurrentTime(data.progress_seconds);
          }
        }
      })
      .catch((err: any) => {
        if (!mounted) return;
        setIsCheckingSpeed(false);
        setError(err.message || 'Unable to load video');
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    // If duration_seconds was 0 on initial card click, poll once after 2.5s to pick up
    // the background-probed exact movie length so the seekbar end time updates automatically!
    const durTimer = setTimeout(() => {
      fetchVideoDetails(videoId)
        .then((refreshed) => {
          if (mounted && refreshed.duration_seconds > 0) {
            setDuration((prev) => (prev > 0 ? prev : refreshed.duration_seconds));
            setVideo((prev) =>
              prev ? { ...prev, duration_seconds: refreshed.duration_seconds } : prev
            );
          }
        })
        .catch(() => {});
    }, 2500);

    return () => {
      mounted = false;
      clearTimeout(durTimer);
      clearTimeout(maxWaitTimer);
    };
  }, [videoId]);

  // Debounce seekbar hover bucket (every 30s interval) so scrubbing is smooth
  useEffect(() => {
    if (hoverSeekTime === null) {
      setDebouncedSeekBucket(null);
      return;
    }
    const bucket = Math.max(0, Math.round(hoverSeekTime / 30) * 30);
    const t = setTimeout(() => {
      setDebouncedSeekBucket(bucket);
    }, 120);
    return () => clearTimeout(t);
  }, [hoverSeekTime]);

  // Poll live SMB / stream transfer speed every 2 seconds while player is open
  useEffect(() => {
    const speedTimer = setInterval(() => {
      fetchNetworkTelemetry()
        .then((tel) => {
          if (tel.speed_kbps > 0) {
            setLiveSpeedKbps(tel.speed_kbps);
          }
        })
        .catch(() => {});
    }, 2000);
    return () => clearInterval(speedTimer);
  }, []);

  // Smart Adaptive Bitrate (ABR) & Continuous Buffer Monitor:
  // - If in 'auto' mode and playback stalls (buffer runs dry), automatically steps down
  //   quality (`1080p` -> `720p` -> `480p` -> `360p`) so playback continues smoothly without freezing.
  // - If read-ahead buffer builds up > 25 seconds ahead on a good connection, automatically
  //   upgrades back up (`360p` -> `480p` -> `720p`).
  useEffect(() => {
    if (streamQuality !== 'auto' || !video) return;
    const bufferCheck = setInterval(() => {
      const el = videoRef.current;
      if (!el || el.paused) return;
      const ahead = bufferedTime - el.currentTime;
      if (ahead > 25 && (adaptiveTier === '360p' || adaptiveTier === '480p')) {
        const nextUp = adaptiveTier === '360p' ? '480p' : '720p';
        const pos = Math.floor(effectiveCurrentTime);
        setTranscodeStartOffset(pos);
        setCurrentTime(0);
        setBufferedTime(0);
        setAdaptiveTier(nextUp);
        stallCountRef.current = 0;
      }
    }, 8000);
    return () => clearInterval(bufferCheck);
  }, [streamQuality, adaptiveTier, bufferedTime, effectiveCurrentTime, video]);

  // Apply initial direct-play seek once metadata loads
  const handleLoadedMetadata = () => {
    setIsStreamStarting(false);
    setIsBuffering(false);
    const el = videoRef.current;
    if (!el || !video) return;
    if (!isTranscodeStream && video.progress_seconds > 5 && !video.is_completed && el.currentTime < 2) {
      el.currentTime = video.progress_seconds;
    }
    if (el.duration && isFinite(el.duration) && el.duration > 0) {
      setDuration(el.duration);
    }
    el.play().catch(() => {});
  };

  // Auto-save watch progress every 10 seconds to SQLite
  useEffect(() => {
    if (!video) return;
    const interval = setInterval(() => {
      const el = videoRef.current;
      if (!el || el.paused) return;
      const pos = isTranscodeStream
        ? transcodeStartOffset + el.currentTime
        : el.currentTime;
      if (pos > 2) {
        saveWatchProgress(video.id, pos)
          .then(() => {
            setLastSavedAt(new Date().toLocaleTimeString());
          })
          .catch(() => {});
      }
    }, 10000);

    return () => clearInterval(interval);
  }, [video, isTranscodeStream, transcodeStartOffset]);

  // Keyboard shortcuts: Space (play/pause), Left/Right (seek 10s), F (fullscreen), M (mute)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        seekRelative(10);
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        seekRelative(-10);
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        toggleFullscreen();
      } else if (e.key.toLowerCase() === 'm') {
        e.preventDefault();
        toggleMute();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  const togglePlay = () => {
    const el = videoRef.current;
    if (!el) return;
    if (el.paused) {
      el.play().catch(() => {});
    } else {
      el.pause();
    }
  };

  const toggleMute = () => {
    const el = videoRef.current;
    if (!el) return;
    el.muted = !el.muted;
    setIsMuted(el.muted);
  };

  const handleVolumeChange = (val: number) => {
    const el = videoRef.current;
    if (!el) return;
    el.volume = val;
    el.muted = val === 0;
    setVolume(val);
    setIsMuted(val === 0);
  };

  const toggleFullscreen = () => {
    const container = containerRef.current;
    if (!container) return;
    if (!document.fullscreenElement) {
      container.requestFullscreen?.().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen?.().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  const seekToAbsolute = (targetSeconds: number) => {
    const clamped = Math.max(0, Math.min(targetSeconds, effectiveDuration || targetSeconds));
    const el = videoRef.current;
    if (!isTranscodeStream && el) {
      el.currentTime = clamped;
      setCurrentTime(clamped);
    } else {
      // Server-side FFmpeg time-based seek (`?start=seconds`)
      setTranscodeStartOffset(Math.floor(clamped));
      setCurrentTime(0);
    }
    if (video) {
      saveWatchProgress(video.id, clamped).catch(() => {});
    }
  };

  const seekRelative = (deltaSeconds: number) => {
    seekToAbsolute(effectiveCurrentTime + deltaSeconds);
  };

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 py-16 text-center">
        <div className="inline-block w-10 h-10 border-4 border-red-600 border-t-transparent rounded-full animate-spin" />
        <p className="mt-4 text-zinc-400">Preparing media stream...</p>
      </div>
    );
  }

  if (error || !video) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-16">
        <div className="bg-zinc-900 border border-red-500/40 rounded-2xl p-8 text-center">
          <p className="text-lg font-semibold text-red-400 mb-2">Playback Unavailable</p>
          <p className="text-sm text-zinc-300 mb-6">{error || 'Video not found'}</p>
          <button
            onClick={onClose}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white text-sm font-medium"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Library
          </button>
        </div>
      </div>
    );
  }

  const streamUrl = `/api/stream/${video.id}?start=${
    isTranscodeStream ? transcodeStartOffset : 0
  }&quality=${resolvedQuality}${forceTranscode ? '&mode=transcode' : ''}`;

  const handleQualityChange = (
    newQuality: 'auto' | 'original' | '1080p' | '720p' | '480p' | '360p'
  ) => {
    localStorage.setItem('movietime_quality', newQuality);
    setTranscodeStartOffset(Math.floor(effectiveCurrentTime));
    setCurrentTime(0);
    setBufferedTime(0);
    setIsBuffering(true);
    if (newQuality === 'auto') {
      setAdaptiveTier('720p');
      stallCountRef.current = 0;
    }
    setStreamQuality(newQuality);
  };

  const playProgressPct =
    effectiveDuration > 0
      ? Math.min(100, (effectiveCurrentTime / effectiveDuration) * 100)
      : 0;
  const bufferProgressPct =
    effectiveDuration > 0
      ? Math.min(100, (effectiveBufferedTime / effectiveDuration) * 100)
      : 0;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-6">
      {/* Top Action Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <button
          onClick={() => {
            if (effectiveCurrentTime > 2) {
              saveWatchProgress(video.id, effectiveCurrentTime).catch(() => {});
            }
            onClose();
          }}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-200 hover:text-white text-sm font-medium transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Back to Browse</span>
        </button>

        {/* Next / Previous Episode in Folder Controls */}
        <div className="flex items-center gap-2.5">
          {video.prev_video && (
            <button
              onClick={() => onSelectVideo(video.prev_video!.id)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-xs sm:text-sm font-medium text-zinc-200 hover:text-white transition-colors"
            >
              <SkipBack className="w-4 h-4" />
              <span className="hidden sm:inline">Previous:</span>
              <span className="max-w-[140px] truncate">{video.prev_video.clean_title}</span>
            </button>
          )}
          {video.next_video && (
            <button
              onClick={() => onSelectVideo(video.next_video!.id)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-xs sm:text-sm font-semibold text-white shadow-lg shadow-red-600/25 transition-colors"
            >
              <span>Next in Folder:</span>
              <span className="max-w-[160px] truncate">{video.next_video.clean_title}</span>
              <SkipForward className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Theater Video Player Container */}
      <div
        ref={containerRef}
        className="relative bg-black rounded-2xl overflow-hidden border border-zinc-800 shadow-2xl group"
      >
        {isCheckingSpeed ? (
          <div className="w-full aspect-video max-h-[76vh] bg-black mx-auto flex items-center justify-center">
            <img
              src={video.thumbnail_url}
              alt={video.clean_title}
              className="w-full h-full object-cover opacity-35"
            />
          </div>
        ) : (
          <video
            ref={videoRef}
            key={streamUrl}
            src={streamUrl}
            poster={video.thumbnail_url}
            preload="auto"
            className="w-full aspect-video max-h-[76vh] bg-black mx-auto"
            playsInline
            onClick={togglePlay}
            onPlay={() => {
              setIsPlaying(true);
              setIsBuffering(false);
              setIsStreamStarting(false);
            }}
            onPlaying={() => {
              setIsBuffering(false);
              setIsStreamStarting(false);
            }}
            onWaiting={() => {
              setIsBuffering(true);
              if (streamQuality === 'auto') {
                stallCountRef.current += 1;
                if (stallCountRef.current >= 1 && adaptiveTier !== '360p') {
                  const nextDown =
                    adaptiveTier === 'original' || adaptiveTier === '1080p'
                      ? '720p'
                      : adaptiveTier === '720p'
                      ? '480p'
                      : '360p';
                  const pos = Math.floor(effectiveCurrentTime);
                  setTranscodeStartOffset(pos);
                  setCurrentTime(0);
                  setBufferedTime(0);
                  setAdaptiveTier(nextDown);
                }
              }
            }}
            onCanPlay={() => {
              setIsBuffering(false);
              setIsStreamStarting(false);
            }}
            onPause={() => setIsPlaying(false)}
            onLoadedMetadata={handleLoadedMetadata}
            onProgress={(e) => {
              const el = e.target as HTMLVideoElement;
              if (el.buffered && el.buffered.length > 0) {
                setBufferedTime(el.buffered.end(el.buffered.length - 1));
              }
            }}
            onTimeUpdate={(e) => {
              const el = e.target as HTMLVideoElement;
              setCurrentTime(el.currentTime);
              if (el.buffered && el.buffered.length > 0) {
                setBufferedTime(el.buffered.end(el.buffered.length - 1));
              }
            }}
            onEnded={() => {
              saveWatchProgress(video.id, effectiveDuration, true).catch(() => {});
              if (video.next_video) {
                onSelectVideo(video.next_video.id);
              }
            }}
            crossOrigin="anonymous"
          >
            {activeSubtitleUrl !== 'off' && (
              <track
                kind="subtitles"
                src={activeSubtitleUrl}
                srcLang="en"
                label="Subtitles"
                default
              />
            )}
          </video>
        )}

        {/* Buffering / Preparing Stream Spinner Overlay Inside the Video Player */}
        {(isBuffering || isStreamStarting || isCheckingSpeed) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 pointer-events-none">
            <div className="w-12 h-12 border-4 border-red-600 border-t-transparent rounded-full animate-spin" />
            <div className="mt-3 px-4 py-2 rounded-xl bg-black/90 text-xs font-medium text-zinc-200 border border-zinc-800 text-center space-y-1 shadow-xl">
              <p className="font-bold text-white">
                {isCheckingSpeed
                  ? 'Step 1/2: Checking SMB Connection Speed...'
                  : isStreamStarting
                  ? `Step 2/2: Buffering ${resolvedQuality.toUpperCase()} Stream...`
                  : `Buffering ${resolvedQuality.toUpperCase()} Stream...`}
              </p>
              <p className="text-[11px] text-emerald-400 font-mono">
                {probeSummary}
                {liveSpeedKbps > 0 ? ` • Live: ${liveSpeedKbps} KB/s` : ''}
              </p>
            </div>
          </div>
        )}

        {/* Custom Theater Controls Overlay */}
        <div className="bg-gradient-to-t from-black/95 via-black/75 to-transparent px-4 pt-6 pb-4 space-y-3">
          {/* Timeline Scrubber with Visual Read-Ahead Buffer Bar & Hover Thumbnail Preview */}
          <div className="flex items-center gap-3">
            <span className="text-xs font-mono text-zinc-300 w-16 text-right">
              {formatClockTime(effectiveCurrentTime)}
            </span>
            <div
              ref={seekbarRef}
              onMouseMove={(e) => {
                if (!seekbarRef.current || effectiveDuration <= 0) return;
                const rect = seekbarRef.current.getBoundingClientRect();
                const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                setHoverSeekX(e.clientX - rect.left);
                setHoverSeekTime(ratio * effectiveDuration);
              }}
              onMouseLeave={() => {
                setHoverSeekTime(null);
              }}
              className="relative flex-1 flex items-center h-5 group/seek"
            >
              {/* Floating Hover Thumbnail Preview Tooltip */}
              {hoverSeekTime !== null && effectiveDuration > 0 && (
                <div
                  style={{
                    left: `${Math.max(76, Math.min((seekbarRef.current?.clientWidth || 300) - 76, hoverSeekX))}px`,
                  }}
                  className="absolute bottom-7 -translate-x-1/2 z-30 pointer-events-none flex flex-col items-center"
                >
                  <div className="w-36 aspect-video rounded-lg overflow-hidden bg-zinc-950 border-2 border-red-500/80 shadow-2xl">
                    {debouncedSeekBucket !== null && (
                      <img
                        src={`/api/seek-thumb/${video.id}?t=${debouncedSeekBucket}`}
                        alt="Seek preview"
                        className="w-full h-full object-cover"
                      />
                    )}
                  </div>
                  <span className="mt-1 px-2 py-0.5 rounded bg-black/90 border border-zinc-700 text-[11px] font-mono font-bold text-white shadow">
                    {formatClockTime(hoverSeekTime)}
                  </span>
                </div>
              )}

              <div className="w-full h-1.5 group-hover/seek:h-2.5 bg-zinc-800 rounded-full overflow-hidden relative transition-all">
                {/* Buffered read-ahead bar */}
                <div
                  className="absolute top-0 left-0 bottom-0 bg-emerald-400/50 transition-all duration-300"
                  style={{ width: `${bufferProgressPct}%` }}
                />
                {/* Played bar */}
                <div
                  className="absolute top-0 left-0 bottom-0 bg-red-600"
                  style={{ width: `${playProgressPct}%` }}
                />
              </div>
              <input
                type="range"
                min={0}
                max={Math.max(1, Math.floor(effectiveDuration))}
                value={Math.floor(effectiveCurrentTime)}
                onChange={(e) => seekToAbsolute(Number(e.target.value))}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
              />
            </div>
            <span className="text-xs font-mono text-zinc-300 w-16">
              {effectiveDuration > 0 ? formatClockTime(effectiveDuration) : '--:--'}
            </span>
          </div>

          {/* Primary Controls Bar */}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <button
                onClick={togglePlay}
                className="p-2 rounded-lg bg-red-600 hover:bg-red-500 text-white transition-colors"
                title="Play / Pause (Space)"
              >
                {isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}
              </button>

              <button
                onClick={() => seekRelative(-10)}
                className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-xs font-medium text-zinc-200 border border-zinc-800"
                title="Rewind 10s (Left Arrow)"
              >
                -10s
              </button>

              <button
                onClick={() => seekRelative(10)}
                className="px-2.5 py-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-xs font-medium text-zinc-200 border border-zinc-800"
                title="Forward 10s (Right Arrow)"
              >
                +10s
              </button>

              <button
                onClick={() => seekToAbsolute(0)}
                className="p-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800"
                title="Restart from beginning"
              >
                <RotateCcw className="w-4 h-4" />
              </button>

              {/* Volume */}
              <div className="flex items-center gap-2 pl-2">
                <button
                  onClick={toggleMute}
                  className="text-zinc-300 hover:text-white"
                  title="Mute (M)"
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className="w-5 h-5 text-red-400" />
                  ) : (
                    <Volume2 className="w-5 h-5" />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={isMuted ? 0 : volume}
                  onChange={(e) => handleVolumeChange(Number(e.target.value))}
                  className="w-20 h-1 bg-zinc-700 rounded-lg appearance-none cursor-pointer accent-red-600 hidden sm:block"
                />
              </div>
            </div>

            {/* Right Controls: Live Speed Meter, Stream Mode, Subtitles, Fullscreen */}
            <div className="flex flex-wrap items-center gap-2">
              {/* Live Connection Speed Badge */}
              <div
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-mono text-emerald-400"
                title="Current SMB / Stream Transfer Speed"
              >
                <Activity className="w-3.5 h-3.5 animate-pulse" />
                <span>
                  {liveSpeedKbps >= 1024
                    ? `${(liveSpeedKbps / 1024).toFixed(2)} MB/s`
                    : `${liveSpeedKbps} KB/s`}
                </span>
              </div>

              {/* Subtitle Selector */}
              {video.subtitles && video.subtitles.length > 0 && (
                <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1">
                  <Subtitles className="w-4 h-4 text-zinc-400" />
                  <select
                    value={activeSubtitleUrl}
                    onChange={(e) => setActiveSubtitleUrl(e.target.value)}
                    className="bg-transparent text-xs text-zinc-200 focus:outline-none"
                  >
                    <option value="off" className="bg-zinc-900">
                      Subtitles: Off
                    </option>
                    {video.subtitles.map((sub) => (
                      <option key={sub.url} value={sub.url} className="bg-zinc-900">
                        {sub.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Stream Quality Selector (Downscales & caps bitrate for Blu-ray / Remux over SMB/VPN) */}
              <div
                className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-800 rounded-lg px-2.5 py-1.5"
                title="Select Streaming Quality & Bitrate Buffer"
              >
                <Gauge className="w-4 h-4 text-red-400" />
                <select
                  value={streamQuality}
                  onChange={(e) =>
                    handleQualityChange(
                      e.target.value as 'auto' | 'original' | '1080p' | '720p' | '480p' | '360p'
                    )
                  }
                  className="bg-transparent text-xs font-semibold text-zinc-200 focus:outline-none cursor-pointer"
                >
                  <option value="auto" className="bg-zinc-900">
                    Quality: Auto Adaptive ({adaptiveTier.toUpperCase()})
                  </option>
                  <option value="original" className="bg-zinc-900">
                    Quality: Original (Zero-CPU Copy)
                  </option>
                  <option value="1080p" className="bg-zinc-900">
                    Quality: 1080p (6 Mbps)
                  </option>
                  <option value="720p" className="bg-zinc-900">
                    Quality: 720p (2.5 Mbps)
                  </option>
                  <option value="480p" className="bg-zinc-900">
                    Quality: 480p Smooth (1 Mbps)
                  </option>
                  <option value="360p" className="bg-zinc-900">
                    Quality: 360p Turbo (600 Kbps)
                  </option>
                </select>
              </div>

              {/* Direct Play vs FFmpeg Transcode Badge */}
              <button
                onClick={() => {
                  setTranscodeStartOffset(Math.floor(effectiveCurrentTime));
                  setCurrentTime(0);
                  setForceTranscode(!forceTranscode);
                }}
                className={`hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                  isTranscodeStream
                    ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                    : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                }`}
                title="Switch between HTTP 206 Direct Play and On-the-Fly FFmpeg Remux/Transcode"
              >
                <Cpu className="w-3.5 h-3.5" />
                <span>
                  {isTranscodeStream ? 'FFmpeg Buffered' : 'Direct Play'}
                </span>
              </button>

              <button
                onClick={toggleFullscreen}
                className="p-2 rounded-lg bg-zinc-900 hover:bg-zinc-800 text-zinc-200 border border-zinc-800"
                title="Fullscreen (F)"
              >
                {isFullscreen ? (
                  <Minimize className="w-4 h-4" />
                ) : (
                  <Maximize className="w-4 h-4" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Metadata & Folder Playlist Panel */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-zinc-900/70 border border-zinc-800/80 rounded-2xl p-6 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-red-400">
                <span>{video.segment_display}</span>
                <span>•</span>
                <span>{video.category_display}</span>
              </div>
              <h1 className="mt-1 text-2xl font-bold text-white">{video.clean_title}</h1>
              <p className="mt-1 text-xs font-mono text-zinc-400 break-all">
                SMB Path: {video.file_path}
              </p>
            </div>

            {lastSavedAt && (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs bg-zinc-800 text-zinc-300">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                Progress saved ({lastSavedAt})
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-zinc-800">
            <div className="bg-zinc-950/70 p-3 rounded-xl border border-zinc-800/70">
              <span className="text-[11px] uppercase text-zinc-500 font-semibold">
                Resolution
              </span>
              <p className="text-sm font-bold text-zinc-100 mt-0.5">{video.resolution}</p>
            </div>
            <div className="bg-zinc-950/70 p-3 rounded-xl border border-zinc-800/70">
              <span className="text-[11px] uppercase text-zinc-500 font-semibold">
                Video / Audio Codec
              </span>
              <p className="text-sm font-bold text-zinc-100 mt-0.5 uppercase">
                {video.video_codec} / {video.audio_codec}
              </p>
            </div>
            <div className="bg-zinc-950/70 p-3 rounded-xl border border-zinc-800/70">
              <span className="text-[11px] uppercase text-zinc-500 font-semibold">
                Container Format
              </span>
              <p className="text-sm font-bold text-zinc-100 mt-0.5 uppercase">
                {video.extension}
              </p>
            </div>
            <div className="bg-zinc-950/70 p-3 rounded-xl border border-zinc-800/70">
              <span className="text-[11px] uppercase text-zinc-500 font-semibold">
                File Size
              </span>
              <p className="text-sm font-bold text-zinc-100 mt-0.5">
                {formatBytes(video.file_size_bytes)}
              </p>
            </div>
          </div>

          <div className="text-xs text-zinc-400 flex flex-wrap items-center gap-4 pt-2">
            <span>Shortcuts:</span>
            <kbd className="px-2 py-0.5 bg-zinc-800 rounded text-zinc-200">Space</kbd> Play/Pause
            <kbd className="px-2 py-0.5 bg-zinc-800 rounded text-zinc-200">← / →</kbd> Seek 10s
            <kbd className="px-2 py-0.5 bg-zinc-800 rounded text-zinc-200">F</kbd> Fullscreen
            <kbd className="px-2 py-0.5 bg-zinc-800 rounded text-zinc-200">M</kbd> Mute
          </div>
        </div>

        {/* Folder / Series Binge Playlist */}
        <div className="bg-zinc-900/70 border border-zinc-800/80 rounded-2xl p-5 flex flex-col max-h-[360px]">
          <div className="flex items-center justify-between pb-3 border-b border-zinc-800">
            <div className="flex items-center gap-2">
              <Folder className="w-4 h-4 text-red-500" />
              <h2 className="text-sm font-bold text-white">
                In This Folder ({video.folder_playlist.length})
              </h2>
            </div>
            <span className="text-xs text-zinc-400 truncate max-w-[140px]">
              {video.category_display}
            </span>
          </div>

          <div className="mt-3 space-y-2 overflow-y-auto pr-1 flex-1">
            {video.folder_playlist.map((item, idx) => {
              const isCurrent = item.id === video.id;
              return (
                <button
                  key={item.id}
                  onClick={() => {
                    if (!isCurrent) onSelectVideo(item.id);
                  }}
                  className={`w-full text-left p-2.5 rounded-xl border transition-all flex items-center gap-3 ${
                    isCurrent
                      ? 'bg-red-600/15 border-red-500/50 text-white'
                      : 'bg-zinc-950/60 border-zinc-800/60 text-zinc-300 hover:bg-zinc-800/60 hover:text-white'
                  }`}
                >
                  <span
                    className={`w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center shrink-0 ${
                      isCurrent ? 'bg-red-600 text-white' : 'bg-zinc-800 text-zinc-400'
                    }`}
                  >
                    {idx + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold truncate">{item.clean_title}</p>
                    <p className="text-[11px] text-zinc-500">
                      {item.extension.toUpperCase()} • {item.resolution}
                    </p>
                  </div>
                  {item.is_completed && (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
