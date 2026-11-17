import React from 'react';
import {
  Film,
  Search,
  Settings,
  ShieldAlert,
  RefreshCw,
  HardDrive,
} from 'lucide-react';
import { SegmentItem } from '../api';

interface NavbarProps {
  segments: SegmentItem[];
  activeSegment: string;
  onSelectSegment: (seg: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  showSpecialFolder: boolean;
  currentView: 'home' | 'settings' | 'player';
  onNavigateView: (view: 'home' | 'settings') => void;
  isScanning: boolean;
  onQuickScan: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({
  segments,
  activeSegment,
  onSelectSegment,
  searchQuery,
  onSearchChange,
  showSpecialFolder,
  currentView,
  onNavigateView,
  isScanning,
  onQuickScan,
}) => {
  return (
    <header className="sticky top-0 z-40 bg-zinc-950/90 backdrop-blur-md border-b border-zinc-800/80">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex flex-wrap items-center justify-between gap-4 py-3.5">
          {/* Brand Logo */}
          <div className="flex items-center gap-6">
            <button
              onClick={() => {
                onNavigateView('home');
                onSelectSegment('all');
              }}
              className="flex items-center gap-2.5 text-left group"
            >
              <img
                src="/logo.svg"
                alt="MovieTime Logo"
                className="w-9 h-9 rounded-lg shadow-md shadow-red-600/30 group-hover:scale-105 transition-transform"
              />
              <div>
                <span className="text-lg font-extrabold tracking-tight text-white">
                  MOVIE<span className="text-red-500">TIME</span>
                </span>
                <span className="hidden sm:inline-flex items-center gap-1 ml-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-zinc-800 text-zinc-400 rounded">
                  <HardDrive className="w-2.5 h-2.5" /> SMB Stream
                </span>
              </div>
            </button>

            {/* Dynamic Top-Level Navigation Segments (Level 1 Subfolders) */}
            <nav className="hidden md:flex items-center gap-1.5 overflow-x-auto py-1">
              <button
                onClick={() => {
                  onNavigateView('home');
                  onSelectSegment('all');
                }}
                className={`px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  currentView === 'home' && activeSegment === 'all'
                    ? 'bg-red-600 text-white shadow-sm shadow-red-600/40'
                    : 'text-zinc-300 hover:text-white hover:bg-zinc-800/70'
                }`}
              >
                All
              </button>

              {segments.map((seg) => {
                const isActive = currentView === 'home' && activeSegment === seg.id;
                return (
                  <button
                    key={seg.id}
                    onClick={() => {
                      onNavigateView('home');
                      onSelectSegment(seg.id);
                    }}
                    className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-red-600 text-white shadow-sm shadow-red-600/40'
                        : 'text-zinc-300 hover:text-white hover:bg-zinc-800/70'
                    }`}
                  >
                    {seg.is_special && (
                      <ShieldAlert className="w-3.5 h-3.5 text-amber-400" />
                    )}
                    <span>{seg.name}</span>
                    <span
                      className={`text-xs px-1.5 py-0.2 rounded-full ${
                        isActive ? 'bg-red-800 text-white' : 'bg-zinc-800 text-zinc-400'
                      }`}
                    >
                      {seg.count}
                    </span>
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Search & Actions */}
          <div className="flex items-center gap-3 flex-1 sm:flex-initial justify-end">
            {showSpecialFolder && (
              <span
                title="'Special' folder visibility is currently enabled in Settings"
                className="hidden lg:inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30"
              >
                <ShieldAlert className="w-3.5 h-3.5" />
                Special Visible
              </span>
            )}

            {/* Instant Search Input */}
            <div className="relative flex-1 sm:w-64 md:w-72">
              <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  if (currentView !== 'home') onNavigateView('home');
                  onSearchChange(e.target.value);
                }}
                placeholder="Search title, filename, folder..."
                className="w-full pl-9 pr-8 py-1.5 text-sm bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-red-500 focus:ring-1 focus:ring-red-500"
              />
              {searchQuery && (
                <button
                  onClick={() => onSearchChange('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-zinc-400 hover:text-white"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Quick Rescan Button */}
            <button
              onClick={onQuickScan}
              disabled={isScanning}
              title="Scan & Sync SMB Library"
              className="p-2 rounded-lg bg-zinc-900 border border-zinc-800 text-zinc-300 hover:text-white hover:border-zinc-700 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${isScanning ? 'animate-spin text-red-400' : ''}`} />
            </button>

            {/* Settings Route Button */}
            <button
              onClick={() =>
                onNavigateView(currentView === 'settings' ? 'home' : 'settings')
              }
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                currentView === 'settings'
                  ? 'bg-red-600 text-white border-red-500'
                  : 'bg-zinc-900 text-zinc-200 border-zinc-800 hover:border-zinc-700 hover:text-white'
              }`}
            >
              <Settings className="w-4 h-4" />
              <span className="hidden sm:inline">Settings</span>
            </button>
          </div>
        </div>

        {/* Mobile Segment Navigation Bar */}
        <div className="flex md:hidden items-center gap-1.5 overflow-x-auto pb-3 pt-1">
          <button
            onClick={() => {
              onNavigateView('home');
              onSelectSegment('all');
            }}
            className={`px-3 py-1 rounded-lg text-xs font-medium shrink-0 ${
              currentView === 'home' && activeSegment === 'all'
                ? 'bg-red-600 text-white'
                : 'bg-zinc-900 text-zinc-300'
            }`}
          >
            All
          </button>
          {segments.map((seg) => (
            <button
              key={seg.id}
              onClick={() => {
                onNavigateView('home');
                onSelectSegment(seg.id);
              }}
              className={`inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-medium shrink-0 ${
                currentView === 'home' && activeSegment === seg.id
                  ? 'bg-red-600 text-white'
                  : 'bg-zinc-900 text-zinc-300'
              }`}
            >
              {seg.is_special && <ShieldAlert className="w-3 h-3 text-amber-400" />}
              <span>{seg.name}</span>
              <span className="opacity-70">({seg.count})</span>
            </button>
          ))}
        </div>
      </div>
    </header>
  );
};
