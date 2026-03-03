import { createClient } from '@supabase/supabase-js';
import type {
  DailySale,
  MonthlySummary,
  TitleSummary,
  PlatformSummary,
  TitleMaster,
} from '@/types';
import type { ConvertedData } from '@/utils/excelConverter';

/* ------------------------------------------------------------------ */
/*  Client                                                             */
/* ------------------------------------------------------------------ */

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** true when Supabase env vars are configured */
export const isSupabaseConfigured = !!(SUPABASE_URL && SUPABASE_ANON_KEY);

const supabase = isSupabaseConfigured
  ? createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!)
  : null;

/* ------------------------------------------------------------------ */
/*  DB row types (snake_case)                                          */
/* ------------------------------------------------------------------ */

interface DbDailySale {
  title_kr: string;
  title_jp: string;
  channel: string;
  date: string;
  sales: number;
}

interface DbMonthlySummary {
  month: string;
  total_sales: number;
  platforms: Record<string, number>;
}

interface DbTitleSummary {
  title_kr: string;
  title_jp: string;
  series_name: string;
  total_sales: number;
  platforms: { name: string; sales: number }[];
  daily_avg: number;
  peak_date: string;
  peak_sales: number;
  first_date: string;
  last_date: string;
  monthly_trend: { month: string; sales: number }[];
}

interface DbPlatformSummary {
  platform: string;
  total_sales: number;
  title_count: number;
  monthly_trend: { month: string; sales: number }[];
  top_titles: { titleKR: string; titleJP: string; sales: number }[];
}

interface DbTitleMaster {
  title_kr: string;
  title_jp: string;
  series_name: string;
  platforms: string[];
}

/* ------------------------------------------------------------------ */
/*  Helper: paginated fetch (Supabase caps at 1 000 rows per request)  */
/* ------------------------------------------------------------------ */

async function fetchAllRows<T>(
  table: string,
  select: string,
  dsId: string,
  orderCol: string,
  ascending: boolean,
): Promise<T[]> {
  if (!supabase) return [];
  const PAGE_SIZE = 1000;
  const allRows: T[] = [];
  let from = 0;

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .eq('dataset_id', dsId)
      .order(orderCol, { ascending })
      .range(from, from + PAGE_SIZE - 1);

    if (error || !data || data.length === 0) break;
    allRows.push(...(data as T[]));
    if (data.length < PAGE_SIZE) break; // last page
    from += PAGE_SIZE;
  }

  return allRows;
}

/* ------------------------------------------------------------------ */
/*  Cached active dataset ID (set during fetchActiveDataset)            */
/* ------------------------------------------------------------------ */

let _activeDatasetId: string | null = null;

/** Return the cached active dataset ID (set after first fetchActiveDataset call) */
export function getActiveDatasetId(): string | null {
  return _activeDatasetId;
}

/* ------------------------------------------------------------------ */
/*  Read: fetch active dataset (summaries only — dailySales lazy)       */
/* ------------------------------------------------------------------ */

