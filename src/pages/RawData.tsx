import { useState, useMemo } from 'react';
import { useDataLoader } from '../hooks/useDataLoader';
import { useAppState } from '../hooks/useAppState';
import { t } from '../i18n';
import { formatSales } from '../utils/formatters';
import { filterByDateRange } from '../utils/calculations';

const PAGE_SIZE = 50;

type SortKey = 'date' | 'title' | 'channel' | 'sales';
type SortDir = 'asc' | 'desc';

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
        <div className="animate-spin rounded-full h-8 w-8 border-b-2" style={{ borderColor: '#3b82f6' }} />
      </div>
    );
  }

  return (
    <div>
      {/* Page title */}
      <h1 className="text-2xl font-bold mb-6" style={{ color: '#f8fafc' }}>
        {t(language, 'nav.rawData')}
      </h1>

      {/* Filter controls row */}
      <div
        className="rounded-xl p-6 mb-6"
        style={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
      >
        <div className="flex flex-wrap items-center gap-4">
          {/* Platform dropdown */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" style={{ color: '#94a3b8' }}>
              {t(language, 'filter.platform')}
            </label>
            <select
              value={platformFilter}
              onChange={e => handleFilterChange(setPlatformFilter, e.target.value)}
              className="rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
              style={{ backgroundColor: '#0f172a', border: '1px solid #334155', color: '#f8fafc' }}
            >
              <option value="">{t(language, 'filter.allPlatforms')}</option>
              {platforms.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          {/* Title search */}
          <div className="flex flex-col gap-1 flex-1 min-w-[200px]">
            <label className="text-xs font-medium" style={{ color: '#94a3b8' }}>
              {t(language, 'filter.title')}
            </label>
            <input
              type="text"
              value={titleSearch}
              onChange={e => handleFilterChange(setTitleSearch, e.target.value)}
              placeholder={t(language, 'filter.search')}
              className="rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
              style={{ backgroundColor: '#0f172a', border: '1px solid #334155', color: '#f8fafc' }}
            />
          </div>

          {/* Date range */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium" style={{ color: '#94a3b8' }}>
              {t(language, 'filter.dateRange')}
            </label>
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={startDate}
                onChange={e => handleFilterChange(setStartDate, e.target.value)}
                className="rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                style={{ backgroundColor: '#0f172a', border: '1px solid #334155', color: '#f8fafc' }}
              />
              <span style={{ color: '#94a3b8' }}>~</span>
              <input
                type="date"
                value={endDate}
                onChange={e => handleFilterChange(setEndDate, e.target.value)}
                className="rounded-lg px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500"
                style={{ backgroundColor: '#0f172a', border: '1px solid #334155', color: '#f8fafc' }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Summary row + CSV download */}
      <div className="flex flex-wrap items-center justify-between mb-4 gap-4">
        <div className="flex items-center gap-4">
          <span className="text-sm" style={{ color: '#94a3b8' }}>
            {t(language, 'table.showing')}{' '}
            <span style={{ color: '#f8fafc', fontWeight: 600 }}>
              {filteredData.length.toLocaleString()}
            </span>{' '}
            {t(language, 'table.of')}{' '}
            <span style={{ color: '#f8fafc', fontWeight: 600 }}>
              {data.dailySales.length.toLocaleString()}
            </span>
          </span>
          <span style={{ color: '#334155' }}>|</span>
          <span className="text-sm" style={{ color: '#94a3b8' }}>
            {t(language, 'table.sales')}:{' '}
            <span style={{ color: '#f8fafc', fontWeight: 600 }}>
              {formatSales(totalFilteredSales, currency, exchangeRate, language)}
            </span>
          </span>
        </div>
        <button
          onClick={downloadCSV}
          className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors hover:opacity-80"
          style={{ backgroundColor: '#3b82f6', color: '#f8fafc' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          {t(language, 'table.download')}
        </button>
      </div>

      {/* Data table */}
      <div
        className="rounded-xl overflow-hidden"
        style={{ backgroundColor: '#1e293b', border: '1px solid #334155' }}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm" style={{ color: '#f8fafc' }}>
            <thead>
              <tr style={{ backgroundColor: '#0f172a' }}>
                <th
                  className="text-left py-3 px-4 font-medium cursor-pointer select-none hover:opacity-80"
                  style={{ color: '#94a3b8' }}
                  onClick={() => handleSort('date')}
                >
                  {t(language, 'table.date')}{sortIcon('date')}
                </th>
                <th
                  className="text-left py-3 px-4 font-medium cursor-pointer select-none hover:opacity-80"
                  style={{ color: '#94a3b8' }}
                  onClick={() => handleSort('title')}
                >
                  {t(language, 'table.title')}{sortIcon('title')}
                </th>
                <th
                  className="text-left py-3 px-4 font-medium cursor-pointer select-none hover:opacity-80"
                  style={{ color: '#94a3b8' }}
                  onClick={() => handleSort('channel')}
                >
                  {t(language, 'table.platform')}{sortIcon('channel')}
                </th>
                <th
                  className="text-right py-3 px-4 font-medium cursor-pointer select-none hover:opacity-80"
                  style={{ color: '#94a3b8' }}
                  onClick={() => handleSort('sales')}
                >
                  {t(language, 'table.sales')}{sortIcon('sales')}
                </th>
              </tr>
            </thead>
            <tbody>
              {pagedData.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-center py-12" style={{ color: '#94a3b8' }}>
                    {language === 'ko' ? '데이터가 없습니다' : 'データがありません'}
                  </td>
                </tr>
              ) : (
                pagedData.map((row, idx) => (
                  <tr
                    key={`${row.date}-${row.titleKR}-${row.channel}-${idx}`}
                    style={{
                      backgroundColor: idx % 2 === 0 ? 'transparent' : '#0f172a',
                      borderBottom: '1px solid #334155',
                    }}
                  >
                    <td className="py-2.5 px-4" style={{ color: '#94a3b8' }}>
                      {row.date}
                    </td>
                    <td className="py-2.5 px-4 max-w-[300px] truncate">
                      {language === 'ko' ? row.titleKR : row.titleJP}
                    </td>
                    <td className="py-2.5 px-4">
                      <span
                        className="inline-block px-2 py-0.5 rounded text-xs font-medium"
                        style={{ backgroundColor: '#334155', color: '#f8fafc' }}
                      >
                        {row.channel}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-right font-medium">
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
            className="flex items-center justify-between py-3 px-4"
            style={{ borderTop: '1px solid #334155', backgroundColor: '#0f172a' }}
          >
            <span className="text-xs" style={{ color: '#94a3b8' }}>
              {page * PAGE_SIZE + 1}~{Math.min((page + 1) * PAGE_SIZE, sortedData.length)}{' '}
              / {sortedData.length.toLocaleString()}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage(p => Math.max(0, p - 1))}
                disabled={page === 0}
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
                style={{ backgroundColor: '#334155', color: '#f8fafc' }}
              >
                {language === 'ko' ? '이전' : '前へ'}
              </button>
              <span className="text-xs px-2" style={{ color: '#94a3b8' }}>
                {page + 1} / {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
                style={{ backgroundColor: '#334155', color: '#f8fafc' }}
              >
                {language === 'ko' ? '다음' : '次へ'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
