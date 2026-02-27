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
  ChevronLeft,
  ChevronRight,
  X,
} from 'lucide-react';
import { useAppState } from '../../hooks/useAppState';
import { t } from '../../i18n';
import { cn } from '../../lib/utils';

const navItems = [
  { path: '/summary', labelKey: 'nav.summary', icon: LayoutDashboard },
  { path: '/titles', labelKey: 'nav.titles', icon: BookOpen },
  { path: '/platforms', labelKey: 'nav.platforms', icon: Globe },
  { path: '/period', labelKey: 'nav.period', icon: Calendar },
  { path: '/trends', labelKey: 'nav.trends', icon: TrendingUp },
  { path: '/data', labelKey: 'nav.rawData', icon: Database },
];

function RiverseLogo({ expanded }: { expanded: boolean }) {
  return (
    <div className="flex items-center gap-3 overflow-hidden">
      {/* Icon mark - always visible */}
      <div className="flex items-center justify-center w-9 h-9 rounded-lg shrink-0"
        style={{ backgroundColor: '#0F1B4C' }}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path
            d="M4 4h6v6H4V4Z"
            fill="rgba(255,255,255,0.9)"
            rx="1"
          />
          <path
            d="M14 4h6v6h-6V4Z"
            fill="rgba(255,255,255,0.5)"
            rx="1"
          />
          <path
            d="M4 14h6v6H4v-6Z"
            fill="rgba(255,255,255,0.5)"
            rx="1"
          />
          <path
            d="M14 14h6v6h-6v-6Z"
            fill="rgba(255,255,255,0.3)"
            rx="1"
          />
        </svg>
      </div>
      {/* Text logo - only when expanded */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, width: 0 }}
            animate={{ opacity: 1, width: 'auto' }}
            exit={{ opacity: 0, width: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden whitespace-nowrap"
          >
            <div className="flex flex-col">
              <svg width="110" height="22" viewBox="0 0 110 22" xmlns="http://www.w3.org/2000/svg">
                <text x="0" y="17" fontFamily="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" fill="#0F1B4C">
                  <tspan fontWeight="800" fontSize="18" letterSpacing="0.5">RIV</tspan>
                  <tspan fontWeight="500" fontSize="18" letterSpacing="0.5">ERSE</tspan>
                </text>
              </svg>
              <span
                className="text-[11px] font-medium tracking-wider uppercase"
                style={{ color: '#94A3B8' }}
              >
                Sales Dashboard
              </span>
            </div>
          </motion.div>
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
    <div
      className="flex rounded-lg overflow-hidden relative"
      style={{ backgroundColor: '#F1F5F9', padding: '2px' }}
    >
      {options.map((opt) => {
        const isActive = value === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={cn(
              'relative z-10 px-3 py-1 text-xs font-semibold cursor-pointer border-none rounded-md transition-all duration-200',
              isActive
                ? 'text-white'
                : 'text-[#64748B] hover:text-[#475569] bg-transparent'
            )}
            style={
              isActive
                ? { backgroundColor: '#0F1B4C', color: '#FFFFFF' }
                : undefined
            }
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
      className="flex flex-col h-screen shrink-0 relative"
      style={{
        backgroundColor: '#FFFFFF',
        borderRight: '1px solid #E2E8F0',
        boxShadow: '1px 0 4px rgba(0, 0, 0, 0.03)',
      }}
    >
      {/* Logo Area */}
      <div
        className="flex items-center justify-between h-[72px] px-4 shrink-0"
        style={{ borderBottom: '1px solid #F1F5F9' }}
      >
        <RiverseLogo expanded={expanded} />
      </div>

      {/* Collapse Toggle Button */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="absolute top-[78px] -right-3 z-20 flex items-center justify-center w-6 h-6 rounded-full border cursor-pointer transition-all duration-200 hover:scale-110"
        style={{
          backgroundColor: '#FFFFFF',
          borderColor: '#E2E8F0',
          color: '#94A3B8',
          boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
        }}
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
                    isActive ? 'font-semibold' : 'font-medium'
                  )}
                  style={{
                    color: isActive ? '#FFFFFF' : '#475569',
                    backgroundColor: isActive ? '#0F1B4C' : 'transparent',
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = '#F1F5F9';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = 'transparent';
                    }
                  }}
                >
                  {/* Active left accent bar */}
                  {isActive && (
                    <motion.div
                      layoutId="sidebar-active-indicator"
                      className="absolute left-0 top-1 bottom-1 w-[3px] rounded-full"
                      style={{ backgroundColor: '#2563EB' }}
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
      <div
        className="shrink-0 px-3 py-4 flex flex-col gap-3"
        style={{ borderTop: '1px solid #F1F5F9' }}
      >
        {/* Language Toggle */}
        <div className={cn('flex items-center', expanded ? 'justify-between' : 'justify-center')}>
          <AnimatePresence>
            {expanded && (
              <motion.span
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="text-xs font-medium uppercase tracking-wider"
                style={{ color: '#94A3B8' }}
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
                className="text-xs font-medium uppercase tracking-wider"
                style={{ color: '#94A3B8' }}
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
              className="flex flex-col h-screen"
              style={{
                backgroundColor: '#FFFFFF',
                borderRight: '1px solid #E2E8F0',
                boxShadow: '4px 0 16px rgba(0, 0, 0, 0.1)',
                width: 260,
              }}
            >
              {/* Logo area with close button */}
              <div className="flex items-center justify-between h-[72px] px-4 shrink-0"
                style={{ borderBottom: '1px solid #F1F5F9' }}>
                <RiverseLogo expanded={true} />
                <button onClick={onMobileClose} className="p-1.5 rounded-lg hover:bg-slate-100"
                  style={{ border: 'none', background: 'none', cursor: 'pointer' }}>
                  <X size={20} color="#64748B" />
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
                            isActive ? 'font-semibold' : 'font-medium'
                          )}
                          style={{
                            color: isActive ? '#FFFFFF' : '#475569',
                            backgroundColor: isActive ? '#0F1B4C' : 'transparent',
                          }}
                        >
                          {isActive && (
                            <div className="absolute left-0 top-1 bottom-1 w-[3px] rounded-full"
                              style={{ backgroundColor: '#2563EB' }} />
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
              <div className="shrink-0 px-3 py-4 flex flex-col gap-3"
                style={{ borderTop: '1px solid #F1F5F9' }}>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wider" style={{ color: '#94A3B8' }}>Lang</span>
                  <TogglePill
                    options={[{ label: 'KO', value: 'ko' }, { label: 'JA', value: 'ja' }]}
                    value={language}
                    onChange={(val) => setLanguage(val as 'ko' | 'ja')}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wider" style={{ color: '#94A3B8' }}>Currency</span>
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
