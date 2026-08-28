import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from "@/lib/api-auth";

export const dynamic = 'force-dynamic';

/**
 * GET /api/sales/all
 * 전체 매출 데이터 조회 (배치 1000건씩 로드, 최대 50000건)
 * @param limit — 최대 조회 건수 (기본 10000, 최대 50000)
 * @returns DailySale[] — 전체 매출 레코드 배열
 * @dynamic force-dynamic (캐시 없음)
 */
export async function GET(request: Request) {
  const unauthorized = await requireApiAuth(request);
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const limit = Math.min(parseInt(searchParams.get('limit') || '200000'), 200000);

  const allRows: Record<string, unknown>[] = [];
  const batchSize = 5000;
  let offset = 0;

  while (allRows.length < limit) {
    const remaining = limit - allRows.length;
    const currentBatch = Math.min(batchSize, remaining);

    const { data, error } = await supabaseServer
      .from('daily_sales_v2')
      .select('*')
      .range(offset, offset + currentBatch - 1)
      .order('sale_date', { ascending: false });

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;

    allRows.push(...data);
    if (data.length < currentBatch) break;
    offset += currentBatch;
  }

  return NextResponse.json(allRows);
}
