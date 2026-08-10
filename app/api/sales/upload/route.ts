import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { normalizeChannel } from '@/utils/platformConfig';
import { buildTitleKrMaps, matchTitleKr } from '@/utils/titleMatcher';
import { requireGlobalAdminAuth } from '@/lib/global-admin-auth.server';
import { readBoundedJson } from '@/lib/auth-route.server';

export const dynamic = 'force-dynamic';

/**
 * POST /api/sales/upload
 * 매출 데이터 업로드 (upsert_daily_sales RPC 사용, 500건씩 배치 처리)
 * 채널명을 서버 사이드에서 강제 정규화하여 중복 방지
 */
export async function POST(request: Request) {
  const unauthorized = await requireGlobalAdminAuth(request);
  if (unauthorized) return unauthorized;
  let body: unknown;
  try {
    body = await readBoundedJson(request, 12 * 1024 * 1024);
  } catch {
    return NextResponse.json({ error: 'invalid or oversized JSON body' }, { status: 413 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }
  const { rows, source, isPreliminary, isLastBatch = true, skipPostProcess = false, isFirstBatch = true } = body as Record<string, unknown>;
  const sourceValue = typeof source === 'string' && source.length <= 100 ? source : 'manual';
  const preliminary = isPreliminary === true;
  const lastBatch = isLastBatch !== false;
  const skipProcessing = skipPostProcess === true;
  const firstBatch = isFirstBatch !== false;

  if (!rows || !Array.isArray(rows)) {
    return NextResponse.json({ error: 'rows array is required' }, { status: 400 });
  }

  // title_master 로드 (title_kr 매칭 + 신규 작품 등록용)
  const { data: masterData } = await supabaseServer.from('titles').select('title_jp, title_kr, genre_id, production_company_id, content_format');
  const maps = buildTitleKrMaps(masterData ?? []);

  // 채널명 정규화 + title_kr 자동 매칭
  const normalizedRows: Record<string, unknown>[] = rows.map((row: Record<string, unknown>) => {
    const titleJp = String(row.title_jp || '');
    const existingKr = row.title_kr ? String(row.title_kr) : '';
    const matchedKr = existingKr || matchTitleKr(titleJp, maps);
    return {
      ...row,
      channel: normalizeChannel(String(row.channel || '')),
      title_kr: matchedKr,
    };
  });

  // 누적형 데이터 소스(cmoa Excel 등): 첫 번째 배치에서만 기존 데이터 삭제
  const cumulativeSources = ['sokuhochi_cmoa_excel', 'sokuhochi_cmoa'];
  if (cumulativeSources.includes(sourceValue) && firstBatch) {
    // 업로드 데이터의 날짜 범위 파악
    const dates = normalizedRows
      .map((r: Record<string, unknown>) => String(r.sale_date || ''))
      .filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
    if (dates.length > 0) {
      const minDate = dates[0];
      const maxDate = dates[dates.length - 1];
      const channel = normalizedRows[0]?.channel ? String(normalizedRows[0].channel) : '';
      if (channel) {
        await supabaseServer
          .from('daily_sales_v2')
          .delete()
          .eq('channel', channel)
          .eq('data_source', sourceValue)
          .gte('sale_date', minDate)
          .lte('sale_date', maxDate);
      }
    }
  }

  // ── 소스 간 중복 처리 (우선순위: weekly_report > sokuhochi) ──
  let dedupAction = '';
  let dedupCount = 0;

  const dates = normalizedRows
    .map((r: Record<string, unknown>) => String(r.sale_date || ''))
    .filter((d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d))
    .sort();
  const minDate = dates[0] || '';
  const maxDate = dates[dates.length - 1] || '';

  if (sourceValue === 'weekly_report' && firstBatch && minDate) {
    // Weekly Report 업로드 → 겹치는 속보치 데이터 삭제
    const { count } = await supabaseServer
      .from('daily_sales_v2')
      .delete({ count: 'exact' })
      .neq('data_source', 'weekly_report')
      .gte('sale_date', minDate)
      .lte('sale_date', maxDate);
    if (count && count > 0) {
      dedupAction = 'replaced_sokuhochi';
      dedupCount = count;
      console.log(`[dedup] weekly_report uploaded: deleted ${count} overlapping sokuhochi rows (${minDate}~${maxDate})`);
    }
  } else if (sourceValue.startsWith('sokuhochi') && firstBatch && minDate) {
    // 속보치 업로드 → 이미 weekly_report가 있는 날짜의 행 제거 (업로드 전)
    const { data: existingWR } = await supabaseServer
      .from('daily_sales_v2')
      .select('title_jp, channel, sale_date')
      .eq('data_source', 'weekly_report')
      .gte('sale_date', minDate)
      .lte('sale_date', maxDate);

    if (existingWR && existingWR.length > 0) {
      const wrKeys = new Set(existingWR.map((r: Record<string, string>) => `${r.title_jp}\0${r.channel}\0${r.sale_date}`));
      const before = normalizedRows.length;
      // 이미 weekly_report에 있는 행은 업로드 대상에서 제외
      const filtered = normalizedRows.filter((r: Record<string, unknown>) => {
        const key = `${r.title_jp}\0${r.channel}\0${r.sale_date}`;
        return !wrKeys.has(key);
      });
      dedupCount = before - filtered.length;
      if (dedupCount > 0) {
        dedupAction = 'skipped_existing_wr';
        normalizedRows.length = 0;
        normalizedRows.push(...filtered);
        console.log(`[dedup] sokuhochi uploaded: skipped ${dedupCount} rows already in weekly_report (${minDate}~${maxDate})`);
      }
    }
  }

  // 같은 (title_jp, channel, sale_date) 키가 배치 안에 중복되면
  // PostgreSQL ON CONFLICT DO UPDATE가 거부하므로 사전 합산
  const deduped = (() => {
    const map = new Map<string, Record<string, unknown>>();
    for (const row of normalizedRows) {
      const key = `${row.title_jp}\0${row.channel}\0${row.sale_date}`;
      const existing = map.get(key);
      if (existing) {
        existing.sales_amount = (Number(existing.sales_amount) || 0) + (Number(row.sales_amount) || 0);
        if (row.sales_amount_gross) {
          existing.sales_amount_gross = (Number(existing.sales_amount_gross) || 0) + (Number(row.sales_amount_gross) || 0);
        }
        if (!existing.title_kr && row.title_kr) existing.title_kr = row.title_kr;
      } else {
        map.set(key, { ...row });
      }
    }
    return [...map.values()];
  })();

  let totalInserted = 0;
  let totalUpdated = 0;
  const batchSize = 500;

  for (let i = 0; i < deduped.length; i += batchSize) {
    const batch = deduped.slice(i, i + batchSize);
    const { data, error } = await supabaseServer.rpc('upsert_daily_sales', {
      p_rows: batch,
      p_source: sourceValue,
      p_is_preliminary: preliminary,
    });

    if (error) {
      return NextResponse.json(
        { error: error.message, processedSoFar: { inserted: totalInserted, updated: totalUpdated } },
        { status: 500 },
      );
    }

    if (data) {
      totalInserted += data.inserted || 0;
      totalUpdated += data.updated || 0;
    }
  }

  // 후처리(신규 작품 등록 + MV 갱신)는 마지막 배치 또는 단일 배치에서만 수행
  if (lastBatch && !skipProcessing) {
    // 신규 작품 자동 등록
    try {
      const uploadedTitles = [...new Set(normalizedRows.map((r: Record<string, unknown>) => String(r.title_jp)))];
      const existingSet = new Set((masterData ?? []).map((m: { title_jp: string }) => m.title_jp));
      const newTitles = uploadedTitles.filter(t => !existingSet.has(t));

      if (newTitles.length > 0) {
        const { extractBaseTitle } = await import('@/lib/supabase');
        const { toCore } = await import('@/utils/titleMatcher');
        const originByBase = new Map<string, { genre_id: number | null; production_company_id: number | null; content_format: string }>();
        const originByCore = new Map<string, { genre_id: number | null; production_company_id: number | null; content_format: string }>();
        (masterData ?? []).forEach((m: Record<string, unknown>) => {
          const info = { genre_id: (m.genre_id as number | null) ?? null, production_company_id: (m.production_company_id as number | null) ?? null, content_format: String(m.content_format || 'WEBTOON') };
          const b = extractBaseTitle(String(m.title_jp));
          if (!originByBase.has(b)) originByBase.set(b, info);
          const c = toCore(String(m.title_jp));
          if (c && !originByCore.has(c)) originByCore.set(c, info);
        });

        for (const titleJp of newTitles) {
          const origin = originByBase.get(extractBaseTitle(titleJp)) || originByCore.get(toCore(titleJp));
          const titleKr = matchTitleKr(titleJp, maps);
          await supabaseServer.from('titles').insert({
            title_jp: titleJp,
            title_kr: titleKr || null,
            genre_id: origin?.genre_id || null,
            production_company_id: origin?.production_company_id || null,
            content_format: origin?.content_format || 'WEBTOON',
            is_active: true,
          }).then(() => {});
        }
      }
    } catch { /* 무시 */ }

    // Materialized View 갱신
    try {
      const { error: mvError } = await supabaseServer.rpc('refresh_materialized_views');
      if (mvError) console.error('MV refresh failed:', mvError.message);
    } catch (e) {
      console.error('MV refresh exception:', e);
    }
  }

  return NextResponse.json({
    inserted: totalInserted,
    updated: totalUpdated,
    ...(dedupCount > 0 && { dedup: { action: dedupAction, count: dedupCount } }),
  });
}
