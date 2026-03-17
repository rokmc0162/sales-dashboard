import { useState, useEffect, useCallback, useRef } from 'react';
import { motion } from 'framer-motion';
import { useDataLoader } from '@/hooks/useDataLoader';
import { useAppState } from '@/hooks/useAppState';
import { t } from '@/i18n';
import { formatSales } from '@/utils/formatters';
import { PlatformBadge } from '@/components/PlatformIcon';
import { isSupabaseConfigured, fetchDailySalesPage, fetchAllDailySales } from '@/lib/supabase';
import type { DailySale } from '@/types';
import { staggerContainer, staggerItem } from '@/lib/constants';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';

const PAGE_SIZE = 50;

type SortKey = 'date' | 'title' | 'channel' | 'sales';
type SortDir = 'asc' | 'desc';

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 w-64" />
      <Card variant="glass"><CardContent className="p-6">
        <div className="flex flex-wrap gap-4">
          <Skeleton className="h-10 w-40" /><Skeleton className="h-10 flex-1 min-w-[200px]" />
          <div className="flex gap-2"><Skeleton className="h-10 w-36" /><Skeleton className="h-10 w-36" /></div>
        </div>
      </CardContent></Card>
      <div className="flex justify-between"><Skeleton className="h-5 w-64" /><Skeleton className="h-10 w-36" /></div>
      <Card variant="glass"><CardContent className="p-0">
        <Skeleton className="h-10 w-full" />
        {[...Array(10)].map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
        <div className="flex justify-between p-4"><Skeleton className="h-5 w-32" /><div className="flex gap-2"><Skeleton className="h-9 w-16" /><Skeleton className="h-9 w-20" /><Skeleton className="h-9 w-16" /></div></div>
      </CardContent></Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Client-side helpers (used when data is uploaded / static JSON)      */
/* ------------------------------------------------------------------ */

function filterAndSort(
  all: DailySale[],
  platformFilter: string,
  titleSearch: string,
  startDate: string,
  endDate: string,
  sortKey: SortKey,
  sortDir: SortDir,
  language: string,
) {
  let result = all;
  if (startDate) result = result.filter(d => d.date >= startDate);
  if (endDate) result = result.filter(d => d.date <= endDate);
  if (platformFilter) result = result.filter(d => d.channel === platformFilter);
  if (titleSearch.trim()) {
    const q = titleSearch.trim().toLowerCase();
    result = result.filter(d =>
      d.titleKR.toLowerCase().includes(q) || d.titleJP.toLowerCase().includes(q),
    );
  }
  const sorted = [...result].sort((a, b) => {
    let cmp = 0;
    switch (sortKey) {
      case 'date': cmp = a.date.localeCompare(b.date); break;
      case 'title': cmp = (language === 'ko' ? a.titleKR : a.titleJP).localeCompare(language === 'ko' ? b.titleKR : b.titleJP); break;
      case 'channel': cmp = a.channel.localeCompare(b.channel); break;
      case 'sales': cmp = a.sales - b.sales; break;
    }
    return sortDir === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */

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
  // Server-side state (Supabase mode)
  const [serverRows, setServerRows] = useState<DailySale[]>([]);
  const [serverCount, setServerCount] = useState(0);
  const [tableLoading, setTableLoading] = useState(false);
  const [csvDownloading, setCsvDownloading] = useState(false);
  const fetchIdRef = useRef(0); // prevent stale fetches

  // Are we using uploaded/static data (has dailySales in memory) or Supabase server-side?
  const useServerMode = isSupabaseConfigured && !data.isUploaded && data.dailySales.length === 0;

  // Platforms: from platformSummary (always available) or from in-memory dailySales
  const platforms = useServerMode
    ? data.platformSummary.map(p => p.platform).sort()
    : [...new Set(data.dailySales.map(d => d.channel))].sort();

  // Total sales (unfiltered): from platformSummary
  const totalSalesAll = data.platformSummary.reduce((s, p) => s + p.totalSales, 0);

  /* ---- Server-side fetch ---- */
  const fetchPage = useCallback(async () => {
    if (!useServerMode) return;
    const id = ++fetchIdRef.current;
    setTableLoading(true);
    try {
      const result = await fetchDailySalesPage({
        page,
        pageSize: PAGE_SIZE,
        platform: platformFilter || undefined,
        search: titleSearch.trim() || undefined,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        sortKey,
        sortDir,
      });
      if (id === fetchIdRef.current) {
        setServerRows(result.data);
        setServerCount(result.count);
      }
    } finally {
      if (id === fetchIdRef.current) setTableLoading(false);
    }
  }, [useServerMode, page, platformFilter, titleSearch, startDate, endDate, sortKey, sortDir]);

  useEffect(() => { fetchPage(); }, [fetchPage]);

  /* ---- Client-side data (uploaded/static) ---- */
  const clientSorted = useServerMode
    ? []
    : filterAndSort(data.dailySales, platformFilter, titleSearch, startDate, endDate, sortKey, sortDir, language);

  // Unified row data
  const pagedData = useServerMode
    ? serverRows
    : clientSorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const totalCount = useServerMode ? serverCount : clientSorted.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

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

  // Reset page on filter change
  const handleFilterChange = <T,>(setter: React.Dispatch<React.SetStateAction<T>>, value: T) => {
    setter(value);
    setPage(0);
  };

  // CSV download (fetches all matching rows for server mode)
  const downloadCSV = async () => {
    let rows: DailySale[];
    if (useServerMode) {
      setCsvDownloading(true);
      try {
        rows = await fetchAllDailySales();
      } finally {
        setCsvDownloading(false);
      }
    } else {
      rows = clientSorted;
    }

    const header = [t(language, 'table.date'), t(language, 'table.title'), t(language, 'table.platform'), t(language, 'table.sales')];
    const csvRows = rows.map(d => [
      d.date,
      `"${(language === 'ko' ? d.titleKR : d.titleJP).replace(/"/g, '""')}"`,
      d.channel,
      String(d.sales),
    ]);

    const bom = '\uFEFF';
    const csv = bom + [header.join(','), ...csvRows.map(r => r.join(','))].join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `rvjp_sales_data_${new Date().toISOString().substring(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return ' ↕';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  };

  if (data.loading) {
    return <LoadingSkeleton />;
  }

  return (
    <motion.div
      initial="hidden"
      animate="show"
      variants={staggerContainer}
    >
      {/* Page title */}
      <motion.h1
        variants={staggerItem}
        className="font-bold mb-8 text-primary text-[28px] tracking-tight"
      >
        {t(language, 'nav.rawData')}
      </motion.h1>

      {/* Filter controls row */}
      <motion.div variants={staggerItem} className="mb-6">
        <Card variant="glass">
          <CardContent className="p-6">
            <div className="flex flex-wrap items-end gap-5">
              {/* Platform dropdown */}
              <div className="flex flex-col gap-1.5">
                <label className="font-semibold text-text-secondary text-[13px] tracking-wide">
                  {t(language, 'filter.platform')}
                </label>
                <Select
                  value={platformFilter}
                  onChange={e => handleFilterChange(setPlatformFilter, e.target.value)}
                  className="min-w-[160px] h-10 rounded-xl font-medium"
                >
                  <option value="">{t(language, 'filter.allPlatforms')}</option>
                  {platforms.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </Select>
              </div>

              {/* Title search */}
              <div className="flex flex-col gap-1.5 flex-1 min-w-[220px]">
                <label className="font-semibold text-text-secondary text-[13px] tracking-wide">
                  {t(language, 'filter.title')}
                </label>
                <div className="relative">
                  <svg
                    className="absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted"
                    width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  >
                    <circle cx="11" cy="11" r="8" />
                    <line x1="21" y1="21" x2="16.65" y2="16.65" />
                  </svg>
                  <Input
                    type="text"
                    value={titleSearch}
                    onChange={e => handleFilterChange(setTitleSearch, e.target.value)}
                    placeholder={t(language, 'filter.search')}
                    className="w-full rounded-xl pl-10 pr-4 h-10 font-medium"
                  />
                </div>
              </div>

              {/* Date range */}
              <div className="flex flex-col gap-1.5">
                <label className="font-semibold text-text-secondary text-[13px] tracking-wide">
                  {t(language, 'filter.dateRange')}
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    type="date"
                    value={startDate}
                    onChange={e => handleFilterChange(setStartDate, e.target.value)}
                    className="rounded-xl h-10 font-medium"
                  />
                  <span className="text-text-muted text-base font-medium">~</span>
                  <Input
                    type="date"
                    value={endDate}
                    onChange={e => handleFilterChange(setEndDate, e.target.value)}
                    className="rounded-xl h-10 font-medium"
                  />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Summary row + buttons */}
      <motion.div
        variants={staggerItem}
        className="flex flex-wrap items-center justify-between mb-5 gap-4"
      >
        <div className="flex items-center gap-4">
          <span className="text-muted-foreground text-sm font-medium">
            {t(language, 'table.showing')}{' '}
            <span className="text-foreground font-bold text-[15px]">
              {totalCount.toLocaleString()}
            </span>{' '}
            {t(language, 'table.of')}{' '}
            <span className="text-foreground font-bold text-[15px]">
              {useServerMode ? serverCount.toLocaleString() : data.dailySales.length.toLocaleString()}
            </span>
          </span>
          <span className="text-border text-lg">|</span>
          <span className="text-muted-foreground text-sm font-medium">
            {t(language, 'table.sales')}:{' '}
            <span className="text-foreground font-bold text-[15px]">
              {formatSales(totalSalesAll, currency, exchangeRate, language)}
            </span>
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={downloadCSV}
            disabled={csvDownloading}
            className="gap-2.5 px-5 rounded-xl font-semibold shadow-[0_2px_8px_rgba(37,99,235,0.25)] hover:shadow-lg"
          >
            {csvDownloading ? (
              <svg className="animate-spin" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20" />
              </svg>
            ) : (
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
            )}
            {t(language, 'table.download')}
          </Button>
        </div>
      </motion.div>

      {/* Data table */}
      <motion.div variants={staggerItem}>
        <Card variant="glass">
          <CardContent className="p-0 relative">
            {/* Loading overlay for server fetch */}
            {tableLoading && (
              <div className="absolute inset-0 bg-background/60 backdrop-blur-[1px] z-10 flex items-center justify-center">
                <div className="flex items-center gap-3 text-muted-foreground">
                  <svg className="animate-spin" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <circle cx="12" cy="12" r="10" strokeDasharray="60" strokeDashoffset="20" />
                  </svg>
                  <span className="text-sm font-medium">{language === 'ko' ? '로딩 중...' : '読み込み中...'}</span>
                </div>
              </div>
            )}

            <Table className="text-sm">
              <TableHeader>
                <TableRow className="bg-background border-b-2 border-border hover:bg-background">
                  <TableHead
                    className="py-3.5 px-5 font-semibold text-text-secondary cursor-pointer select-none hover:text-foreground transition-colors duration-150"
                    onClick={() => handleSort('date')}
                  >
                    {t(language, 'table.date')}{sortIcon('date')}
                  </TableHead>
                  <TableHead
                    className="py-3.5 px-5 font-semibold text-text-secondary cursor-pointer select-none hover:text-foreground transition-colors duration-150"
                    onClick={() => handleSort('title')}
                  >
                    {t(language, 'table.title')}{sortIcon('title')}
                  </TableHead>
                  <TableHead
                    className="py-3.5 px-5 font-semibold text-text-secondary cursor-pointer select-none hover:text-foreground transition-colors duration-150"
                    onClick={() => handleSort('channel')}
                  >
                    {t(language, 'table.platform')}{sortIcon('channel')}
                  </TableHead>
                  <TableHead
                    className="py-3.5 px-5 text-right font-semibold text-text-secondary cursor-pointer select-none hover:text-foreground transition-colors duration-150"
                    onClick={() => handleSort('sales')}
                  >
                    {t(language, 'table.sales')}{sortIcon('sales')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pagedData.length === 0 && !tableLoading ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center py-16 text-text-muted text-[15px]">
                      {language === 'ko' ? '데이터가 없습니다' : 'データがありません'}
                    </TableCell>
                  </TableRow>
                ) : (
                  pagedData.map((row, idx) => (
                    <TableRow
                      key={`${row.date}-${row.titleKR}-${row.channel}-${idx}`}
                      className={idx % 2 === 0 ? 'bg-card' : 'bg-background'}
                    >
                      <TableCell className="py-3 px-5 font-medium text-muted-foreground">
                        {row.date}
                      </TableCell>
                      <TableCell className="py-3 px-5 max-w-[300px] font-medium text-foreground">
                        <div className="truncate">{language === 'ko' ? row.titleKR : row.titleJP}</div>
                        {row.titleKR !== row.titleJP && (
                          <div className="text-[10px] text-muted-foreground font-normal truncate">
                            {language === 'ko' ? row.titleJP : row.titleKR}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="py-3 px-5">
                        <PlatformBadge name={row.channel} compact />
                      </TableCell>
                      <TableCell className="py-3 px-5 text-right font-bold text-foreground text-[15px]">
                        {formatSales(row.sales, currency, exchangeRate, language)}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-between py-4 px-5 border-t border-border bg-background">
                <span className="text-muted-foreground text-[13px] font-medium">
                  {page * PAGE_SIZE + 1}~{Math.min((page + 1) * PAGE_SIZE, totalCount)}{' '}
                  / {totalCount.toLocaleString()}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPage(p => Math.max(0, p - 1))}
                    disabled={page === 0}
                    className="rounded-xl font-semibold text-[13px]"
                  >
                    {language === 'ko' ? '이전' : '前へ'}
                  </Button>
                  <div className="flex items-center gap-1 px-3 py-2 rounded-xl bg-card border border-border">
                    <span className="text-primary font-bold text-sm">
                      {page + 1}
                    </span>
                    <span className="text-text-muted text-[13px] font-medium">
                      {' / '}{totalPages}
                    </span>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                    disabled={page >= totalPages - 1}
                    className="rounded-xl font-semibold text-[13px]"
                  >
                    {language === 'ko' ? '다음' : '次へ'}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </motion.div>

    </motion.div>
  );
}
