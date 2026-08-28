export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { supabaseServer } from '@/lib/supabase-server';
import { requireApiAuth } from "@/lib/api-auth";

/**
 * GET /api/manage/audit-logs
 * 감사 로그 페이지네이션 조회 (액션, 테이블 필터 지원)
 * @param page — 페이지 번호 (기본 1)
 * @param limit — 페이지 크기 (기본 50, 최대 200)
 * @param action — 액션 필터 (INSERT/UPDATE/DELETE, 선택)
 * @param table — 테이블명 필터 (선택)
 * @returns { rows: AuditLog[], count: number }
 * @dynamic force-dynamic (캐시 없음)
 */
export async function GET(request: Request) {
  const unauthorized = await requireApiAuth(request, { role: "ADMIN" });
  if (unauthorized) return unauthorized;

  const { searchParams } = new URL(request.url);
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
  const limit = Math.min(200, Math.max(1, parseInt(searchParams.get('limit') || '50', 10)));
  const action = searchParams.get('action') || '';
  const tableName = searchParams.get('table') || '';

  const from = (page - 1) * limit;
  const to = from + limit - 1;

  let query = supabaseServer
    .from('audit_logs')
    .select('*', { count: 'exact' });

  if (action) query = query.eq('action', action);
  if (tableName) query = query.eq('table_name', tableName);

  query = query.order('created_at', { ascending: false });
  query = query.range(from, to);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data, count });
}
