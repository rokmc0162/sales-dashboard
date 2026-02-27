import type { ReactNode } from 'react';

interface KPICardProps {
  title: string;
  value: string;
  subtitle?: string;
  change?: number;
  icon?: ReactNode;
  sparkline?: number[];
}

export function KPICard({ title, value, subtitle, change, icon, sparkline }: KPICardProps) {
  const isPositive = change !== undefined && change >= 0;
  const changeColor = isPositive ? '#22c55e' : '#ef4444';

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

  return (
    <div
      className="rounded-xl p-6 transition-all duration-200 hover:scale-[1.02] hover:shadow-lg cursor-default"
      style={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
    >
      <div className="flex items-start justify-between mb-3">
        <span className="text-xs font-medium uppercase tracking-wider" style={{ color: '#94a3b8' }}>
          {title}
        </span>
        {icon && (
          <span className="flex items-center justify-center w-8 h-8 rounded-lg" style={{ backgroundColor: 'rgba(59, 130, 246, 0.15)', color: '#3b82f6' }}>
            {icon}
          </span>
        )}
      </div>

      <div className="text-2xl font-bold mb-1" style={{ color: '#f8fafc' }}>
        {value}
      </div>

      <div className="flex items-center gap-2">
        {change !== undefined && (
          <span className="flex items-center gap-1 text-sm font-medium" style={{ color: changeColor }}>
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
          <span className="text-xs" style={{ color: '#64748b' }}>
            {subtitle}
          </span>
        )}
      </div>

      {sparkline && sparkline.length > 1 && (
        <div className="mt-4 -mx-1">
          <svg viewBox="0 0 100 32" className="w-full h-8" preserveAspectRatio="none">
            <path
              d={buildSparklineArea(sparkline)}
              fill="rgba(59, 130, 246, 0.1)"
            />
            <path
              d={buildSparklinePath(sparkline)}
              fill="none"
              stroke="#3b82f6"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>
      )}
    </div>
  );
}
