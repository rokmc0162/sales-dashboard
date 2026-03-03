import { useState, useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  LayoutDashboard,
  BookOpen,
  Globe,
  Calendar,
  TrendingUp,
  Database,
  Layers,
  ChevronLeft,
  ChevronRight,
  X,
  Upload,
} from 'lucide-react';
import { useAppState } from '@/hooks/useAppState';
import { hasUploadedData } from '@/hooks/useDataLoader';
import { DataUploader } from '@/components/DataUploader';
import { t } from '@/i18n';
import { cn } from '@/lib/utils';

const navItems = [
  { path: '/summary', labelKey: 'nav.summary', icon: LayoutDashboard },
  { path: '/titles', labelKey: 'nav.titles', icon: BookOpen },
  { path: '/platforms', labelKey: 'nav.platforms', icon: Globe },
  { path: '/period', labelKey: 'nav.period', icon: Calendar },
  { path: '/structure', labelKey: 'nav.structure', icon: Layers },
  { path: '/trends', labelKey: 'nav.trends', icon: TrendingUp },
  { path: '/data', labelKey: 'nav.rawData', icon: Database },
];

function RiverseLogo({ expanded }: { expanded: boolean }) {
  return (
    <div className="flex items-center gap-2.5 overflow-hidden">
      {/* Riverse logo - always visible */}
      <img
        src="/riverse_logo.png"
        alt="RIVERSE"
        className="h-7 w-auto object-contain shrink-0"
      />
      {/* System title - only when expanded */}
      <AnimatePresence>
        {expanded && (
          <motion.span
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: 'auto' }}
            exit={{ opacity: 0, width: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="text-[18px] font-bold tracking-tight text-primary whitespace-nowrap overflow-hidden"
          >
            매출 현황 보드
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

function TogglePill({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: string }[];
  value: string;
  onChange: (val: string) => void;
}) {
  return (
    <div className="flex rounded-lg overflow-hidden relative bg-muted p-0.5">
      {options.map((opt) => {
        const isActive = value === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={cn(
              'relative z-10 px-3 py-1 text-xs font-semibold cursor-pointer border-none rounded-md transition-all duration-200',
              isActive
                ? 'bg-primary text-white'
                : 'text-muted-foreground hover:text-text-secondary bg-transparent'
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function Sidebar({ mobileOpen, onMobileClose }: { mobileOpen?: boolean; onMobileClose?: () => void }) {
  const [expanded, setExpanded] = useState(true);
  const [uploaderOpen, setUploaderOpen] = useState(false);
  const { language, setLanguage, currency, setCurrency } = useAppState();
  const location = useLocation();

  // Close mobile sidebar when navigating
  useEffect(() => {
    if (mobileOpen && onMobileClose) {
      onMobileClose();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const desktopSidebar = (
    <motion.aside
      animate={{ width: expanded ? 260 : 72 }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="flex flex-col h-screen shrink-0 relative bg-card border-r border-border shadow-[1px_0_4px_rgba(0,0,0,0.03)]"
    >
      {/* Logo Area */}
      <div className="flex items-center justify-between h-[72px] px-4 shrink-0 border-b border-border/50">
        <RiverseLogo expanded={expanded} />
      </div>

      {/* Collapse Toggle Button */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="absolute top-[78px] -right-3 z-20 flex items-center justify-center w-6 h-6 rounded-full border border-border cursor-pointer transition-all duration-200 hover:scale-110 bg-card text-text-muted shadow-sm"
      >
        {expanded ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
      </button>

      {/* Navigation */}
      <nav className="flex-1 py-4 overflow-y-auto px-3">
        <ul className="list-none m-0 p-0 flex flex-col gap-1">
          {navItems.map((item, index) => {
            const Icon = item.icon;
            const isActive = location.pathname === item.path;

            return (
              <motion.li
                key={item.path}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{
                  delay: index * 0.05,
                  duration: 0.3,
                  ease: [0.22, 1, 0.36, 1],
                }}
              >
                <NavLink
                  to={item.path}
                  className={cn(
                    'flex items-center gap-3 py-2.5 rounded-lg text-sm no-underline transition-all duration-200 relative group',
                    expanded ? 'px-3' : 'px-0 justify-center',
                    isActive
                      ? 'font-semibold bg-primary text-white'
                      : 'font-medium text-text-secondary hover:bg-muted'
                  )}
                >
                  {/* Active left accent bar */}
                  {isActive && (
                    <motion.div
                      layoutId="sidebar-active-indicator"
                      className="absolute left-0 top-1 bottom-1 w-[3px] rounded-full bg-accent"
                      transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                    />
                  )}
                  <span className="shrink-0 flex items-center justify-center w-5 h-5">
                    <Icon size={20} strokeWidth={isActive ? 2.2 : 1.8} />
                  </span>
                  <AnimatePresence>
                    {expanded && (
                      <motion.span
                        initial={{ opacity: 0, width: 0 }}
                        animate={{ opacity: 1, width: 'auto' }}
                        exit={{ opacity: 0, width: 0 }}
                        transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                        className="truncate whitespace-nowrap overflow-hidden"
                      >
                        {t(language, item.labelKey)}
                      </motion.span>
                    )}
                  </AnimatePresence>
                </NavLink>
              </motion.li>
            );
          })}
        </ul>
      </nav>

      {/* Bottom Controls */}
      <div className="shrink-0 px-3 py-4 flex flex-col gap-3 border-t border-border/50">
        {/* Upload Button */}
        <button
          onClick={() => setUploaderOpen(true)}
          className={cn(
            'flex items-center gap-2.5 w-full rounded-lg text-sm font-medium transition-colors duration-200 border-none cursor-pointer',
            expanded ? 'px-3 py-2.5 justify-start' : 'px-0 py-2.5 justify-center',
            hasUploadedData()
              ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
              : 'bg-transparent text-text-secondary hover:bg-muted',
          )}
        >
          <Upload size={18} strokeWidth={1.8} className="shrink-0" />
          <AnimatePresence>
            {expanded && (
              <motion.span
                initial={{ opacity: 0, width: 0 }}
                animate={{ opacity: 1, width: 'auto' }}
                exit={{ opacity: 0, width: 0 }}
                transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                className="truncate whitespace-nowrap overflow-hidden"
              >
                {t(language, 'upload.button')}
              </motion.span>
            )}
          </AnimatePresence>
          {hasUploadedData() && (
            <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0 ml-auto" />
          )}
        </button>

        {/* Language Toggle */}
        <div className={cn('flex items-center', expanded ? 'justify-between' : 'justify-center')}>
          <AnimatePresence>
            {expanded && (
              <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-xs font-medium uppercase tracking-wider text-text-muted"
              >
                Lang
              </motion.span>
            )}
          </AnimatePresence>
          <TogglePill
            options={[
              { label: 'KO', value: 'ko' },
              { label: 'JA', value: 'ja' },
            ]}
            value={language}
            onChange={(val) => setLanguage(val as 'ko' | 'ja')}
          />
        </div>

        {/* Currency Toggle */}
        <div className={cn('flex items-center', expanded ? 'justify-between' : 'justify-center')}>
          <AnimatePresence>
            {expanded && (
              <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-xs font-medium uppercase tracking-wider text-text-muted"
              >
                Currency
              </motion.span>
            )}
          </AnimatePresence>
          <TogglePill
            options={[
              { label: 'JPY', value: 'JPY' },
              { label: 'KRW', value: 'KRW' },
            ]}
            value={currency}
            onChange={(val) => setCurrency(val as 'JPY' | 'KRW')}
          />
        </div>
      </div>
    </motion.aside>
  );

  return (
    <>
      {/* Desktop sidebar - hidden on mobile */}
      <div className="hidden md:block">
        {desktopSidebar}
      </div>

      {/* Upload modal */}
      <DataUploader open={uploaderOpen} onClose={() => setUploaderOpen(false)} />

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={onMobileClose} />
          <div className="relative z-10 h-full" style={{ width: 260 }}>
            <motion.aside
              initial={{ x: -260 }}
              animate={{ x: 0 }}
              exit={{ x: -260 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col h-screen bg-card border-r border-border shadow-[4px_0_16px_rgba(0,0,0,0.1)]"
              style={{ width: 260 }}
            >
              {/* Logo area with close button */}
              <div className="flex items-center justify-between h-[72px] px-4 shrink-0 border-b border-border/50">
                <RiverseLogo expanded={true} />
                <button
                  onClick={onMobileClose}
                  className="p-1.5 rounded-lg hover:bg-muted border-none bg-transparent cursor-pointer"
                >
                  <X size={20} className="text-muted-foreground" />
                </button>
              </div>

              {/* Navigation - close on click */}
              <nav className="flex-1 py-4 overflow-y-auto px-3">
                <ul className="list-none m-0 p-0 flex flex-col gap-1">
                  {navItems.map((item) => {
                    const Icon = item.icon;
                    const isActive = location.pathname === item.path;
                    return (
                      <li key={item.path}>
                        <NavLink
                          to={item.path}
                          onClick={onMobileClose}
                          className={cn(
                            'flex items-center gap-3 py-2.5 px-3 rounded-lg text-sm no-underline transition-all duration-200 relative',
                            isActive
                              ? 'font-semibold bg-primary text-white'
                              : 'font-medium text-text-secondary hover:bg-muted'
                          )}
                        >
                          {isActive && (
                            <div className="absolute left-0 top-1 bottom-1 w-[3px] rounded-full bg-accent" />
                          )}
                          <Icon size={20} strokeWidth={isActive ? 2.2 : 1.8} />
                          <span>{t(language, item.labelKey)}</span>
                        </NavLink>
                      </li>
                    );
                  })}
                </ul>
              </nav>

              {/* Bottom controls - always show expanded */}
              <div className="shrink-0 px-3 py-4 flex flex-col gap-3 border-t border-border/50">
                {/* Upload Button */}
                <button
                  onClick={() => { setUploaderOpen(true); onMobileClose?.(); }}
                  className={cn(
                    'flex items-center gap-2.5 w-full px-3 py-2.5 rounded-lg text-sm font-medium transition-colors duration-200 border-none cursor-pointer',
                    hasUploadedData()
                      ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                      : 'bg-transparent text-text-secondary hover:bg-muted',
                  )}
                >
                  <Upload size={18} strokeWidth={1.8} />
                  <span>{t(language, 'upload.button')}</span>
                  {hasUploadedData() && (
                    <span className="w-2 h-2 rounded-full bg-emerald-500 ml-auto" />
                  )}
                </button>

                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wider text-text-muted">Lang</span>
                  <TogglePill
                    options={[{ label: 'KO', value: 'ko' }, { label: 'JA', value: 'ja' }]}
                    value={language}
                    onChange={(val) => setLanguage(val as 'ko' | 'ja')}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wider text-text-muted">Currency</span>
                  <TogglePill
                    options={[{ label: 'JPY', value: 'JPY' }, { label: 'KRW', value: 'KRW' }]}
                    value={currency}
                    onChange={(val) => setCurrency(val as 'JPY' | 'KRW')}
                  />
                </div>
              </div>
            </motion.aside>
          </div>
        </div>
      )}
    </>
  );
}
