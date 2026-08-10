'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Lock, Mail, Eye, EyeOff, TrendingUp } from 'lucide-react';
import { useAuth } from '@/providers/AuthProvider';

// ---------------------------------------------------------------------------
// 플랫폼 아이콘 목록
// ---------------------------------------------------------------------------
const platformIcons = [
  { src: '/icons/piccoma.png', name: 'Piccoma' },
  { src: '/icons/mechacomic.png', name: 'Mechacomic' },
  { src: '/icons/cmoa.png', name: 'cmoa' },
  { src: '/icons/linemanga.png', name: 'LINEマンガ' },
  { src: '/icons/ebookjapan.jpg', name: 'ebookjapan' },
  { src: '/icons/fanza.png', name: 'FANZA' },
  { src: '/icons/renta.png', name: 'Renta!' },
  { src: '/icons/unext.png', name: 'U-NEXT' },
  { src: '/icons/dmm.png', name: 'DMM' },
  { src: '/icons/mangaoukoku.jpeg', name: 'まんが王国' },
];

// 3열: 각 열에 전체 아이콘을 섞어서 배치, 3세트 반복 (빈 공간 방지)
const shuffle = (arr: typeof platformIcons, seed: number) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = (i * seed + 3) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const col1 = [...shuffle(platformIcons, 7), ...shuffle(platformIcons, 7), ...shuffle(platformIcons, 7)];
const col2 = [...shuffle(platformIcons, 13), ...shuffle(platformIcons, 13), ...shuffle(platformIcons, 13)];
const col3 = [...shuffle(platformIcons, 19), ...shuffle(platformIcons, 19), ...shuffle(platformIcons, 19)];
// 1세트 높이: (280px + 40px gap) × 10개 = 3200px

