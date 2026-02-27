import { type ReactNode, useEffect, useRef } from 'react';
import {
  motion,
  useMotionValue,
  useSpring,
  useInView,
  useTransform,
} from 'framer-motion';

interface KPICardProps {
  title: string;
  value: string;
  subtitle?: string;
  change?: number;
  icon?: ReactNode;
  sparkline?: number[];
  accentColor?: string;
  delay?: number;
}

/**
 * Animated number counter that springs from 0 to the target.
 * Parses the displayed value to extract the numeric part, animates it,
 * then reconstructs the string with prefix/suffix.
 */
function AnimatedValue({ value, delay = 0 }: { value: string; delay: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const isInView = useInView(ref, { once: true, margin: '-40px' });

  // Parse value: extract prefix (currency symbol etc.), number, and suffix
  const match = value.match(/^([^\d]*?)([\d,]+\.?\d*)(.*?)$/);
  const prefix = match ? match[1] : '';
  const numericStr = match ? match[2].replace(/,/g, '') : '';
  const suffix = match ? match[3] : '';
  const numericValue = parseFloat(numericStr) || 0;

  const motionVal = useMotionValue(0);
  const springVal = useSpring(motionVal, {
    stiffness: 60,
    damping: 25,
    restDelta: 0.01,
  });

  // Format with commas
  const hasDecimals = numericStr.includes('.');
  const decimalPlaces = hasDecimals ? (numericStr.split('.')[1]?.length ?? 0) : 0;

  const display = useTransform(springVal, (latest: number) => {
    const formatted = latest.toLocaleString('en-US', {
      minimumFractionDigits: decimalPlaces,
      maximumFractionDigits: decimalPlaces,
    });
    return `${prefix}${formatted}${suffix}`;
  });

  useEffect(() => {
    if (isInView) {
      const timeout = setTimeout(() => {
        motionVal.set(numericValue);
      }, delay * 1000);
      return () => clearTimeout(timeout);
    }
  }, [isInView, numericValue, delay, motionVal]);

  // If there's no numeric part, just show the value as-is
  if (!match) {
    return <span ref={ref}>{value}</span>;
  }

  return <motion.span ref={ref}>{display}</motion.span>;
}

// Build sparkline SVG path from data points
function buildSparklinePath(data: number[]): string {
  if (data.length < 2) return '';
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const width = 100;
  const height = 32;
  const step = width / (data.length - 1);

  const points = data.map((v, i) => {
    const x = i * step;
    const y = height - ((v - min) / range) * height;
    return `${x},${y}`;
  });

  return `M${points.join(' L')}`;
}

function buildSparklineArea(data: number[]): string {
  if (data.length < 2) return '';
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const width = 100;
  const height = 32;
  const step = width / (data.length - 1);

  const points = data.map((v, i) => {
    const x = i * step;
    const y = height - ((v - min) / range) * height;
    return `${x},${y}`;
  });

  return `M0,${height} L${points.join(' L')} L${width},${height} Z`;
}

export function KPICard({
  title,
  value,
  subtitle,
  change,
  icon,
  sparkline,
  accentColor = '#2563EB',
  delay = 0,
}: KPICardProps) {
  const isPositive = change !== undefined && change >= 0;
  const changeColor = isPositive ? '#16A34A' : '#DC2626';
  const changeBg = isPositive
    ? 'rgba(22, 163, 74, 0.08)'
    : 'rgba(220, 38, 38, 0.08)';

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        delay,
        duration: 0.45,
        ease: [0.22, 1, 0.36, 1],
      }}
      whileHover={{
        y: -2,
        transition: { duration: 0.2 },
      }}
      className="relative rounded-xl overflow-hidden cursor-default"
      style={{
        backgroundColor: '#FFFFFF',
        border: '1px solid #E2E8F0',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.03)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow =
          '0 4px 12px rgba(0, 0, 0, 0.07), 0 2px 4px rgba(0, 0, 0, 0.04)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow =
          '0 1px 3px rgba(0, 0, 0, 0.04), 0 1px 2px rgba(0, 0, 0, 0.03)';
      }}
    >
      {/* Left accent bar */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1"
        style={{ backgroundColor: accentColor }}
      />

      <div className="p-6 pl-5">
        {/* Header row: title + icon */}
        <div className="flex items-start justify-between mb-3">
          <span
            className="text-xs font-semibold uppercase tracking-wider"
            style={{ color: '#94A3B8' }}
          >
            {title}
          </span>
          {icon && (
            <span
              className="flex items-center justify-center w-10 h-10 rounded-xl"
              style={{
                backgroundColor: `${accentColor}10`,
                color: accentColor,
              }}
            >
              {icon}
            </span>
          )}
        </div>

        {/* Value - large for readability (presbyopia/nosian friendly) */}
        <div
          className="text-3xl font-bold mb-1.5 tracking-tight"
          style={{ color: '#0F172A', lineHeight: 1.2 }}
        >
          <AnimatedValue value={value} delay={delay} />
        </div>

        {/* Change + Subtitle row */}
        <div className="flex items-center gap-2.5 flex-wrap">
          {change !== undefined && (
            <span
              className="inline-flex items-center gap-1 text-sm font-semibold px-2 py-0.5 rounded-md"
              style={{ color: changeColor, backgroundColor: changeBg }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ transform: isPositive ? 'none' : 'rotate(180deg)' }}
              >
                <polyline points="18 15 12 9 6 15" />
              </svg>
              {Math.abs(change).toFixed(1)}%
            </span>
          )}
          {subtitle && (
            <span
              className="text-sm"
              style={{ color: '#64748B' }}
            >
              {subtitle}
            </span>
          )}
        </div>

        {/* Sparkline */}
        {sparkline && sparkline.length > 1 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: delay + 0.3, duration: 0.5 }}
            className="mt-4 -mx-1"
          >
            <svg
              viewBox="0 0 100 32"
              className="w-full h-8"
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient
                  id={`sparkGradient-${title.replace(/\s/g, '')}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor={accentColor} stopOpacity="0.15" />
                  <stop offset="100%" stopColor={accentColor} stopOpacity="0.01" />
                </linearGradient>
              </defs>
              <path
                d={buildSparklineArea(sparkline)}
                fill={`url(#sparkGradient-${title.replace(/\s/g, '')})`}
              />
              <path
                d={buildSparklinePath(sparkline)}
                fill="none"
                stroke={accentColor}
                strokeWidth="1.5"
                vectorEffect="non-scaling-stroke"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </motion.div>
        )}
      </div>
    </motion.div>
  );
}
