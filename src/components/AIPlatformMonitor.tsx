import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Activity, ChevronDown, ChevronUp } from 'lucide-react';
import { generateInsights } from '@/utils/insights';
import { cn } from '@/lib/utils';
import type { PlatformSummary, TitleSummary, Language } from '@/types';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AIPlatformMonitorProps {
  platformSummary: PlatformSummary[];
  titleSummary: TitleSummary[];
  language: Language;
}

/* ------------------------------------------------------------------ */
/*  Animation variants                                                 */
/* ------------------------------------------------------------------ */

const containerVariants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.08 },
  },
  exit: {
    opacity: 0,
    transition: { duration: 0.15 },
  },
};

const itemVariants = {
  hidden: { opacity: 0, y: 8 },
  show: {
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.35,
      ease: [0.22, 1, 0.36, 1] as [number, number, number, number],
    },
  },
};

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const typeStyles: Record<string, { border: string; bg: string; dot: string }> = {
  success: {
    border: 'border-l-emerald-500',
    bg: 'hover:bg-emerald-50/50',
    dot: 'bg-emerald-500',
  },
  warning: {
    border: 'border-l-amber-500',
    bg: 'hover:bg-amber-50/50',
    dot: 'bg-amber-500',
  },
  info: {
    border: 'border-l-blue-500',
    bg: 'hover:bg-blue-50/50',
    dot: 'bg-blue-500',
  },
};

function formatTime(language: Language): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  return language === 'ko'
    ? `${y}.${m}.${d} ${h}:${min} 기준`
    : `${y}/${m}/${d} ${h}:${min} 時点`;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function AIPlatformMonitor({
  platformSummary,
  titleSummary,
  language,
}: AIPlatformMonitorProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const insights = useMemo(
    () => generateInsights(platformSummary, titleSummary, language),
    [platformSummary, titleSummary, language],
  );

  const generatedAt = useMemo(() => formatTime(language), [language]);

  const criticalInsights = useMemo(
    () => insights.filter((i) => i.type === 'warning'),
    [insights],
  );

  const nonCriticalCount = insights.length - criticalInsights.length;

  if (insights.length === 0) return null;

  const title = language === 'ko' ? '주요 이슈 브리핑' : '主要イシューブリーフィング';
  const showAllLabel = language === 'ko'
    ? `모두 보기 (${insights.length})`
    : `すべて表示 (${insights.length})`;
  const collapseLabel = language === 'ko' ? '접기' : '閉じる';

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
      {/* Header */}
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className={cn(
          'w-full flex items-center justify-between px-5 py-3.5',
          'cursor-pointer select-none bg-transparent border-none',
          'transition-colors duration-150 hover:bg-muted/50',
        )}
      >
        <div className="flex items-center gap-2.5">
          <Activity size={18} className="text-primary" />
          <span className="text-[15px] font-bold text-primary">
            {title}
          </span>
          {criticalInsights.length > 0 && (
            <span className="text-xs font-bold px-1.5 py-0.5 rounded-md bg-amber-100 text-amber-700">
              {criticalInsights.length}
            </span>
          )}
          {nonCriticalCount > 0 && (
            <span className="text-xs text-muted-foreground font-medium px-1.5 py-0.5 rounded-md bg-muted">
              +{nonCriticalCount}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2.5">
          <span className="text-[11px] text-muted-foreground hidden sm:inline">
            {generatedAt}
          </span>
          {isExpanded ? (
            <ChevronUp size={16} className="text-muted-foreground" />
          ) : (
            <ChevronDown size={16} className="text-muted-foreground" />
          )}
        </div>
      </button>

      {/* Critical alerts preview (when collapsed) */}
      {!isExpanded && criticalInsights.length > 0 && (
        <div className="border-t border-border/60 px-5 py-2.5">
          {criticalInsights.slice(0, 2).map((insight, index) => {
            const style = typeStyles[insight.type] || typeStyles.info;
            return (
              <div
                key={index}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-1.5 rounded-md',
                  'border-l-[3px] mb-1 last:mb-0',
                  style.border,
                )}
              >
                <span className="text-sm leading-none shrink-0">
                  {insight.icon}
                </span>
                <p className="text-[12px] leading-snug text-foreground/80 truncate">
                  {insight.text}
                </p>
              </div>
            );
          })}
          {insights.length > criticalInsights.slice(0, 2).length && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setIsExpanded(true);
              }}
              className="text-[11px] text-primary font-medium mt-1 hover:underline cursor-pointer bg-transparent border-none p-0"
            >
              {showAllLabel}
            </button>
          )}
        </div>
      )}

      {/* Collapsed: no critical alerts, show hint */}
      {!isExpanded && criticalInsights.length === 0 && insights.length > 0 && (
        <div className="border-t border-border/60 px-5 py-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setIsExpanded(true);
            }}
            className="text-[11px] text-primary font-medium hover:underline cursor-pointer bg-transparent border-none p-0"
          >
            {showAllLabel}
          </button>
        </div>
      )}

      {/* Divider */}
      {isExpanded && <div className="border-t border-border/60" />}

      {/* Body (expanded) */}
      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            key="insights-body"
            initial="hidden"
            animate="show"
            exit="exit"
            variants={containerVariants}
            className="px-5 py-4"
          >
            <div className="grid gap-2">
              {insights.map((insight, index) => {
                const style = typeStyles[insight.type] || typeStyles.info;
                return (
                  <motion.div
                    key={index}
                    variants={itemVariants}
                    className={cn(
                      'flex items-start gap-3 rounded-lg px-4 py-2.5',
                      'border-l-[3px] transition-colors duration-150',
                      style.border,
                      style.bg,
                    )}
                  >
                    <span className="text-base leading-none mt-0.5 shrink-0">
                      {insight.icon}
                    </span>
                    <p className="text-[13px] leading-relaxed text-foreground/85">
                      {insight.text}
                    </p>
                  </motion.div>
                );
              })}
            </div>

            {/* Collapse button + Mobile timestamp */}
            <div className="flex items-center justify-between mt-3">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsExpanded(false);
                }}
                className="text-[11px] text-primary font-medium hover:underline cursor-pointer bg-transparent border-none p-0"
              >
                {collapseLabel}
              </button>
              <p className="text-[11px] text-muted-foreground sm:hidden">
                {generatedAt}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