export async function fetchActiveDataset(): Promise<ConvertedData | null> {
  if (!supabase) return null;

  // 1. Get active dataset ID
  const { data: dataset } = await supabase
    .from('datasets')
    .select('id')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (!dataset) return null;
  const dsId = dataset.id as string;
  _activeDatasetId = dsId;

  // 2. Fetch summary tables only (daily_sales loaded on-demand for speed)
  const [monthlyRes, titleRes, platformRes, masterRes] =
    await Promise.all([
      supabase
        .from('monthly_summary')
        .select('month, total_sales, platforms')
        .eq('dataset_id', dsId)
        .order('month', { ascending: true }),
      supabase
        .from('title_summary')
        .select('title_kr, title_jp, series_name, total_sales, platforms, daily_avg, peak_date, peak_sales, first_date, last_date, monthly_trend')
        .eq('dataset_id', dsId)
        .order('total_sales', { ascending: false }),
      supabase
        .from('platform_summary')
        .select('platform, total_sales, title_count, monthly_trend, top_titles')
        .eq('dataset_id', dsId)
        .order('total_sales', { ascending: false }),
      supabase
        .from('title_master')
        .select('title_kr, title_jp, series_name, platforms')
        .eq('dataset_id', dsId),
    ]);

  // 3. Map snake_case → camelCase (dailySales left empty — loaded on-demand)
  const dailySales: DailySale[] = [];

  const monthlySummary: MonthlySummary[] = ((monthlyRes.data ?? []) as DbMonthlySummary[]).map((r) => ({
    month: r.month,
    totalSales: r.total_sales,
    platforms: r.platforms,
  }));

  const titleSummary: TitleSummary[] = ((titleRes.data ?? []) as DbTitleSummary[]).map((r) => ({
    titleKR: r.title_kr,
    titleJP: r.title_jp,
    seriesName: r.series_name,
    totalSales: r.total_sales,
    platforms: r.platforms,
    dailyAvg: r.daily_avg,
    peakDate: r.peak_date,
    peakSales: r.peak_sales,
    firstDate: r.first_date,
    lastDate: r.last_date,
    monthlyTrend: r.monthly_trend,
  }));

  const platformSummary: PlatformSummary[] = ((platformRes.data ?? []) as DbPlatformSummary[]).map((r) => ({
    platform: r.platform,
    totalSales: r.total_sales,
    titleCount: r.title_count,
    monthlyTrend: r.monthly_trend,
    topTitles: r.top_titles,
  }));

  const titleMaster: TitleMaster[] = ((masterRes.data ?? []) as DbTitleMaster[]).map((r) => ({
    titleKR: r.title_kr,
    titleJP: r.title_jp,
    seriesName: r.series_name,
    platforms: r.platforms,
  }));

  return { dailySales, monthlySummary, titleSummary, platformSummary, titleMaster };
}

/* ------------------------------------------------------------------ */
/*  Read: paginated daily_sales (server-side filter/sort)               */
/* ------------------------------------------------------------------ */

export interface DailySalesPageParams {
  page: number;
  pageSize: number;
  platform?: string;
  search?: string;
  startDate?: string;
  endDate?: string;
  sortKey?: 'date' | 'title' | 'channel' | 'sales';
  sortDir?: 'asc' | 'desc';
}

export async function fetchDailySalesPage(
  params: DailySalesPageParams,
): Promise<{ data: DailySale[]; count: number }> {
  if (!supabase || !_activeDatasetId) return { data: [], count: 0 };

  const {
    page, pageSize,
    platform, search, startDate, endDate,
    sortKey = 'date', sortDir = 'desc',
  } = params;

  // Map UI sort keys to DB columns
  const orderCol =
    sortKey === 'title' ? 'title_kr' :
    sortKey === 'channel' ? 'channel' :
    sortKey === 'sales' ? 'sales' : 'date';

  let query = supabase
    .from('daily_sales')
    .select('title_kr, title_jp, channel, date, sales', { count: 'exact' })
    .eq('dataset_id', _activeDatasetId);

  // Filters
  if (platform) query = query.eq('channel', platform);
  if (startDate) query = query.gte('date', startDate);
  if (endDate) query = query.lte('date', endDate);
  if (search) {
    query = query.or(`title_kr.ilike.%${search}%,title_jp.ilike.%${search}%`);
  }

  // Sort + pagination
  query = query
    .order(orderCol, { ascending: sortDir === 'asc' })
    .range(page * pageSize, (page + 1) * pageSize - 1);

  const { data, count, error } = await query;

  if (error || !data) return { data: [], count: 0 };

  const mapped: DailySale[] = (data as DbDailySale[]).map((r) => ({
    titleKR: r.title_kr,
    titleJP: r.title_jp,
    channel: r.channel,
    date: r.date,
    sales: r.sales,
  }));

  return { data: mapped, count: count ?? 0 };
}

