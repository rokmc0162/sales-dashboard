import { getPlatformBrand } from '../utils/platformConfig';

interface PlatformIconProps {
  name: string;
  size?: number;
  showLabel?: boolean;
  className?: string;
}

/**
 * Branded platform icon - renders a rounded square with brand color and abbreviation.
 * Optionally shows the platform name beside the icon.
 */
export function PlatformIcon({ name, size = 28, showLabel = false, className = '' }: PlatformIconProps) {
  const brand = getPlatformBrand(name);
  const fontSize = size <= 20 ? 8 : size <= 28 ? 10 : 12;
  const borderRadius = size <= 20 ? 4 : 6;

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <div
        className="flex items-center justify-center flex-shrink-0"
        style={{
          width: size,
          height: size,
          borderRadius,
          backgroundColor: brand.color,
          boxShadow: `0 1px 3px ${brand.color}30`,
        }}
        title={name}
      >
        <span
          style={{
            color: '#ffffff',
            fontSize,
            fontWeight: 700,
            lineHeight: 1,
            letterSpacing: '-0.02em',
          }}
        >
          {brand.icon}
        </span>
      </div>
      {showLabel && (
        <span
          className="truncate"
          style={{
            color: brand.color,
            fontSize: '13px',
            fontWeight: 600,
          }}
        >
          {name}
        </span>
      )}
    </div>
  );
}

/**
 * Small colored dot for legends and compact displays
 */
export function PlatformDot({ name, size = 10 }: { name: string; size?: number }) {
  const brand = getPlatformBrand(name);
  return (
    <span
      className="flex-shrink-0 rounded-full"
      style={{
        width: size,
        height: size,
        backgroundColor: brand.color,
      }}
      title={name}
    />
  );
}

/**
 * Platform badge - pill-shaped label with brand colors
 */
export function PlatformBadge({ name, compact = false }: { name: string; compact?: boolean }) {
  const brand = getPlatformBrand(name);
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-md font-semibold"
      style={{
        backgroundColor: brand.bgColor,
        color: brand.color,
        border: `1px solid ${brand.borderColor}`,
        fontSize: compact ? '11px' : '12px',
        padding: compact ? '2px 6px' : '3px 8px',
      }}
    >
      <span
        className="rounded flex-shrink-0"
        style={{
          width: compact ? 12 : 14,
          height: compact ? 12 : 14,
          backgroundColor: brand.color,
          color: '#fff',
          fontSize: compact ? '7px' : '8px',
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 3,
        }}
      >
        {brand.icon}
      </span>
      {name}
    </span>
  );
}
