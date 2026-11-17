import React, { useEffect, useState } from 'react';
import {
  Filter,
  SlidersHorizontal,
  PlayCircle,
  Film,
  FolderOpen,
  RotateCcw,
} from 'lucide-react';
import {
  NavigationData,
  VideoItem,
  fetchNavigation,
  fetchVideos,
  fetchContinueWatching,
  triggerLibraryScan,
  fetchScanStatus,
} from './api';
import { Navbar } from './components/Navbar';
import { VideoCard } from './components/VideoCard';
import { VideoPlayerView } from './components/VideoPlayerView';
import { SettingsView } from './components/SettingsView';

export function App() {
  const [currentView, setCurrentView] = useState<'home' | 'settings' | 'player'>('home');
  const [selectedVideoId, setSelectedVideoId] = useState<number | null>(null);
  const [selectedVideoInitial, setSelectedVideoInitial] = useState<VideoItem | null>(null);

  const [navData, setNavData] = useState<NavigationData>({
    show_special_folder: false,
    segments: [],
    categories_by_segment: {},
    all_categories: [],
    extensions: [],
    resolutions: [],
  });

  // Multi-faceted filter states
  const [activeSegment, setActiveSegment] = useState<string>('all');
  const [activeCategory, setActiveCategory] = useState<string>('all');
  const [activeExtension, setActiveExtension] = useState<string>('all');
  const [activeResolution, setActiveResolution] = useState<string>('all');
  const [sortBy, setSortBy] = useState<string>('recent');
  const [searchQuery, setSearchQuery] = useState<string>('');

  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [continueWatching, setContinueWatching] = useState<VideoItem[]>([]);
  const [loadingVideos, setLoadingVideos] = useState<boolean>(true);
  const [isScanning, setIsScanning] = useState<boolean>(false);

  const loadNavigationAndContinueWatching = async () => {
    try {
      const [nav, cw] = await Promise.all([
        fetchNavigation(),
        fetchContinueWatching(),
      ]);
      setNavData(nav);
      setContinueWatching(cw.videos);
    } catch {
      // handled gracefully
    }
  };

  const loadVideosList = async () => {
    setLoadingVideos(true);
    try {
      const res = await fetchVideos({
        segment: activeSegment,
        category: activeCategory,
        search: searchQuery,
        extension: activeExtension,
        resolution: activeResolution,
        sort_by: sortBy,
      });
      setVideos(res.videos);
    } catch {
      setVideos([]);
    } finally {
      setLoadingVideos(false);
    }
  };

  useEffect(() => {
    loadNavigationAndContinueWatching();
  }, []);

  useEffect(() => {
    loadVideosList();
  }, [
    activeSegment,
    activeCategory,
    activeExtension,
    activeResolution,
    sortBy,
    searchQuery,
  ]);

  const handleSegmentSelect = (seg: string) => {
    setActiveSegment(seg);
    setActiveCategory('all');
  };

  const handlePlayVideo = (videoId: number) => {
    const found =
      videos.find((v) => v.id === videoId) ||
      continueWatching.find((v) => v.id === videoId) ||
      null;
    setSelectedVideoInitial(found);
    setSelectedVideoId(videoId);
    setCurrentView('player');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleQuickScan = async () => {
    setIsScanning(true);
    try {
      await triggerLibraryScan(false);
      const poll = setInterval(async () => {
        const st = await fetchScanStatus();
        if (!st.is_scanning) {
          clearInterval(poll);
          setIsScanning(false);
          await loadNavigationAndContinueWatching();
          await loadVideosList();
        }
      }, 1000);
    } catch {
      setIsScanning(false);
    }
  };

  const availableCategories =
    activeSegment === 'all'
      ? navData.all_categories
      : navData.categories_by_segment[activeSegment] || [];

  const hasActiveFilters =
    activeSegment !== 'all' ||
    activeCategory !== 'all' ||
    activeExtension !== 'all' ||
    activeResolution !== 'all' ||
    searchQuery.trim() !== '' ||
    sortBy !== 'recent';

  const resetFilters = () => {
    setActiveSegment('all');
    setActiveCategory('all');
    setActiveExtension('all');
    setActiveResolution('all');
    setSortBy('recent');
    setSearchQuery('');
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <Navbar
        segments={navData.segments}
        activeSegment={activeSegment}
        onSelectSegment={handleSegmentSelect}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        showSpecialFolder={navData.show_special_folder}
        currentView={currentView}
        onNavigateView={(view) => {
          setCurrentView(view);
          if (view === 'home') {
            loadNavigationAndContinueWatching();
            loadVideosList();
          }
        }}
        isScanning={isScanning}
        onQuickScan={handleQuickScan}
      />

      <main className="flex-1">
        {currentView === 'player' && selectedVideoId !== null ? (
          <VideoPlayerView
            videoId={selectedVideoId}
            initialVideo={selectedVideoInitial}
            onClose={() => {
              setCurrentView('home');
              loadNavigationAndContinueWatching();
              loadVideosList();
            }}
            onSelectVideo={(id) => handlePlayVideo(id)}
          />
        ) : currentView === 'settings' ? (
          <SettingsView
            onSettingsUpdated={async () => {
              await loadNavigationAndContinueWatching();
              await loadVideosList();
            }}
          />
        ) : (
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-8">
            {/* Continue Watching Row (only shown when not actively filtering by search) */}
            {continueWatching.length > 0 && !searchQuery.trim() && activeSegment === 'all' && (
              <section className="space-y-3">
                <div className="flex items-center gap-2">
                  <PlayCircle className="w-5 h-5 text-red-500" />
                  <h2 className="text-lg font-bold text-white tracking-tight">
                    Continue Watching
                  </h2>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
                  {continueWatching.slice(0, 4).map((video) => (
                    <VideoCard
                      key={`cw-${video.id}`}
                      video={video}
                      onPlay={handlePlayVideo}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Multi-Faceted Filter Bar */}
            <section className="bg-zinc-900/75 border border-zinc-800/80 rounded-2xl p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  <Filter className="w-4 h-4 text-red-500" />
                  <span>Filter & Sort Library</span>
                  <span className="ml-1 px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-200">
                    {videos.length} {videos.length === 1 ? 'Video' : 'Videos'}
                  </span>
                </div>

                {hasActiveFilters && (
                  <button
                    onClick={resetFilters}
                    className="inline-flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 font-medium"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Reset Filters
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                {/* 1. Segment Filter (Level 1 Folder) */}
                <div>
                  <label className="block text-[11px] text-zinc-400 font-medium mb-1">
                    Segment (Level 1 Folder)
                  </label>
                  <select
                    value={activeSegment}
                    onChange={(e) => handleSegmentSelect(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-200 focus:outline-none focus:border-red-500"
                  >
                    <option value="all">All Segments</option>
                    {navData.segments.map((seg) => (
                      <option key={seg.id} value={seg.id}>
                        {seg.name} ({seg.count})
                      </option>
                    ))}
                  </select>
                </div>

                {/* 2. Category / Series Filter (Level 2+ Subfolders) */}
                <div>
                  <label className="block text-[11px] text-zinc-400 font-medium mb-1">
                    Category / Series (Level 2+)
                  </label>
                  <select
                    value={activeCategory}
                    onChange={(e) => setActiveCategory(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-200 focus:outline-none focus:border-red-500"
                  >
                    <option value="all">All Categories</option>
                    {availableCategories.map((cat) => (
                      <option key={cat.id} value={cat.id}>
                        {cat.name} ({cat.count})
                      </option>
                    ))}
                  </select>
                </div>

                {/* 3. File Format Filter */}
                <div>
                  <label className="block text-[11px] text-zinc-400 font-medium mb-1">
                    Container Format
                  </label>
                  <select
                    value={activeExtension}
                    onChange={(e) => setActiveExtension(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-200 focus:outline-none focus:border-red-500"
                  >
                    <option value="all">All Formats (.mkv, .mp4...)</option>
                    {navData.extensions.map((ext) => (
                      <option key={ext} value={ext}>
                        {ext.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </div>

                {/* 4. Resolution Filter */}
                <div>
                  <label className="block text-[11px] text-zinc-400 font-medium mb-1">
                    Resolution
                  </label>
                  <select
                    value={activeResolution}
                    onChange={(e) => setActiveResolution(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-200 focus:outline-none focus:border-red-500"
                  >
                    <option value="all">All Resolutions</option>
                    {navData.resolutions.map((res) => (
                      <option key={res} value={res}>
                        {res}
                      </option>
                    ))}
                  </select>
                </div>

                {/* 5. Sort Order */}
                <div>
                  <label className="block text-[11px] text-zinc-400 font-medium mb-1">
                    <span className="inline-flex items-center gap-1">
                      <SlidersHorizontal className="w-3 h-3" /> Sort By
                    </span>
                  </label>
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-zinc-950 border border-zinc-800 rounded-xl text-zinc-200 focus:outline-none focus:border-red-500"
                  >
                    <option value="recent">Recently Added</option>
                    <option value="alpha">Alphabetical (A–Z)</option>
                    <option value="duration">Duration (Longest First)</option>
                  </select>
                </div>
              </div>
            </section>

            {/* Main Video Library Grid */}
            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Film className="w-5 h-5 text-red-500" />
                  <h2 className="text-lg font-bold text-white tracking-tight">
                    {activeSegment === 'all'
                      ? 'All Media'
                      : navData.segments.find((s) => s.id === activeSegment)?.name ||
                        activeSegment}
                    {activeCategory !== 'all' && ` — ${activeCategory}`}
                  </h2>
                </div>
              </div>

              {loadingVideos ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
                  {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                    <div
                      key={n}
                      className="aspect-video rounded-xl bg-zinc-900/70 border border-zinc-800 animate-pulse"
                    />
                  ))}
                </div>
              ) : videos.length === 0 ? (
                <div className="bg-zinc-900/50 border border-zinc-800/80 rounded-2xl p-12 text-center space-y-3">
                  <FolderOpen className="w-10 h-10 text-zinc-500 mx-auto" />
                  <h3 className="text-base font-semibold text-zinc-200">
                    No matching videos found
                  </h3>
                  <p className="text-xs text-zinc-400 max-w-md mx-auto">
                    Try adjusting your filters or search query, or visit Settings to configure your
                    SMB root path (`\\10.10.10.10\Videos`) and scan the library.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5">
                  {videos.map((video) => (
                    <VideoCard key={video.id} video={video} onPlay={handlePlayVideo} />
                  ))}
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
export default App;
