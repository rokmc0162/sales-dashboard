// 채널명 정규화: DB에서 소문자 채널을 대문자로 UPDATE
import { config } from 'dotenv';
import * as path from 'node:path';
import { createClient } from '@supabase/supabase-js';

config({ path: path.resolve(import.meta.dirname, '..', '.env.local') });

const SUPABASE_URL = process.env.VITE_SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_KEY in .env.local');
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CHANNEL_FIXES: Record<string, string> = {
  'piccoma': 'Piccoma',
  'cmoa': 'CMOA',
  'mechacomic': 'Mechacomic',
  'renta': 'Renta',
  'dmm': 'DMM',
  'u-next': 'U-NEXT',
};

// 작품명 정규화 함수
function normalizeTitle(title: string): string {
  return title
    .replace(/\s+/g, ' ')           // 연속 공백 → 1개
    .replace(/\s+\[/g, '[')         // " [" → "["
    .replace(/［/g, '[')            // 전각→반각 괄호
    .replace(/］/g, ']')
    .trim();
}

async function main() {
  // 1. 채널명 수정
  console.log('=== 채널명 정규화 ===');
  for (const [from, to] of Object.entries(CHANNEL_FIXES)) {
    const { count } = await supabase
      .from('daily_sales_v2')
      .update({ channel: to }, { count: 'exact' })
      .eq('channel', from);
    console.log(`  ${from} → ${to}: ${count ?? 0}행`);
  }

  // 2. 작품명 정규화 (공백/괄호)
  console.log('\n=== 작품명 정규화 ===');
  let offset = 0;
  const pageSize = 1000;
  const allTitleSet = new Set<string>();

  // paginate to get all unique titles
  while (true) {
    const { data: batch } = await supabase
      .from('daily_sales_v2')
      .select('title_jp')
      .range(offset, offset + pageSize - 1);
    if (!batch || batch.length === 0) break;
    for (const r of batch) allTitleSet.add(r.title_jp);
    if (batch.length < pageSize) break;
    offset += pageSize;
  }

  const uniqueTitles = [...allTitleSet];
  console.log(`  고유 작품명: ${uniqueTitles.length}건`);
  let fixed = 0;
  for (const original of uniqueTitles) {
    const normalized = normalizeTitle(original);
    if (normalized !== original) {
      const { count } = await supabase
        .from('daily_sales_v2')
        .update({ title_jp: normalized }, { count: 'exact' })
        .eq('title_jp', original);
      console.log(`  "${original}" → "${normalized}" (${count}행)`);
      fixed++;
    }
  }
  console.log(`작품명 수정: ${fixed}건`);

  // 3. 검증
  console.log('\n=== 검증 ===');
  // 소문자 채널 잔존 확인
  for (const from of Object.keys(CHANNEL_FIXES)) {
    const { count } = await supabase
      .from('daily_sales_v2')
      .select('*', { count: 'exact', head: true })
      .eq('channel', from);
    console.log(`  ${from} 잔존: ${count ?? 0}건`);
  }

  // 현재 채널 목록 출력
  const { data: channelList } = await supabase
    .from('daily_sales_v2')
    .select('channel')
    .limit(10000);
  if (channelList) {
    const channels = [...new Set(channelList.map(r => r.channel))].sort();
    console.log(`\n현재 채널 목록: ${channels.join(', ')}`);
  }

  console.log('\n완료!');
}

main().catch(console.error);
