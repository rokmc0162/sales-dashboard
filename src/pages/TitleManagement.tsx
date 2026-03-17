import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { Download, Search, FileSpreadsheet } from 'lucide-react';
import { useDataLoader } from '@/hooks/useDataLoader';
import { useAppState } from '@/hooks/useAppState';
import { formatSales } from '@/utils/formatters';
import { exportTitlesToXlsx } from '@/utils/titleExporter';
import { BilingualTitle } from '@/components/BilingualTitle';
import { ContentTypeBadge } from '@/components/ContentTypeBadge';
import { PlatformIcon } from '@/components/PlatformIcon';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@/components/ui/table';
import { staggerContainer, staggerItem } from '@/lib/constants';
import type { ContentType } from '@/types';

type SortKey = 'name' | 'sales' | 'platforms' | 'type';
type SortDir = 'asc' | 'desc';

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-10 w-64" />
      <Card variant="glass"><CardContent className="p-6">
        <div className="flex flex-wrap gap-4">
          <Skeleton className="h-10 w-40" /><Skeleton className="h-10 flex-1 min-w-[200px]" />
        </div>
      </CardContent></Card>
      <Card variant="glass"><CardContent className="p-0">
        <Skeleton className="h-10 w-full" />
        {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}
      </CardContent></Card>
    </div>
  );
}

