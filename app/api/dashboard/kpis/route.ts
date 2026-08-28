import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from "@/lib/api-auth";

export const revalidate = 300;

/**
 * GET /api/dashboard/kpis
 * 대시보드 KPI 데이터 조회 (총매출, 이번달, 전월대비, 활성 작품/플랫폼 수)
 * @returns KPIData — { total_sales, this_month_sales, last_month_sales, mom_change, active_titles, active_platforms }
 * @cache revalidate 300초 (5분)
 */
export async function GET(request: Request) {
  const unauthorized = await requireApiAuth(request);
  if (unauthorized) return unauthorized;

  const { data, error } = await supabaseServer.rpc('get_dashboard_kpis');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
