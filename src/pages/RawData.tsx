import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { useDataLoader } from '../hooks/useDataLoader';
import { useAppState } from '../hooks/useAppState';
import { t } from '../i18n';
import { formatSales } from '../utils/formatters';
import { filterByDateRange } from '../utils/calculations';

const PAGE_SIZE = 50;

type SortKey = 'date' | 'title' | 'channel' | 'sales';
type SortDir = 'asc' | 'desc';

const fadeIn = {
  hidden: { opacity: 0, y: 20 },
  visible: { opacity: 1, y: 0 },
};

const stagger = {
  visible: {
    transition: { staggerChildren: 0.08 },
  },
};

export function RawData() {
  const data = useDataLoader();
  const { language, currency, exchangeRate } = useAppState();

  const [platformFilter, setPlatformFilter] = useState('');
  const [titleSearch, setTitleSearch] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  // Extract unique platforms
  const platforms = useMemo(() => {
    const set = new Set<string>();
    data.dailySales.forEach(d => set.add(d.channel));
    return Array.from(set).sort();
  }, [data.dailySales]);

  // Apply filters
  const filteredData = useMemo(() => {
    let result = data.dailySales;

    // Date range filter
    if (startDate && endDate) {
      result = filterByDateRange(result, startDate, endDate);
    } else if (startDate) {
      result = result.filter(d => d.date >= startDate);
    } else if (endDate) {
      result = result.filter(d => d.date <= endDate);
    }

    // Platform filter
    if (platformFilter) {
      result = result.filter(d => d.channel === platformFilter);
    }

    // Title search
    if (titleSearch.trim()) {
      const query = titleSearch.trim().toLowerCase();
      result = result.filter(d =>
        d.titleKR.toLowerCase().includes(query) ||
        d.titleJP.toLowerCase().includes(query)
      );
    }

    return result;
  }, [data.dailySales, platformFilter, titleSearch, startDate, endDate]);

  // Sort
  const sortedData = useMemo(() => {
    const sorted = [...filteredData].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'date':
          cmp = a.date.localeCompare(b.date);
          break;
        case 'title':
          cmp = (language === 'ko' ? a.titleKR : a.titleJP).localeCompare(
            language === 'ko' ? b.titleKR : b.titleJP,
          );
          break;
        case 'channel':
          cmp = a.channel.localeCompare(b.channel);
          break;
        case 'sales':
          cmp = a.sales - b.sales;
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [filteredData, sortKey, sortDir, language]);

  // Pagination
  const totalPages = Math.max(1, Math.ceil(sortedData.length / PAGE_SIZE));
  const pagedData = useMemo(() => {
    const start = page * PAGE_SIZE;
    return sortedData.slice(start, start + PAGE_SIZE);
  }, [sortedData, page]);

  // Summary
  const totalFilteredSales = useMemo(() => {
    return filteredData.reduce((s, d) => s + d.sales, 0);
  }, [filteredData]);

  // Sort handler
  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
    setPage(0);
  };

  // CSV download
  const downloadCSV = () => {
    const header = [t(language, 'table.date'), t(language, 'table.title'), t(language, 'table.platform'), t(language, 'table.sales')];
    const rows = sortedData.map(d => [
      d.date,
      `"${(language === 'ko' ? d.titleKR : d.titleJP).replace(/"/g, '""')}"`,
      d.channel,
      String(d.sales),
    ]);

    const bom = '\uFEFF';
    const csv = bom + [header.join(','), ...rows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `rvjp_sales_data_${new Date().toISOString().substring(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // Reset page when filters change
  const handleFilterChange = <T,>(setter: React.Dispatch<React.SetStateAction<T>>, value: T) => {
    setter(value);
    setPage(0);
  };

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return ' \u2195';
    return sortDir === 'asc' ? ' \u2191' : ' \u2193';
  };

  if (data.loading) {
    return (
      <div className="flex items-center justify-center" style={{ minHeight: '400px' }}>
        <div className="animate-spin rounded-full h-10 w-10 border-b-2" style={{ borderColor: '#2563EB' }} />
      </div>
    );
  }

  return (
    <motion.div
      initial="hidden"
      animate="visible"
      variants={stagger}
    >
      {/* Page title */}
      <motion.h1
        variants={fadeIn}
        className="font-bold mb-8"
        style={{ color: '#0F1B4C', fontSize: '28px', letterSpacing: '-0.025em' }}
      >
        {t(language, 'nav.rawData')}
      </motion.h1>

      {/* Filter controls row */}
      <motion.div
        variants={fadeIn}
        className="rounded-2xl p-6 mb-6"
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #E2E8F0',
          boxShadow: '0 1px 3px 0 rgba(0,0,0,0.05)',
        }}
      >
        <div className="flex flex-wrap items-end gap-5">
          {/* Platform dropdown */}
          <div className="flex flex-col gap-1.5">
            <label className="font-semibold" style={{ color: '#475569', fontSize: '13px', letterSpacing: '0.02em' }}>
              {t(language, 'filter.platform')}
            </label>
            <select
              value={platformFilter}
              onChange={e => handleFilterChange(setPlatformFilter, e.target.value)}
              className="rounded-xl px-4 py-2.5 outline-none focus:ring-2 focus:ring-blue-500 transition-shadow cursor-pointer"
              style={{
                backgroundColor: '#ffffff',
                border: '1px solid #CBD5E1',
                color: '#0F172A',
                fontSize: '14px',
                fontWeight: 500,
                minWidth: '160px',
              }}
            >
              <option value="">{t(language, 'filter.allPlatforms')}</option>
              {platforms.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          {/* Title search */}
          <div className="flex flex-col gap-1.5 flex-1 min-w-[220px]">
            <label className="font-semibold" style={{ color: '#475569', fontSize: '13px', letterSpacing: '0.02em' }}>
              {t(language, 'filter.title')}
            </label>
            <div className="relative">
              <svg
                className="absolute left-3.5 top-1/2 -translate-y-1/2"
                width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#94A3B8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <input
                type="text"
                value={titleSearch}
                onChange={e => handleFilterChange(setTitleSearch, e.target.value)}
                placeholder={t(language, 'filter.search')}
                className="w-full rounded-xl pl-10 pr-4 py-2.5 outline-none focus:ring-2 focus:ring-blue-500 transition-shadow"
                style={{
                  backgroundColor: '#ffffff',
                  border: '1px solid #CBD5E1',
                  color: '#0F172A',
                  fontSize: '14px',
                  fontWeight: 500,
                }}
              />
            </div>
          </div>

          {/* Date range */}
          <div className="flex flex-col gap-1.5">
            <label className="font-semibold" style={{ color: '#475569', fontSize: '13px', letterSpacing: '0.02em' }}>
              {t(language, 'filter.dateRange')}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={startDate}
                onChange={e => handleFilterChange(setStartDate, e.target.value)}
                className="rounded-xl px-4 py-2.5 outline-none focus:ring-2 focus:ring-blue-500 transition-shadow"
                style={{
                  backgroundColor: '#ffffff',
                  border: '1px solid #CBD5E1',
                  color: '#0F172A',
                  fontSize: '14px',
                  fontWeight: 500,
                }}
              />
              <span style={{ color: '#94A3B8', fontSize: '16px', fontWeight: 500 }}>~</span>
              <input
                type="date"
                value={endDate}
                onChange={e => handleFilterChange(setEndDate, e.target.value)}
                className="rounded-xl px-4 py-2.5 outline-none focus:ring-2 focus:ring-blue-500 transition-shadow"
                style={{
                  backgroundColor: '#ffffff',
                  border: '1px solid #CBD5E1',
                  color: '#0F172A',
                  fontSize: '14px',
                  fontWeight: 500,
                }}
              />
            </div>
          </div>
        </div>
      </motion.div>

      {/* Summary row + CSV download */}
      <motion.div
        variants={fadeIn}
        className="flex flex-wrap items-center justify-between mb-5 gap-4"
      >
        <div className="flex items-center gap-4">
          <span style={{ color: '#64748B', fontSize: '14px', fontWeight: 500 }}>
            {t(language, 'table.showing')}{' '}
            <span style={{ color: '#0F172A', fontWeight: 700, fontSize: '15px' }}>
              {filteredData.length.toLocaleString()}
            </span>{' '}
            {t(language, 'table.of')}{' '}
            <span style={{ color: '#0F172A', fontWeight: 700, fontSize: '15px' }}>
              {data.dailySales.length.toLocaleString()}
            </span>
          </span>
          <span style={{ color: '#E2E8F0', fontSize: '18px' }}>|</span>
          <span style={{ color: '#64748B', fontSize: '14px', fontWeight: 500 }}>
            {t(language, 'table.sales')}:{' '}
            <span style={{ color: '#0F172A', fontWeight: 700, fontSize: '15px' }}>
              {formatSales(totalFilteredSales, currency, exchangeRate, language)}
            </span>
          </span>
        </div>
        <button
          onClick={downloadCSV}
          className="flex items-center gap-2.5 px-5 py-2.5 rounded-xl font-semibold transition-all duration-200 hover:shadow-lg"
          style={{
            backgroundColor: '#2563EB',
            color: '#ffffff',
            fontSize: '14px',
            boxShadow: '0 2px 8px rgba(37,99,235,0.25)',
          }}
          onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#1D4ED8'; }}
          onMouseLeave={e => { e.currentTarget.style.backgroundColor = '#2563EB'; }}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          {t(language, 'table.download')}
        </button>
      </motion.div>

      {/* Data table */}
      <motion.div
        variants={fadeIn}
        className="rounded-2xl overflow-hidden"
        style={{
          backgroundColor: '#ffffff',
          border: '1px solid #E2E8F0',
          boxShadow: '0 1px 3px 0 rgba(0,0,0,0.05)',
        }}
      >
        <div className="overflow-x-auto">
          <table className="w-full" style={{ fontSize: '14px' }}>
            <thead>
              <tr style={{ backgroundColor: '#F8FAFC', borderBottom: '2px solid #E2E8F0' }}>
                <th
                  className="text-left py-3.5 px-5 font-semibold cursor-pointer select-none transition-colors duration-150"
                  style={{ color: '#475569' }}
                  onClick={() => handleSort('date')}
                  onMouseEnter={e => { e.currentTarget.style.color = '#0F172A'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = '#475569'; }}
                >
                  {t(language, 'table.date')}{sortIcon('date')}
                </th>
                <th
                  className="text-left py-3.5 px-5 font-semibold cursor-pointer select-none transition-colors duration-150"
                  style={{ color: '#475569' }}
                  onClick={() => handleSort('title')}
                  onMouseEnter={e => { e.currentTarget.style.color = '#0F172A'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = '#475569'; }}
                >
                  {t(language, 'table.title')}{sortIcon('title')}
                </th>
                <th
                  className="text-left py-3.5 px-5 font-semibold cursor-pointer select-none transition-colors duration-150"
                  style={{ color: '#475569' }}
                  onClick={() => handleSort('channel')}
                  onMouseEnter={e => { e.currentTarget.style.color = '#0F172A'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = '#475569'; }}
                >
                  {t(language, 'table.platform')}{sortIcon('channel')}
                </th>
                <th
                  className="text-right py-3.5 px-5 font-semibold cursor-pointer select-none transition-colors duration-150"
                  style={{ color: '#475569' }}
                  onClick={() => handleSort('sales')}
                  onMouseEnter={e => { e.currentTarget.style.color = '#0F172A'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = '#475569'; }}
                >
                  {t(language, 'table.sales')}{sortIcon('sales')}
                </th>
              </tr>
            </thead>
            <tbody>
              {pagedData.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-center py-16" style={{ color: '#94A3B8', fontSize: '15px' }}>
                    {language === 'ko' ? '데이터가 없습니다' : 'データがありません'}
                  </td>
                </tr>
              ) : (
                pagedData.map((row, idx) => (
                  <tr
                    key={`${row.date}-${row.titleKR}-${row.channel}-${idx}`}
                    className="transition-colors duration-100"
                    style={{
                      backgroundColor: idx % 2 === 0 ? '#ffffff' : '#F8FAFC',
                      borderBottom: '1px solid #F1F5F9',
                    }}
                    onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#F1F5F9'; }}
                    onMouseLeave={e => { e.currentTarget.style.backgroundColor = idx % 2 === 0 ? '#ffffff' : '#F8FAFC'; }}
                  >
                    <td className="py-3 px-5 font-medium" style={{ color: '#64748B' }}>
                      {row.date}
                    </td>
                    <td className="py-3 px-5 max-w-[300px] truncate font-medium" style={{ color: '#0F172A' }}>
                      {language === 'ko' ? row.titleKR : row.titleJP}
                    </td>
                    <td className="py-3 px-5">
                      <span
                        className="inline-block px-2.5 py-1 rounded-lg font-semibold"
                        style={{
                          backgroundColor: '#EFF6FF',
                          color: '#2563EB',
                          fontSize: '12px',
                        }}
                      >
                        {row.channel}
                      </span>
                    </td>
                    <td className="py-3 px-5 text-right font-bold" style={{ color: '#0F172A', fontSize: '15px' }}>
                      {formatSales(row.sales, currency, exchangeRate, language)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div
            className="flex items-center justify-between py-4 px-5"
            style={{ borderTop: '1px solid #E2E8F0', backgroundColor: '#F8FAFC' }}
          >
            <span style={{ color: '#64748B', fontSize: '13px', fontWeight: 500 }}>
              {page * PAGE_SIZE + 1}~{Math.min((page + 1) * PAGE_SIZE, sortedData.length)}{' '}
              / {sortedData.length.toLocaleString()}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-4 py-2 rounded-xl font-semibold transition-all duration-200 disabled:opacity-35"
                style={{
                  backgroundColor: '#E2E8F0',
                  color: '#475569',
                  fontSize: '13px',
                }}
                onMouseEnter={e => {
                  if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = '#CBD5E1';
                }}
                onMouseLeave={e => { e.currentTarget.style.backgroundColor = '#E2E8F0'; }}
              >
                {language === 'ko' ? '이전' : '前へ'}
              </button>
              <div
                className="flex items-center gap-1 px-3 py-2 rounded-xl"
                style={{ backgroundColor: '#ffffff', border: '1px solid #E2E8F0' }}
              >
                <span style={{ color: '#2563EB', fontWeight: 700, fontSize: '14px' }}>
                  {page + 1}
                </span>
                <span style={{ color: '#94A3B8', fontSize: '13px', fontWeight: 500 }}>
                  {' / '}{totalPages}
                </span>
              </div>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="px-4 py-2 rounded-xl font-semibold transition-all duration-200 disabled:opacity-35"
                style={{
                  backgroundColor: '#E2E8F0',
                  color: '#475569',
                  fontSize: '13px',
                }}
                onMouseEnter={e => {
                  if (!e.currentTarget.disabled) e.currentTarget.style.backgroundColor = '#CBD5E1';
                }}
                onMouseLeave={e => { e.currentTarget.style.backgroundColor = '#E2E8F0'; }}
              >
                {language === 'ko' ? '다음' : '次へ'}
              </button>
            </div>
          </div>
        )}
      </motion.div>
    </motion.div>
  );
}
