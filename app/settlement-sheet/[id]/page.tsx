import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { AppProvider } from "@/context/AppContext";
import SettlementSpreadsheetReview from "@/features/settlement/components/SettlementSpreadsheetReview";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const metadata: Metadata = {
  title: "정산 정답지 스프레드시트 검수 - RIVERSE",
};

export default async function SettlementSpreadsheetReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();

  return (
    <AppProvider>
      <SettlementSpreadsheetReview runId={id} />
    </AppProvider>
  );
}
