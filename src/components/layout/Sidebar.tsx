import { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAppState } from '../../hooks/useAppState';
import { t } from '../../i18n';

const navItems = [
  {
    path: '/summary',
    labelKey: 'nav.summary',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    ),
  },
  {
    path: '/titles',
    labelKey: 'nav.titles',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z" />
      </svg>
    ),
  },
  {
    path: '/platforms',
    labelKey: 'nav.platforms',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="2" y1="12" x2="22" y2="12" />
        <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
      </svg>
    ),
  },
  {
    path: '/period',
    labelKey: 'nav.period',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
        <line x1="16" y1="2" x2="16" y2="6" />
        <line x1="8" y1="2" x2="8" y2="6" />
        <line x1="3" y1="10" x2="21" y2="10" />
      </svg>
    ),
  },
  {
    path: '/trends',
    labelKey: 'nav.trends',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
  },
  {
    path: '/data',
    labelKey: 'nav.rawData',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <ellipse cx="12" cy="5" rx="9" ry="3" />
        <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
        <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
      </svg>
    ),
  },
];

export function Sidebar() {
  const [expanded, setExpanded] = useState(true);
  const { language, setLanguage, currency, setCurrency } = useAppState();

  return (
    <aside
      className={`flex flex-col h-screen shrink-0 transition-all duration-300 ${
        expanded ? 'w-60' : 'w-16'
      }`}
      style={{ backgroundColor: '#1e293b' }}
    >
      {/* Logo / Title */}
      <div className="flex items-center h-16 px-4 shrink-0" style={{ borderBottom: '1px solid #334155' }}>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-3 w-full cursor-pointer bg-transparent border-none"
        >
          <div
            className="flex items-center justify-center w-8 h-8 rounded-lg text-sm font-bold shrink-0"
            style={{ backgroundColor: '#3b82f6', color: '#f8fafc' }}
          >
            R
          </div>
          {expanded && (
            <div className="overflow-hidden">
              <div className="text-sm font-bold tracking-wide" style={{ color: '#f8fafc' }}>
                RVJP
              </div>
              <div className="text-xs" style={{ color: '#94a3b8' }}>
                Sales Dashboard
              </div>
            </div>
          )}
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 overflow-y-auto">
        <ul className="list-none m-0 p-0 flex flex-col gap-1">
          {navItems.map((item) => (
            <li key={item.path}>
              <NavLink
                to={item.path}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-4 py-2.5 mx-2 rounded-lg text-sm no-underline transition-colors duration-150 ${
                    isActive
                      ? 'font-medium'
                      : ''
                  }`
                }
                style={({ isActive }) => ({
                  color: isActive ? '#f8fafc' : '#94a3b8',
                  backgroundColor: isActive ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                  borderLeft: isActive ? '3px solid #3b82f6' : '3px solid transparent',
                })}
              >
                <span className="shrink-0 flex items-center justify-center w-5 h-5">{item.icon}</span>
                {expanded && <span className="truncate">{t(language, item.labelKey)}</span>}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>

      {/* Bottom Controls */}
      <div className="shrink-0 py-3 px-3 flex flex-col gap-2" style={{ borderTop: '1px solid #334155' }}>
        {/* Language Toggle */}
        <div className={`flex items-center ${expanded ? 'justify-between' : 'justify-center'}`}>
          {expanded && (
            <span className="text-xs" style={{ color: '#64748b' }}>
              Lang
            </span>
          )}
          <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid #334155' }}>
            <button
              onClick={() => setLanguage('ko')}
              className={`px-2 py-1 text-xs cursor-pointer border-none transition-colors duration-150`}
              style={{
                backgroundColor: language === 'ko' ? '#3b82f6' : 'transparent',
                color: language === 'ko' ? '#f8fafc' : '#94a3b8',
              }}
            >
              KO
            </button>
            <button
              onClick={() => setLanguage('ja')}
              className={`px-2 py-1 text-xs cursor-pointer border-none transition-colors duration-150`}
              style={{
                backgroundColor: language === 'ja' ? '#3b82f6' : 'transparent',
                color: language === 'ja' ? '#f8fafc' : '#94a3b8',
              }}
            >
              JA
            </button>
          </div>
        </div>

        {/* Currency Toggle */}
        <div className={`flex items-center ${expanded ? 'justify-between' : 'justify-center'}`}>
          {expanded && (
            <span className="text-xs" style={{ color: '#64748b' }}>
              Currency
            </span>
          )}
          <div className="flex rounded-md overflow-hidden" style={{ border: '1px solid #334155' }}>
            <button
              onClick={() => setCurrency('JPY')}
              className={`px-2 py-1 text-xs cursor-pointer border-none transition-colors duration-150`}
              style={{
                backgroundColor: currency === 'JPY' ? '#3b82f6' : 'transparent',
                color: currency === 'JPY' ? '#f8fafc' : '#94a3b8',
              }}
            >
              JPY
            </button>
            <button
              onClick={() => setCurrency('KRW')}
              className={`px-2 py-1 text-xs cursor-pointer border-none transition-colors duration-150`}
              style={{
                backgroundColor: currency === 'KRW' ? '#3b82f6' : 'transparent',
                color: currency === 'KRW' ? '#f8fafc' : '#94a3b8',
              }}
            >
              KRW
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