// ---------------------------------------------------------------------------
// 로그인 페이지
// ---------------------------------------------------------------------------
export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [forgotMode, setForgotMode] = useState(false);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    const formData = new FormData(e.currentTarget);
    const email = String(formData.get('email') ?? '').trim();
    const password = String(formData.get('password') ?? '');

    try {
      await login(email, password);
      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : '로그인 실패');
    } finally {
      setLoading(false);
    }
  };

  const handleForgotPassword = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const formData = new FormData(e.currentTarget);
    const email = String(formData.get('email') ?? '').trim();
    if (!email) {
      setError('이메일을 입력해주세요.');
      return;
    }
    setLoading(true);
    try {
      const response = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!response.ok) throw new Error('비밀번호 재설정 요청에 실패했습니다.');
      setNotice('등록 여부와 관계없이 재설정 가능한 계정에는 안내 메일을 보냈습니다.');
    } catch (err) {
      setError(err instanceof Error ? err.message : '비밀번호 재설정 요청에 실패했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen">
      {/* ---- Left Panel: 리버스 네이비 + 반투명 아이콘 스크롤 ---- */}
      <div
        className="relative hidden flex-col justify-between overflow-hidden md:flex md:w-[55%]"
        style={{ background: '#1A2B5E' }}
      >
        {/* 배경: 아이콘 무한 스크롤 (CSS animation, 끊김 없음) */}
        <style>{`
          @keyframes scrollUp {
            0% { transform: translateY(0); }
            100% { transform: translateY(-3200px); }
          }
          @keyframes scrollDown {
            0% { transform: translateY(-3200px); }
            100% { transform: translateY(0); }
          }
        `}</style>
        <div className="absolute inset-0 flex items-center justify-center overflow-hidden pointer-events-none">
          <div className="flex gap-8">
            {/* 열 1: 위로 */}
            <div className="w-[280px] overflow-hidden" style={{ height: '100vh' }}>
              <div style={{ animation: 'scrollUp 40s linear infinite' }}>
                {col1.map((icon, i) => (
                  <div key={`c1-${i}`} className="w-[280px] h-[280px] flex items-center justify-center p-6 mb-[40px]">
                    <img src={icon.src} alt={icon.name} className="w-full h-full object-cover rounded-3xl" style={{ opacity: 0.08, aspectRatio: '1/1' }} />
                  </div>
                ))}
              </div>
            </div>

            {/* 열 2: 아래로 */}
            <div className="w-[280px] overflow-hidden" style={{ height: '100vh' }}>
              <div style={{ animation: 'scrollDown 35s linear infinite' }}>
                {col2.map((icon, i) => (
                  <div key={`c2-${i}`} className="w-[280px] h-[280px] flex items-center justify-center p-6 mb-[40px]">
                    <img src={icon.src} alt={icon.name} className="w-full h-full object-cover rounded-3xl" style={{ opacity: 0.08, aspectRatio: '1/1' }} />
                  </div>
                ))}
              </div>
            </div>

            {/* 열 3: 위로 (느리게) */}
            <div className="w-[280px] overflow-hidden" style={{ height: '100vh' }}>
              <div style={{ animation: 'scrollUp 50s linear infinite' }}>
                {col3.map((icon, i) => (
                  <div key={`c3-${i}`} className="w-[280px] h-[280px] flex items-center justify-center p-6 mb-[40px]">
                    <img src={icon.src} alt={icon.name} className="w-full h-full object-cover rounded-3xl" style={{ opacity: 0.08, aspectRatio: '1/1' }} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* 상단: 로고 */}
        <div className="relative z-10 px-12 pt-10">
          <img src="/riverse_logo.png" alt="RIVERSE" className="h-7" style={{ filter: 'brightness(0) invert(1)' }} />
        </div>

        {/* 중앙: 빈 공간 (아이콘이 배경으로 깔림) */}
        <div className="flex-1" />

        {/* 하단: 카피 + 저작권 */}
        <div className="relative z-10 px-12 pb-9">
          <h1 className="mb-2.5 text-[28px] font-bold leading-[1.4] text-white/90">
            데이터로 보는
            <br />
            <span style={{ color: 'rgba(255,255,255,0.6)' }}>매출의 모든 것</span>
          </h1>
          <p className="mb-6 text-[13px] leading-[1.7] text-white/40">
            속보치 업로드부터 주간 리포트까지,
            <br />
            일본 플랫폼 매출 데이터를 한 곳에서.
          </p>
          <p className="text-[11px] text-white/25">&copy; 2026 Riverse. All rights reserved.</p>
        </div>
      </div>

      {/* ---- Right Panel: 로그인 폼 ---- */}
      <div className="flex flex-1 items-center justify-center border-l border-border bg-background px-6 py-10">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="w-full max-w-[380px]"
        >
          {/* 모바일 로고 */}
          <div className="mb-9 flex items-center gap-2 md:hidden">
            <img src="/riverse_logo.png" alt="RIVERSE" className="h-[26px]" />
            <span className="text-[13px] font-semibold text-muted-foreground">매출 현황 보드</span>
          </div>

          {/* 타이틀 */}
          <div className="mb-1.5 flex items-center gap-2">
            <TrendingUp size={20} className="text-ring" />
            <h2 className="text-2xl font-bold text-foreground">{forgotMode ? '비밀번호 재설정' : '로그인'}</h2>
          </div>
          <p className="mb-8 text-[13px] text-muted-foreground">
            {forgotMode ? '등록된 이메일로 재설정 안내를 요청하세요.' : '등록된 이메일과 비밀번호로 로그인하세요.'}
          </p>

          <form onSubmit={forgotMode ? handleForgotPassword : handleSubmit} noValidate>
            <div className="mb-4">
              <label
                htmlFor="email"
                className="mb-1.5 block text-[12px] font-medium text-muted-foreground"
              >
                이메일
              </label>
              <div className="relative">
                <Mail
                  size={15}
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground/60"
                />
                <input
                  id="email"
                  name="email"
                  type="email"
                  required
                  maxLength={254}
                  autoComplete="email"
                  placeholder="name@example.com"
                  className="w-full rounded-[10px] border border-input bg-input/40 py-3 pl-10 pr-4 text-[14px] text-foreground transition-[border-color,box-shadow] duration-200 outline-none focus:border-ring focus:shadow-[0_0_0_3px_rgba(56,169,248,0.15)]"
                />
              </div>
            </div>

            {!forgotMode && (
              <div className="mb-7">
                <label
                  htmlFor="password"
                  className="mb-1.5 block text-[12px] font-medium text-muted-foreground"
                >
                  비밀번호
                </label>
                <div className="relative">
                  <Lock
                    size={15}
                    className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground/60"
                  />
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    maxLength={1024}
                    autoComplete="current-password"
                    placeholder="비밀번호를 입력하세요"
                    className="w-full rounded-[10px] border border-input bg-input/40 py-3 pl-10 pr-11 text-[14px] text-foreground transition-[border-color,box-shadow] duration-200 outline-none focus:border-ring focus:shadow-[0_0_0_3px_rgba(56,169,248,0.15)]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 flex cursor-pointer items-center p-1 text-muted-foreground/60 transition-colors hover:text-muted-foreground"
                    tabIndex={-1}
                    aria-label={showPassword ? '비밀번호 숨기기' : '비밀번호 보기'}
                  >
                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
            )}

            {/* 에러/안내 메시지 */}
            {error && (
              <div className="mb-4 rounded-lg border border-destructive/20 bg-destructive/10 px-3.5 py-2.5 text-center text-[13px] text-destructive">
                {error}
              </div>
            )}
            {notice && (
              <div className="mb-4 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3.5 py-2.5 text-center text-[13px] text-emerald-600">
                {notice}
              </div>
            )}

            {/* 로그인 버튼 */}
            <button
              type="submit"
              disabled={loading}
              className="btn-gradient w-full cursor-pointer rounded-[10px] py-3.5 text-[14px] font-semibold text-primary-foreground transition-opacity disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading
                ? (forgotMode ? '요청 중...' : '로그인 중...')
                : (forgotMode ? '재설정 메일 요청' : '로그인')}
            </button>
          </form>

          <button
            type="button"
            onClick={() => {
              setForgotMode((value) => !value);
              setError(null);
              setNotice(null);
            }}
            className="mt-4 w-full cursor-pointer text-center text-[13px] text-muted-foreground hover:text-foreground"
          >
            {forgotMode ? '로그인으로 돌아가기' : '비밀번호를 잊으셨나요?'}
          </button>

        </motion.div>
      </div>
    </div>
  );
}
