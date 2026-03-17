import type { Language } from '@/types';
import { cn } from '@/lib/utils';

interface BilingualTitleProps {
  titleKR: string;
  titleJP: string;
  language: Language;
  variant?: 'default' | 'compact' | 'inline';
  className?: string;
  maxWidth?: string;
}

export function BilingualTitle({
  titleKR,
  titleJP,
  language,
  variant = 'default',
  className,
  maxWidth,
}: BilingualTitleProps) {
  const primary = language === 'ko' ? titleKR : titleJP;
  const secondary = language === 'ko' ? titleJP : titleKR;

  if (!secondary || secondary === primary) {
    return <span className={className}>{primary}</span>;
  }

  if (variant === 'default') {
    return (
      <div className={cn('min-w-0', className)} style={maxWidth ? { maxWidth } : undefined}>
        <div className="font-semibold truncate">{primary}</div>
        <div className="text-xs text-muted-foreground truncate mt-0.5">{secondary}</div>
      </div>
    );
  }

  if (variant === 'compact') {
    return (
      <span className={cn('min-w-0 truncate block', className)} style={maxWidth ? { maxWidth } : undefined}>
        <span>{primary}</span>
        <span className="text-muted-foreground text-[0.85em]"> / {secondary}</span>
      </span>
    );
  }

  // inline
  return (
    <span className={cn('min-w-0', className)} style={maxWidth ? { maxWidth } : undefined}>
      {primary}
      <span className="text-muted-foreground text-[0.85em]"> ({secondary})</span>
    </span>
  );
}

/**
 * Helper to format a bilingual name as a plain string (for chart tooltips, etc.)
 */
export function bilingualName(titleKR: string, titleJP: string, language: Language): string {
  const primary = language === 'ko' ? titleKR : titleJP;
  const secondary = language === 'ko' ? titleJP : titleKR;
  if (!secondary || secondary === primary) return primary;
  return `${primary} / ${secondary}`;
}
