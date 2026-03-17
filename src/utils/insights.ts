import type { PlatformSummary, TitleSummary, Language } from '../types';

interface Insight {
  icon: string;
  text: string;
  type: 'success' | 'warning' | 'info';
}

/**
 * Calculate MoM change percentage from a monthly trend array.
 * Compares the last two entries sorted chronologically.
 */
function getMoMChange(trend: { month: string; sales: number }[]): number {
  if (trend.length < 2) return 0;
  const sorted = [...trend].sort((a, b) => a.month.localeCompare(b.month));
  const current = sorted[sorted.length - 1].sales;
  const previous = sorted[sorted.length - 2].sales;
  if (previous === 0) return 0;
  return ((current - previous) / previous) * 100;
}

/**
 * Generate 3-5 rule-based insights from platform and title summary data.
 *
 * Rules:
 * 1. Top Growth Platform
 * 2. Revenue Drop Warning (conditional)
 * 3. Title Concentration Warning
 * 4. High Performing New Title (conditional)
 * 5. Platform Diversification
 */
export function generateInsights(
  platformSummary: PlatformSummary[],
  titleSummary: TitleSummary[],
  language: Language,
): Insight[] {
  const insights: Insight[] = [];

  // -----------------------------------------------------------------------
  // 1. Top Growth Platform
  // -----------------------------------------------------------------------
  if (platformSummary.length > 0) {
    const platformGrowth = platformSummary.map((p) => ({
      platform: p.platform,
      change: getMoMChange(p.monthlyTrend),
    }));

    const topGrowth = platformGrowth.reduce((best, curr) =>
      curr.change > best.change ? curr : best,
    );

    if (topGrowth.change !== 0) {
      const change = topGrowth.change.toFixed(1);
      insights.push({
        icon: '\u{1F680}',
        text:
          language === 'ko'
            ? `"${topGrowth.platform}" \uD50C\uB7AB\uD3FC\uC774 \uC804\uC6D4 \uB300\uBE44 ${change}% \uC131\uC7A5\uD558\uBA70 \uAC00\uC7A5 \uB192\uC740 \uC131\uC7A5\uC138\uB97C \uBCF4\uC774\uACE0 \uC788\uC2B5\uB2C8\uB2E4.`
            : `\u300C${topGrowth.platform}\u300D\u304C\u524D\u6708\u6BD4${change}%\u5897\u3068\u6700\u3082\u9AD8\u3044\u6210\u9577\u3092\u793A\u3057\u3066\u3044\u307E\u3059\u3002`,
        type: 'success',
      });
    }
  }

  // -----------------------------------------------------------------------
  // 2. Revenue Drop Warning (>20% MoM decline)
  // -----------------------------------------------------------------------
  if (platformSummary.length > 0) {
    const decliningPlatforms = platformSummary
      .map((p) => ({
        platform: p.platform,
        change: getMoMChange(p.monthlyTrend),
      }))
      .filter((p) => p.change < -20);

    for (const dp of decliningPlatforms) {
      const change = Math.abs(dp.change).toFixed(1);
      insights.push({
        icon: '\u26A0\uFE0F',
        text:
          language === 'ko'
            ? `"${dp.platform}" \uD50C\uB7AB\uD3FC \uB9E4\uCD9C\uC774 \uC804\uC6D4 \uB300\uBE44 ${change}% \uAC10\uC18C\uD588\uC2B5\uB2C8\uB2E4. \uBAA8\uB2C8\uD130\uB9C1\uC774 \uD544\uC694\uD569\uB2C8\uB2E4.`
            : `\u300C${dp.platform}\u300D\u306E\u58F2\u4E0A\u304C\u524D\u6708\u6BD4${change}%\u6E1B\u5C11\u3057\u307E\u3057\u305F\u3002\u30E2\u30CB\u30BF\u30EA\u30F3\u30B0\u304C\u5FC5\u8981\u3067\u3059\u3002`,
        type: 'warning',
      });
    }
  }

  // -----------------------------------------------------------------------
  // 3. Title Concentration Warning (top 3 titles share)
  // -----------------------------------------------------------------------
  if (titleSummary.length > 0) {
    const totalSales = titleSummary.reduce((sum, t) => sum + t.totalSales, 0);
    const sortedTitles = [...titleSummary].sort(
      (a, b) => b.totalSales - a.totalSales,
    );
    const top3Sales = sortedTitles
      .slice(0, 3)
      .reduce((sum, t) => sum + t.totalSales, 0);
    const share = totalSales > 0 ? (top3Sales / totalSales) * 100 : 0;
    const shareStr = share.toFixed(1);

    insights.push({
      icon: '\uD83D\uDCCA',
      text:
        language === 'ko'
          ? `\uC0C1\uC704 3\uAC1C \uC791\uD488\uC774 \uC804\uCCB4 \uB9E4\uCD9C\uC758 ${shareStr}%\uB97C \uCC28\uC9C0\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4. \uD3EC\uD2B8\uD3F4\uB9AC\uC624 \uB2E4\uAC01\uD654\uB97C \uAC80\uD1A0\uD558\uC138\uC694.`
          : `\u4E0A\u4F4D3\u4F5C\u54C1\u304C\u5168\u4F53\u58F2\u4E0A\u306E${shareStr}%\u3092\u5360\u3081\u3066\u3044\u307E\u3059\u3002\u30DD\u30FC\u30C8\u30D5\u30A9\u30EA\u30AA\u306E\u591A\u89D2\u5316\u3092\u691C\u8A0E\u3057\u3066\u304F\u3060\u3055\u3044\u3002`,
      type: share > 60 ? 'warning' : 'info',
    });
  }

  // -----------------------------------------------------------------------
  // 4. High Performing New Title (firstDate within last 60 days)
  // -----------------------------------------------------------------------
  if (titleSummary.length > 0) {
    // Determine the reference "now" from the latest lastDate in the data
    const allLastDates = titleSummary
      .map((t) => t.lastDate)
      .filter(Boolean)
      .sort();
    const referenceDate =
      allLastDates.length > 0
        ? new Date(allLastDates[allLastDates.length - 1])
        : new Date();

    const sixtyDaysAgo = new Date(referenceDate);
    sixtyDaysAgo.setDate(sixtyDaysAgo.getDate() - 60);

    // Compute median totalSales
    const sortedSales = [...titleSummary]
      .map((t) => t.totalSales)
      .sort((a, b) => a - b);
    const mid = Math.floor(sortedSales.length / 2);
    const median =
      sortedSales.length % 2 === 0
        ? (sortedSales[mid - 1] + sortedSales[mid]) / 2
        : sortedSales[mid];

    const newHighPerformers = titleSummary.filter((t) => {
      if (!t.firstDate) return false;
      const firstDate = new Date(t.firstDate);
      return firstDate >= sixtyDaysAgo && t.totalSales > median;
    });

    for (const title of newHighPerformers) {
      const primaryTitle = language === 'ko' ? title.titleKR : title.titleJP;
      const secondaryTitle = language === 'ko' ? title.titleJP : title.titleKR;
      const displayTitle = primaryTitle !== secondaryTitle
        ? `${primaryTitle} / ${secondaryTitle}`
        : primaryTitle;
      const avg = Math.round(title.dailyAvg).toLocaleString();
      insights.push({
        icon: '\u2B50',
        text:
          language === 'ko'
            ? `\uCD5C\uADFC \uCD9C\uC2DC\uB41C "${displayTitle}"\uC774(\uAC00) \uC6B0\uC218\uD55C \uC131\uACFC\uB97C \uBCF4\uC774\uACE0 \uC788\uC2B5\uB2C8\uB2E4. (\uC77C\uD3C9\uADE0 \xA5${avg})`
            : `\u6700\u8FD1\u30EA\u30EA\u30FC\u30B9\u306E\u300C${displayTitle}\u300D\u304C\u512A\u308C\u305F\u5B9F\u7E3E\u3092\u793A\u3057\u3066\u3044\u307E\u3059\u3002\uFF08\u65E5\u5E73\u5747 \xA5${avg}\uFF09`,
        type: 'success',
      });
    }
  }

  // -----------------------------------------------------------------------
  // 5. Platform Diversification
  // -----------------------------------------------------------------------
  if (platformSummary.length > 0) {
    const totalPlatformSales = platformSummary.reduce(
      (sum, p) => sum + p.totalSales,
      0,
    );
    const significantPlatforms =
      totalPlatformSales > 0
        ? platformSummary.filter(
            (p) => (p.totalSales / totalPlatformSales) * 100 > 5,
          ).length
        : 0;

    let level: string;
    let type: Insight['type'];
    if (significantPlatforms >= 5) {
      level = language === 'ko' ? '\uC591\uD638' : '\u826F\u597D';
      type = 'success';
    } else if (significantPlatforms >= 3) {
      level = language === 'ko' ? '\uBCF4\uD1B5' : '\u666E\u901A';
      type = 'info';
    } else {
      level = language === 'ko' ? '\uCDE8\uC57D' : '\u8106\u5F31';
      type = 'warning';
    }

    insights.push({
      icon: '\uD83D\uDD04',
      text:
        language === 'ko'
          ? `\uD604\uC7AC ${significantPlatforms}\uAC1C \uD50C\uB7AB\uD3FC\uC774 \uB9E4\uCD9C\uC758 5% \uC774\uC0C1\uC744 \uC810\uC720\uD558\uACE0 \uC788\uC2B5\uB2C8\uB2E4. \uB2E4\uAC01\uD654 \uC218\uC900: ${level}`
          : `\u73FE\u5728${significantPlatforms}\u3064\u306EPF\u304C\u58F2\u4E0A\u306E5%\u4EE5\u4E0A\u3092\u5360\u3081\u3066\u3044\u307E\u3059\u3002\u591A\u89D2\u5316\u30EC\u30D9\u30EB: ${level}`,
      type,
    });
  }

  // Sort by priority: warning first, then success, then info
  const priority: Record<string, number> = { warning: 0, success: 1, info: 2 };
  insights.sort((a, b) => (priority[a.type] ?? 3) - (priority[b.type] ?? 3));

  return insights;
}
