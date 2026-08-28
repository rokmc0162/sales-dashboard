import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from "@/lib/api-auth";

export const revalidate = 300;

/**
 * GET /api/dashboard/monthly-trend
 * 월별 매출 추이 조회 (전체 기간 월별 총매출)
 * @returns MonthlyTrendRow[] — { month, total_sales }
 * @cache revalidate 300초 (5분)
 */
export async function GET(request: Request) {
  const unauthorized = await requireApiAuth(request);
  if (unauthorized) return unauthorized;

  const { data, error } = await supabaseServer.rpc('get_monthly_sales_trend');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
