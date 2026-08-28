import { NextRequest, NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { extractBaseTitle, extractProductType } from '@/lib/supabase';
import { requireApiAuth } from "@/lib/api-auth";

export const revalidate = 300;

/**
 * GET /api/sales/title-summaries?start=YYYY-MM-DD&end=YYYY-MM-DD
 * 작품별 매출 요약 조회
 * - start/end 파라미터가 있으면 해당 기간 내 매출만 집계
 * - 없으면 전체 기간 (get_title_summaries RPC → get_top_titles 폴백)
 */
export async function GET(request: NextRequest) {
  const unauthorized = await requireApiAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = request.nextUrl;
  const start = searchParams.get('start');
  const end = searchParams.get('end');

  // 기간 지정 시 직접 쿼리
  if (start && end) {
    const { data, error } = await supabaseServer
      .from('daily_sales_v2')
      .select('title_jp, title_kr, channel, sale_date, sales_amount')
      .gte('sale_date', start)
      .lte('sale_date', end);

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    // 작품별 집계
    const map = new Map<string, {
      title_jp: string;
      title_kr: string;
      channels: Set<string>;
      total_sales: number;
      day_count: Set<string>;
      first_date: string;
    }>();

    for (const row of data ?? []) {
      const existing = map.get(row.title_jp);
      if (existing) {
        existing.total_sales += Number(row.sales_amount);
        existing.channels.add(row.channel);
        existing.day_count.add(row.sale_date);
        if (row.title_kr) existing.title_kr = row.title_kr;
        if (row.sale_date < existing.first_date) existing.first_date = row.sale_date;
      } else {
        map.set(row.title_jp, {
          title_jp: row.title_jp,
          title_kr: row.title_kr ?? '',
          channels: new Set([row.channel]),
          total_sales: Number(row.sales_amount),
          day_count: new Set([row.sale_date]),
          first_date: row.sale_date,
        });
      }
    }

    const result = Array.from(map.values()).map(v => ({
      title_jp: v.title_jp,
      title_kr: v.title_kr,
      channels: Array.from(v.channels),
      total_sales: v.total_sales,
      day_count: v.day_count.size,
      first_date: v.first_date,
    })).sort((a, b) => b.total_sales - a.total_sales);

    return NextResponse.json(enrichWithBaseTitle(result));
  }

  // 전체 기간: 기존 RPC 사용
  const { data, error } = await supabaseServer.rpc('get_title_summaries');

  if (error) {
    const { data: fallback, error: fallbackError } = await supabaseServer.rpc('get_top_titles', {
      p_limit: 1000,
      p_month: null,
    });
    if (fallbackError) return NextResponse.json({ error: fallbackError.message }, { status: 500 });
    return NextResponse.json(enrichWithBaseTitle(fallback));
  }

  return NextResponse.json(enrichWithBaseTitle(data));
}

/** 응답에 base_title, product_type 필드 추가 */
function enrichWithBaseTitle(rows: Array<Record<string, unknown>> | null) {
  if (!rows) return [];
  return rows.map(row => ({
    ...row,
    base_title: extractBaseTitle(String(row.title_jp ?? '')),
    product_type: extractProductType(String(row.title_jp ?? '')),
  }));
}