export function TitleManagement() {
  const data = useDataLoader();
  const { language, currency, exchangeRate } = useAppState();

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<ContentType | ''>('');
  const [exclusiveFilter, setExclusiveFilter] = useState<'' | 'exclusive' | 'nonExclusive'>('');
  const [sortKey, setSortKey] = useState<SortKey>('sales');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const filteredTitles = useMemo(() => {
    let titles = [...data.titleSummary];

    // Search
    if (search.trim()) {
      const q = search.toLowerCase();
      titles = titles.filter(
        t => t.titleKR.toLowerCase().includes(q) || t.titleJP.toLowerCase().includes(q),
      );
    }

    // Content type filter
    if (typeFilter) {
      titles = titles.filter(t => t.contentType === typeFilter);
    }

    // Exclusive filter
    if (exclusiveFilter === 'exclusive') {
      titles = titles.filter(t => t.platforms.length === 1);
    } else if (exclusiveFilter === 'nonExclusive') {
      titles = titles.filter(t => t.platforms.length > 1);
    }

    // Sort
    titles.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'name':
          cmp = (language === 'ko' ? a.titleKR : a.titleJP).localeCompare(
            language === 'ko' ? b.titleKR : b.titleJP,
          );
          break;
        case 'sales':
          cmp = a.totalSales - b.totalSales;
          break;
        case 'platforms':
          cmp = a.platforms.length - b.platforms.length;
          break;
        case 'type':
          cmp = (a.contentType || 'UNKNOWN').localeCompare(b.contentType || 'UNKNOWN');
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return titles;
  }, [data.titleSummary, search, typeFilter, exclusiveFilter, sortKey, sortDir, language]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return ' ↕';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  };

  const handleExport = () => {
    const dateStr = new Date().toISOString().substring(0, 10);
    exportTitlesToXlsx(
      filteredTitles,
      language,
      `rvjp_title_management_${dateStr}.xlsx`,
    );
  };

  if (data.loading) return <LoadingSkeleton />;

  return (
    <motion.div initial="hidden" animate="show" variants={staggerContainer}>
      {/* Page title */}
      <motion.div variants={staggerItem} className="flex items-center justify-between mb-6 flex-wrap gap-4">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold text-primary tracking-tight">
            {language === 'ko' ? '작품 관리' : '作品管理'}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {language === 'ko'
              ? '전체 작품 정보 관리 및 내보내기'
              : '全作品情報管理・エクスポート'}
          </p>
        </div>
        <Button onClick={handleExport} className="gap-2">
          <Download size={16} />
          {language === 'ko' ? 'Excel 내보내기' : 'Excelエクスポート'}
        </Button>
      </motion.div>

      {/* Filters */}
      <motion.div variants={staggerItem} className="mb-6">
        <Card variant="glass">
          <CardContent className="p-5">
            <div className="flex flex-wrap items-end gap-4">
              {/* Search */}
              <div className="flex flex-col gap-1.5 flex-1 min-w-[200px]">
                <label className="text-xs font-semibold text-muted-foreground">
                  {language === 'ko' ? '작품 검색' : '作品検索'}
                </label>
                <div className="relative">
                  <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder={language === 'ko' ? '작품명 검색...' : '作品名検索...'}
                    className="pl-9 h-9 rounded-lg text-sm"
                  />
                </div>
              </div>

              {/* Content type filter */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-muted-foreground">
                  {language === 'ko' ? '콘텐츠 유형' : 'コンテンツ形式'}
                </label>
                <Select
                  value={typeFilter}
                  onChange={e => setTypeFilter(e.target.value as ContentType | '')}
                  className="h-9 text-sm min-w-[120px] rounded-lg"
                >
                  <option value="">{language === 'ko' ? '전체' : '全体'}</option>
                  <option value="WT">{language === 'ko' ? '웹툰 (WT)' : 'WEBTOON (WT)'}</option>
                  <option value="EP">{language === 'ko' ? '화별 (EP)' : '話別 (EP)'}</option>
                  <option value="EB">{language === 'ko' ? '권별 (EB)' : '巻別 (EB)'}</option>
                </Select>
              </div>

              {/* Exclusive filter */}
              <div className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-muted-foreground">
                  {language === 'ko' ? '독점 여부' : '独占'}
                </label>
                <Select
                  value={exclusiveFilter}
                  onChange={e => setExclusiveFilter(e.target.value as '' | 'exclusive' | 'nonExclusive')}
                  className="h-9 text-sm min-w-[120px] rounded-lg"
                >
                  <option value="">{language === 'ko' ? '전체' : '全体'}</option>
                  <option value="exclusive">{language === 'ko' ? '독점' : '独占'}</option>
                  <option value="nonExclusive">{language === 'ko' ? '비독점' : '非独占'}</option>
                </Select>
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Summary */}
      <motion.div variants={staggerItem} className="flex items-center gap-4 mb-4 text-sm text-muted-foreground">
        <span>
          {language === 'ko' ? '검색 결과: ' : '検索結果: '}
          <span className="font-bold text-foreground">{filteredTitles.length}</span>
          {language === 'ko' ? '개 작품' : '作品'}
        </span>
        <span className="text-border">|</span>
        <span>
          {language === 'ko' ? '총 매출: ' : '総売上: '}
          <span className="font-bold text-foreground">
            {formatSales(
              filteredTitles.reduce((s, t) => s + t.totalSales, 0),
              currency,
              exchangeRate,
              language,
            )}
          </span>
        </span>
      </motion.div>

      {/* Table */}
      <motion.div variants={staggerItem}>
        <Card variant="glass">
          <CardContent className="p-0">
            <Table className="text-sm">
              <TableHeader>
                <TableRow className="bg-muted hover:bg-muted">
                  <TableHead
                    className="font-semibold cursor-pointer select-none hover:text-foreground transition-colors"
                    onClick={() => handleSort('name')}
                  >
                    {language === 'ko' ? '작품명' : '作品名'}{sortIcon('name')}
                  </TableHead>
                  <TableHead
                    className="font-semibold cursor-pointer select-none hover:text-foreground transition-colors"
                    onClick={() => handleSort('type')}
                  >
                    {language === 'ko' ? '유형' : '形式'}{sortIcon('type')}
                  </TableHead>
                  <TableHead
                    className="font-semibold cursor-pointer select-none hover:text-foreground transition-colors"
                    onClick={() => handleSort('platforms')}
                  >
                    {language === 'ko' ? '플랫폼' : 'PF'}{sortIcon('platforms')}
                  </TableHead>
                  <TableHead
                    className="text-right font-semibold cursor-pointer select-none hover:text-foreground transition-colors"
                    onClick={() => handleSort('sales')}
                  >
                    {language === 'ko' ? '총매출' : '総売上'}{sortIcon('sales')}
                  </TableHead>
                  <TableHead className="font-semibold text-center">
                    {language === 'ko' ? '독점' : '独占'}
                  </TableHead>
                  <TableHead className="font-semibold">
                    {language === 'ko' ? '기간' : '期間'}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTitles.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-16 text-muted-foreground">
                      <FileSpreadsheet size={40} className="mx-auto mb-3 text-border" />
                      <p>{language === 'ko' ? '검색 결과가 없습니다' : '検索結果がありません'}</p>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredTitles.map((title, idx) => (
                    <TableRow
                      key={title.titleKR}
                      className={idx % 2 === 0 ? 'bg-card' : 'bg-background'}
                    >
                      <TableCell className="max-w-[280px]">
                        <BilingualTitle
                          titleKR={title.titleKR}
                          titleJP={title.titleJP}
                          language={language}
                          variant="inline"
                          className="text-[13px]"
                        />
                      </TableCell>
                      <TableCell>
                        {title.contentType && title.contentType !== 'UNKNOWN' ? (
                          <ContentTypeBadge type={title.contentType} language={language} size="md" />
                        ) : (
                          <span className="text-muted-foreground text-xs">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          {title.platforms.slice(0, 4).map((p, i) => (
                            <PlatformIcon key={i} name={p.name} size={18} />
                          ))}
                          {title.platforms.length > 4 && (
                            <span className="text-[10px] text-muted-foreground font-bold">
                              +{title.platforms.length - 4}
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-[13px] font-semibold text-foreground">
                        {formatSales(title.totalSales, currency, exchangeRate, language)}
                      </TableCell>
                      <TableCell className="text-center">
                        {title.platforms.length === 1 ? (
                          <Badge variant="default" className="text-[10px]">
                            {language === 'ko' ? '독점' : '独占'}
                          </Badge>
                        ) : (
                          <Badge variant="secondary" className="text-[10px]">
                            {language === 'ko' ? '비독점' : '非独占'}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                        {title.firstDate} ~ {title.lastDate}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </motion.div>
    </motion.div>
  );
}
