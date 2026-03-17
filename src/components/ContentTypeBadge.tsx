import type { ContentType, Language } from '@/types';
import { CONTENT_TYPE_LABELS } from '@/types';

const typeStyles: Record<ContentType, { bg: string; text: string }> = {
  WT: { bg: 'bg-purple-100', text: 'text-purple-700' },
  EP: { bg: 'bg-sky-100', text: 'text-sky-700' },
  EB: { bg: 'bg-teal-100', text: 'text-teal-700' },
  UNKNOWN: { bg: 'bg-gray-100', text: 'text-gray-500' },
};

interface ContentTypeBadgeProps {
  type: ContentType;
  language: Language;
  size?: 'sm' | 'md';
}

export function ContentTypeBadge({ type, language, size = 'sm' }: ContentTypeBadgeProps) {
  const style = typeStyles[type] || typeStyles.UNKNOWN;
  const label = CONTENT_TYPE_LABELS[type]?.[language] || type;

  return (
    <span
      className={`inline-flex items-center font-bold rounded-md ${style.bg} ${style.text} ${
        size === 'sm' ? 'text-[9px] px-1.5 py-0.5' : 'text-[11px] px-2 py-0.5'
      }`}
    >
      {type}{size === 'md' ? ` ${label}` : ''}
    </span>
  );
}