/* ------------------------------------------------------------------ */
/*  Read: fetch ALL daily_sales (for PeriodAnalysis, CSV, uploads)      */
/* ------------------------------------------------------------------ */

export async function fetchAllDailySales(dsId?: string): Promise<DailySale[]> {
  const id = dsId ?? _activeDatasetId;
  if (!supabase || !id) return [];

  const rows = await fetchAllRows<DbDailySale>(
    'daily_sales',
    'title_kr, title_jp, channel, date, sales',
    id,
    'date',
    true,
  );

  return rows.map((r) => ({
    titleKR: r.title_kr,
    titleJP: r.title_jp,
    channel: r.channel,
    date: r.date,
    sales: r.sales,
  }));
}

/* ------------------------------------------------------------------ */
/*  Write: upload dataset to Supabase                                  */
/* ------------------------------------------------------------------ */

const BATCH_SIZE = 1000;

export async function uploadDatasetToSupabase(
  data: ConvertedData,
  name: string = 'upload',
): Promise<{ success: boolean; error?: string }> {
  if (!supabase) return { success: false, error: 'Supabase not configured' };

  try {
    // 1. Create dataset record (inactive until all inserts succeed)
    const { data: dataset, error: dsError } = await supabase
      .from('datasets')
      .insert({ name, row_count: data.dailySales.length, is_active: false })
      .select('id')
      .single();

    if (dsError || !dataset) {
      return { success: false, error: dsError?.message ?? 'Failed to create dataset' };
    }
    const dsId = dataset.id as string;

    // 2. Insert daily_sales in batches
    for (let i = 0; i < data.dailySales.length; i += BATCH_SIZE) {
      const batch = data.dailySales.slice(i, i + BATCH_SIZE).map((r) => ({
        title_kr: r.titleKR,
        title_jp: r.titleJP,
        channel: r.channel,
        date: r.date,
        sales: r.sales,
        dataset_id: dsId,
      }));
      const { error } = await supabase.from('daily_sales').insert(batch);
      if (error) throw error;
    }

    // 3. Insert summary tables (small, single batch each)
    const { error: monthlyErr } = await supabase.from('monthly_summary').insert(
      data.monthlySummary.map((r) => ({
        month: r.month,
        total_sales: r.totalSales,
        platforms: r.platforms,
        dataset_id: dsId,
      })),
    );
    if (monthlyErr) throw monthlyErr;

    const { error: titleErr } = await supabase.from('title_summary').insert(
      data.titleSummary.map((r) => ({
        title_kr: r.titleKR,
        title_jp: r.titleJP,
        series_name: r.seriesName,
        total_sales: r.totalSales,
        platforms: r.platforms,
        daily_avg: r.dailyAvg,
        peak_date: r.peakDate,
        peak_sales: r.peakSales,
        first_date: r.firstDate,
        last_date: r.lastDate,
        monthly_trend: r.monthlyTrend,
        dataset_id: dsId,
      })),
    );
    if (titleErr) throw titleErr;

    const { error: platErr } = await supabase.from('platform_summary').insert(
      data.platformSummary.map((r) => ({
        platform: r.platform,
        total_sales: r.totalSales,
        title_count: r.titleCount,
        monthly_trend: r.monthlyTrend,
        top_titles: r.topTitles,
        dataset_id: dsId,
      })),
    );
    if (platErr) throw platErr;

    const { error: masterErr } = await supabase.from('title_master').insert(
      data.titleMaster.map((r) => ({
        title_kr: r.titleKR,
        title_jp: r.titleJP,
        series_name: r.seriesName,
        platforms: r.platforms,
        dataset_id: dsId,
      })),
    );
    if (masterErr) throw masterErr;

    // 4. Deactivate old datasets, activate new one
    await supabase
      .from('datasets')
      .update({ is_active: false })
      .neq('id', dsId);

    await supabase
      .from('datasets')
      .update({ is_active: true })
      .eq('id', dsId);

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
