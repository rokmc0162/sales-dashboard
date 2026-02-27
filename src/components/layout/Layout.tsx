import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { Menu } from 'lucide-react';
import { Sidebar } from './Sidebar';

const pageVariants = {
  initial: {
    opacity: 0,
    y: 12,
  },
  enter: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.4,
      ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
    },
  },
  exit: {
    opacity: 0,
    y: -8,
    transition: {
      duration: 0.25,
      ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
    },
  },
};

export function Layout() {
  const location = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden" style={{ backgroundColor: '#F8FAFC' }}>
      <Sidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile header bar */}
        <div className="md:hidden flex items-center h-14 px-4 shrink-0"
          style={{ backgroundColor: '#FFFFFF', borderBottom: '1px solid #E2E8F0' }}>
          <button onClick={() => setMobileOpen(true)} className="p-2 -ml-2 rounded-lg"
            style={{ color: '#475569', border: 'none', background: 'none', cursor: 'pointer' }}>
            <Menu size={22} />
          </button>
          <div className="ml-3 flex items-center gap-2">
            <div className="w-7 h-7 rounded-md flex items-center justify-center" style={{ backgroundColor: '#0F1B4C' }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path d="M4 4h6v6H4V4Z" fill="rgba(255,255,255,0.9)" />
                <path d="M14 4h6v6h-6V4Z" fill="rgba(255,255,255,0.5)" />
                <path d="M4 14h6v6H4v-6Z" fill="rgba(255,255,255,0.5)" />
                <path d="M14 14h6v6h-6v-6Z" fill="rgba(255,255,255,0.3)" />
              </svg>
            </div>
            <span className="font-bold text-sm" style={{ color: '#0F1B4C' }}>RIVERSE</span>
          </div>
        </div>

        <main className="flex-1 overflow-y-auto">
          <AnimatePresence mode="wait">
            <motion.div
              key={location.pathname}
              variants={pageVariants}
              initial="initial"
              animate="enter"
              exit="exit"
              className="min-h-full p-4 md:p-6 lg:p-8"
            >
              <Outlet />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}
