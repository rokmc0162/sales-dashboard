import { NextResponse } from "next/server";

import { requireSettlementApiAuth } from "./api-auth";
import { loadInputV2Records } from "./export/load-input-v2-records";

export type CurrentStatusLoader = typeof loadInputV2Records;
export type CurrentDataAuthGuard = (
  request: Request,
) => Promise<Response | null>;

export type CurrentStatusDependencies = {
  auth?: CurrentDataAuthGuard;
  loadRecords?: CurrentStatusLoader;
};

export async function handleCurrentStatus(
  request: Request,
  month: string,
  dependencies: CurrentStatusDependencies = {},
) {
  const unauthorized = await (
    dependencies.auth ?? requireSettlementApiAuth
  )(request);
  if (unauthorized) return unauthorized;

  if (!/^\d{6}$/.test(month)) {
    return NextResponse.json(
      { error: "month must be YYYYMM, e.g. 202606" },
      { status: 400 },
    );
  }

  const { records, loadError, sourceWarnings } = await (
    dependencies.loadRecords ?? loadInputV2Records
  )(month, {
    allowIncompleteSources: true,
  });
  if (loadError) {
    return NextResponse.json(
      { error: loadError.error },
      { status: loadError.status, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      month,
      recordCount: records.length,
      warningCount: sourceWarnings.length,
      isComplete: sourceWarnings.length === 0,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

type CurrentWorkbookResult = { buffer: Buffer };

export type CurrentExportDependencies = {
  auth?: CurrentDataAuthGuard;
  loadRecords?: typeof loadInputV2Records;
  fillTemplate?: (options: {
    month: string;
    records: Record<string, unknown>[];
  }) => Promise<CurrentWorkbookResult>;
};

export async function handleCurrentExport(
  request: Request,
  rawMonth: string,
  dependencies?: CurrentExportDependencies,
) {
  const unauthorized = await (
    dependencies?.auth ?? requireSettlementApiAuth
  )(request);
  if (unauthorized) return unauthorized;

  const month = rawMonth.replace(/\.xlsx$/i, "");
  if (!/^\d{6}$/.test(month)) {
    return NextResponse.json(
      { error: "month must be YYYYMM, e.g. 202606" },
      { status: 400 },
    );
  }

  const loadRecords = dependencies?.loadRecords ?? loadInputV2Records;
  const { records, loadError, sourceWarnings } = await loadRecords(month, {
    allowIncompleteSources: true,
  });
  if (loadError) {
    return NextResponse.json(
      { error: loadError.error },
      { status: loadError.status },
    );
  }
  if (records.length === 0) {
    return NextResponse.json(
      { error: `No data available for ${month}` },
      { status: 404 },
    );
  }

  try {
    const fillTemplate = dependencies?.fillTemplate ?? (await import(
      "./export/input-v2-filler"
    )).fillInputV2Template;
    const result = await fillTemplate({ month, records });
    const filename = `JP_INPUT_CURRENT_${month}.xlsx`;
    return new NextResponse(result.buffer as unknown as BodyInit, {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition":
          `attachment; filename="${filename}"; ` +
          `filename*=UTF-8''${filename}`,
        "Cache-Control": "no-store",
        "X-Export-Current-Status": sourceWarnings.length === 0 ? "complete" : "incomplete",
        "X-Export-Current-Warning-Count": String(sourceWarnings.length),
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to generate current settlement xlsx" },
      { status: 500 },
    );
  }
}
