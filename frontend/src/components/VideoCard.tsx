import React, { useEffect, useState } from 'react';
import { Play, Clock, Folder, ShieldAlert, CheckCircle2 } from 'lucide-react';
import { VideoItem, formatDuration } from '../api';

interface VideoCardProps {
  video: VideoItem;
  onPlay: (videoId: number) => void;
}

const TOTAL_PREVIEW_FRAMES = 6;

export const VideoCard: React.FC<VideoCardProps> = ({ video, onPlay }) => {
  const [isHovered, setIsHovered] = useState(false);
  const [previewFrame, setPreviewFrame] = useState<number>(0); // 0 = main poster, 1..6 = sequence frames

  const progressPercent =
    video.duration_seconds > 0 && video.progress_seconds > 0
      ? Math.min(100, Math.round((video.progress_seconds / video.duration_seconds) * 100))
      : 0;

  useEffect(() => {
    if (!isHovered) {
      setPreviewFrame(0);
      return;
    }

    // Start on frame 1 after a 350ms intentional hover delay so moving the mouse across
    // the screen never triggers unnecessary background requests on a low-spec laptop
    const startTimer = setTimeout(() => {
      setPreviewFrame(1);
    }, 350);

    const cycleInterval = setInterval(() => {
      setPreviewFrame((prev) => (prev >= TOTAL_PREVIEW_FRAMES ? 1 : prev + 1));
    }, 850);

    return () => {
      clearTimeout(startTimer);
      clearInterval(cycleInterval);
    };
  }, [isHovered, video.id]);

  const activeImageSrc =
    isHovered && previewFrame >= 1
      ? `/api/previews/${video.id}?frame=${previewFrame}`
      : video.thumbnail_url;

  return (
    <div
      onClick={() => onPlay(video.id)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="group relative flex flex-col bg-zinc-900/80 border border-zinc-800/80 rounded-xl overflow-hidden cursor-pointer transition-all duration-200 hover:scale-[1.02] hover:border-red-500/60 hover:shadow-xl hover:shadow-red-950/20"
    >
      {/* Poster / Hover Sequence Thumbnail Container */}
      <div className="relative aspect-video w-full bg-zinc-950 overflow-hidden">
        <img
          src={activeImageSrc}
          alt={video.clean_title}
          loading="lazy"
          className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
          onError={(e) => {
            (e.target as HTMLImageElement).src = video.thumbnail_url;
          }}
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent opacity-80 group-hover:opacity-55 transition-opacity" />

        {/* Hover Sequence Frame Progress Dots / Bar (Top Edge) */}
        {isHovered && previewFrame >= 1 && (
          <div className="absolute top-0 left-0 right-0 z-20 flex gap-1 px-2 pt-1.5 pointer-events-none">
            {Array.from({ length: TOTAL_PREVIEW_FRAMES }, (_, idx) => {
              const step = idx + 1;
              const isActive = step <= previewFrame;
              return (
                <div
                  key={step}
                  className={`h-1 flex-1 rounded-full transition-colors duration-200 ${
                    isActive ? 'bg-red-500 shadow-sm shadow-red-500/50' : 'bg-white/25'
                  }`}
                />
              );
            })}
          </div>
        )}

        {/* Top Badges */}
        <div className="absolute top-3 left-2.5 right-2.5 flex items-center justify-between gap-1.5 pointer-events-none">
          <span className="px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider rounded bg-black/75 text-zinc-200 border border-zinc-700/70 backdrop-blur-sm">
            {video.segment_display}
          </span>

          <div className="flex items-center gap-1.5">
            {video.is_special && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wider rounded bg-amber-500/90 text-black">
                <ShieldAlert className="w-3 h-3" />
                Special
              </span>
            )}
            <span
              className={`px-2 py-0.5 text-[11px] font-bold uppercase rounded backdrop-blur-sm ${
                video.resolution === '4K'
                  ? 'bg-red-600/90 text-white'
                  : 'bg-zinc-900/85 text-zinc-200 border border-zinc-700'
              }`}
            >
              {video.resolution}
            </span>
          </div>
        </div>

        {/* Center Play Overlay Button */}
        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
          <div className="w-11 h-11 rounded-full bg-red-600/90 text-white flex items-center justify-center shadow-lg shadow-red-600/40 transform scale-90 group-hover:scale-100 transition-transform">
            <Play className="w-5 h-5 fill-current ml-0.5" />
          </div>
        </div>

        {/* Bottom Duration & Codec Badges */}
        <div className="absolute bottom-2.5 left-2.5 right-2.5 flex items-center justify-between text-xs text-zinc-300 pointer-events-none">
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/70 text-[11px] font-medium">
            {isHovered && previewFrame >= 1
              ? `Preview ${previewFrame}/${TOTAL_PREVIEW_FRAMES}`
              : `${video.extension.replace('.', '').toUpperCase()} • ${
                  video.stream_mode === 'direct' ? 'Direct Play' : 'FFmpeg Stream'
                }`}
          </span>
          {video.duration_seconds > 0 && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/75 text-[11px] font-medium">
              <Clock className="w-3 h-3 text-zinc-400" />
              {formatDuration(video.duration_seconds)}
            </span>
          )}
        </div>

        {/* Watch Progress Bar */}
        {progressPercent > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-800">
            <div
              className="h-full bg-red-600 transition-all"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        )}
      </div>

      {/* Card Footer Info */}
      <div className="p-3.5 flex-1 flex flex-col justify-between gap-2">
        <div>
          <h3
            title={video.clean_title}
            className="text-sm font-semibold text-zinc-100 group-hover:text-red-400 transition-colors line-clamp-1"
          >
            {video.clean_title}
          </h3>
          <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-400 line-clamp-1">
            <Folder className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
            <span className="truncate">{video.category_display}</span>
          </div>
        </div>

        {video.progress_seconds > 5 && !video.is_completed && (
          <div className="flex items-center justify-between text-[11px] text-red-400 font-medium pt-1 border-t border-zinc-800/80">
            <span>Resume at {formatDuration(video.progress_seconds)}</span>
            <span>{progressPercent}%</span>
          </div>
        )}
        {video.is_completed && (
          <div className="flex items-center gap-1 text-[11px] text-emerald-400 font-medium pt-1 border-t border-zinc-800/80">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>Watched</span>
          </div>
        )}
      </div>
    </div>
  );
};
