import { getPlatformBrand } from '../utils/platformConfig';

interface PlatformIconProps {
  name: string;
  size?: number;
  showLabel?: boolean;
  className?: string;
}

/**
 * Platform icon using actual logo image.
 * Falls back to colored square with abbreviation if no logo available.
 */
export function PlatformIcon({ name, size = 28, showLabel = false, className = '' }: PlatformIconProps) {
  const brand = getPlatformBrand(name);
  const borderRadius = size <= 20 ? 4 : size <= 28 ? 6 : 8;

  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      {brand.logo ? (
        <img
          src={brand.logo}
          alt={name}
          title={name}
          className="flex-shrink-0 object-cover"
          style={{
            width: size,
            height: size,
            borderRadius,
            boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
          }}
          loading="lazy"
          draggable={false}
        />
      ) : (
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
              fontSize: size <= 20 ? 8 : size <= 28 ? 10 : 12,
              fontWeight: 700,
              lineHeight: 1,
              letterSpacing: '-0.02em',
            }}
          >
            {brand.icon}
          </span>
        </div>
      )}
      {showLabel && (
        <span
          className="truncate"
          style={{
            color: '#334155',
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
 * Platform badge - pill-shaped label with logo + name
 */
export function PlatformBadge({ name, compact = false }: { name: string; compact?: boolean }) {
  const brand = getPlatformBrand(name);
  const iconSize = compact ? 16 : 20;
  const borderRadius = compact ? 3 : 4;

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-lg font-semibold"
      style={{
        backgroundColor: brand.bgColor,
        color: brand.color,
        border: `1px solid ${brand.borderColor}`,
        fontSize: compact ? '11px' : '12px',
        padding: compact ? '3px 8px' : '4px 10px',
      }}
    >
      {brand.logo ? (
        <img
          src={brand.logo}
          alt={name}
          className="flex-shrink-0 object-cover"
          style={{
            width: iconSize,
            height: iconSize,
            borderRadius,
          }}
          loading="lazy"
          draggable={false}
        />
      ) : (
        <span
          className="rounded flex-shrink-0"
          style={{
            width: iconSize,
            height: iconSize,
            backgroundColor: brand.color,
            color: '#fff',
            fontSize: compact ? '7px' : '8px',
            fontWeight: 700,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius,
          }}
        >
          {brand.icon}
        </span>
      )}
      {name}
    </span>
  );
}
