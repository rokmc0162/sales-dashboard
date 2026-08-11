/**
 * Typed Supabase schema — hand-written from
 *   supabase/migrations/20260422000001_initial_schema.sql
 *   supabase/migrations/20260422000002_extras_and_domestic_agent.sql
 *
 * Regenerate with:
 *   supabase gen types typescript \
 *     --project-id "$SUPABASE_PROJECT_ID" \
 *     --schema public > web/lib/supabase/types.ts
 *
 * Until the CLI can reach a live project, this file is the source of truth
 * for the importer + query layer.
 *
 * Note: we avoid self-referencing `Database["public"][...]` in Update
 * definitions because that form collapses to `never` under certain TS
 * inference paths. Each Update type is spelled out inline instead.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// ------------------------------------------------------------------ //
// Row / Insert / Update pieces                                       //
// ------------------------------------------------------------------ //

export type PlatformRow = {
  id: string;
  code: string;
  name_jp: string;
  name_en: string | null;
  folder_prefix: string | null;
  settlement_lag_m: number | null;
  notes: string | null;
  created_at: string;
}
export type PlatformInsert = {
  id?: string;
  code: string;
  name_jp: string;
  name_en?: string | null;
  folder_prefix?: string | null;
  settlement_lag_m?: number | null;
  notes?: string | null;
  created_at?: string;
}

export type ClientRow = {
  id: string;
  code: string;
  display_name: string;
  aliases: string[];
  country: string | null;
  tax_type: string | null;
  created_at: string;
}
export type ClientInsert = {
  id?: string;
  code: string;
  display_name: string;
  aliases?: string[];
  country?: string | null;
  tax_type?: string | null;
  created_at?: string;
}

export type ChannelRow = {
  id: string;
  code: string;
  platform_id: string | null;
  client_id: string | null;
  display_name: string | null;
  created_at: string;
}
export type ChannelInsert = {
  id?: string;
  code: string;
  platform_id?: string | null;
  client_id?: string | null;
  display_name?: string | null;
  created_at?: string;
}

export type TitleRow = {
  id: string;
  title_kr: string | null;
  title_jp: string;
  type: "WT" | "EP" | "COMIC" | "NOVEL" | "OTHER" | null;
  distribution_strategy: "ex" | "non-ex" | "both" | null;
  launch_date: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}
export type TitleInsert = {
  id?: string;
  title_kr?: string | null;
  title_jp: string;
  type?: "WT" | "EP" | "COMIC" | "NOVEL" | "OTHER" | null;
  distribution_strategy?: "ex" | "non-ex" | "both" | null;
  launch_date?: string | null;
  notes?: string | null;
  created_at?: string;
  updated_at?: string;
}

export type TitleAliasRow = {
  id: string;
  title_id: string;
  alias: string;
  source: string | null;
}
export type TitleAliasInsert = {
  id?: string;
  title_id: string;
  alias: string;
  source?: string | null;
}

export type RsRuleRow = {
  id: string;
  title_id: string | null;
  channel_id: string | null;
  client_id: string | null;
  rs_rate: number;
  rs_label: string | null;
  effective_from: string;
  effective_to: string | null;
  priority: number | null;
  notes: string | null;
  created_at: string;
}
export type RsRuleInsert = {
  id?: string;
  title_id?: string | null;
  channel_id?: string | null;
  client_id?: string | null;
  rs_rate: number;
  rs_label?: string | null;
  effective_from?: string;
  effective_to?: string | null;
  priority?: number | null;
  notes?: string | null;
  created_at?: string;
}

export type ExchangeRateRow = {
  rate_date: string;
  jpy_to_krw: number;
  source: string | null;
}
export type ExchangeRateInsert = {
  rate_date: string;
  jpy_to_krw: number;
  source?: string | null;
}

export type RawUploadRow = {
  id: string;
  filename: string;
  storage_path: string;
  size_bytes: number | null;
  content_type: string | null;
  platform_id: string | null;
  platform_code: string | null;
  sales_month: string | null;
  settlement_month: string | null;
  status:
    | "uploaded"
    | "parsing"
    | "parsed"
    | "aggregated"
    | "failed"
    | "archived";
  detection_confidence: number | null;
  parse_error: string | null;
  parsed_rows: number | null;
  uploaded_by: string | null;
  uploaded_at: string;
  parsed_at: string | null;
  sha256: string | null;
  archived_at: string | null;
}
export type RawUploadInsert = {
  id?: string;
  filename: string;
  storage_path: string;
  size_bytes?: number | null;
  content_type?: string | null;
  platform_id?: string | null;
  platform_code?: string | null;
  sales_month?: string | null;
  settlement_month?: string | null;
  status?:
    | "uploaded"
    | "parsing"
    | "parsed"
    | "aggregated"
    | "failed"
    | "archived";
  detection_confidence?: number | null;
  parse_error?: string | null;
  parsed_rows?: number | null;
  uploaded_by?: string | null;
  uploaded_at?: string;
  parsed_at?: string | null;
  sha256?: string | null;
  archived_at?: string | null;
}

export type RawRecordRow = {
  id: string;
  upload_id: string;
  row_index: number;
  data: Json;
  created_at: string;
}
export type RawRecordInsert = {
  id?: string;
  upload_id: string;
  row_index: number;
  data: Json;
  created_at?: string;
}

export type SettlementJobStatus =
  | "queued"
  | "claimed"
  | "processing"
  | "completed"
  | "completed_with_warnings"
  | "failed";

export type SettlementJobTerminalStatus = Extract<
  SettlementJobStatus,
  "completed" | "completed_with_warnings" | "failed"
>;

export type SettlementJobStage =
  | "queued"
  | "parsing"
  | "workbook_generation"
  | "workbook_validation"
  | "completed";

export type SettlementJobRow = {
  id: string;
  month: string;
  status: SettlementJobStatus;
  stage: SettlementJobStage;
  progress_current: number;
  progress_total: number;
  worker_id: string | null;
  lease_expires_at: string | null;
  heartbeat_at: string | null;
  parser_version: string | null;
  rule_version: string | null;
  error_summary: string | null;
  result_summary: string | null;
  artifact_storage_path: string | null;
  workbook_sheet_count: number | null;
  workbook_row_count: number | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type SettlementJobInsert = {
  id?: string;
  month: string;
  status?: SettlementJobStatus;
  stage?: SettlementJobStage;
  progress_current?: number;
  progress_total: number;
  worker_id?: string | null;
  lease_expires_at?: string | null;
  heartbeat_at?: string | null;
  parser_version?: string | null;
  rule_version?: string | null;
  error_summary?: string | null;
  result_summary?: string | null;
  artifact_storage_path?: string | null;
  workbook_sheet_count?: number | null;
  workbook_row_count?: number | null;
  created_at?: string;
  updated_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
};

export type SettlementJobFileStatus = "queued" | "processing" | "completed" | "skipped" | "failed";

export type SettlementJobFileRow = {
  id: string;
  job_id: string;
  upload_id: string;
  position: number;
  folder_hint: string | null;
  status: SettlementJobFileStatus;
  parsed_rows: number | null;
  sales_records_written: number | null;
  sales_records_skipped_duplicates: number | null;
  result_summary: string | null;
  error_summary: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type SettlementJobFileInsert = {
  id?: string;
  job_id: string;
  upload_id: string;
  position: number;
  folder_hint?: string | null;
  status?: SettlementJobFileStatus;
  parsed_rows?: number | null;
  sales_records_written?: number | null;
  sales_records_skipped_duplicates?: number | null;
  result_summary?: string | null;
  error_summary?: string | null;
  created_at?: string;
  updated_at?: string;
  started_at?: string | null;
  completed_at?: string | null;
};

// sales_records has 60+ columns — factored below

export type MgBalanceRow = {
  id: string;
  title_id: string;
  client_id: string | null;
  as_of_month: string;
  beginning_mg: number | null;
  increase_mg: number | null;
  decrease_mg: number | null;
  ending_mg: number | null;
  notes: string | null;
}
export type MgBalanceInsert = {
  id?: string;
  title_id: string;
  client_id?: string | null;
  as_of_month: string;
  beginning_mg?: number | null;
  increase_mg?: number | null;
  decrease_mg?: number | null;
  notes?: string | null;
}

export type SettlementComparisonRunStatus = "processing" | "completed" | "failed";

export type SettlementComparisonRunRow = {
  id: string;
  month: string;                       // YYYY-MM-01
  status: SettlementComparisonRunStatus;
  answer_filename: string;
  answer_storage_path: string;
  answer_sha256: string | null;
  candidate_filename: string | null;
  candidate_storage_path: string | null;
  candidate_sha256: string | null;
  source_upload_ids: string[] | null;
  source_manifest: Json | null;
  summary: Json | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}
export type SettlementComparisonRunInsert = {
  id?: string;
  month: string;
  status?: SettlementComparisonRunStatus;
  answer_filename: string;
  answer_storage_path: string;
  answer_sha256?: string | null;
  candidate_filename?: string | null;
  candidate_storage_path?: string | null;
  candidate_sha256?: string | null;
  source_upload_ids?: string[] | null;
  source_manifest?: Json | null;
  summary?: Json | null;
  error?: string | null;
  created_at?: string;
  updated_at?: string;
  completed_at?: string | null;
}

export type ComparisonDiffCategory = "missing" | "extra" | "field" | "formula";
export type ComparisonDiffReviewStatus =
  | "pending"
  | "candidate_correct"
  | "golden_correct"
  | "needs_review"
  | "resolved";
export type ComparisonInvestigationStatus =
  | "uninvestigated"
  | "question_pending"
  | "investigating"
  | "cause_confirmed"
  | "fix_in_progress"
  | "verification_pending"
  | "resolved";
export type ComparisonRootCauseStage =
  | "source"
  | "upload"
  | "parser"
  | "transform"
  | "identity"
  | "aggregation"
  | "carry"
  | "formula"
  | "human_workbook"
  | "unknown";
export type ComparisonCommentAuthorType = "operator" | "hermes" | "system";

export type SettlementComparisonDiffRow = {
  id: string;
  run_id: string;
  diff_ordinal: number;
  category: ComparisonDiffCategory;
  identity_channel: string | null;
  identity_type: string | null;
  identity_title: string | null;
  field: string | null;
  candidate_value: Json | null;
  golden_value: Json | null;
  review_status: ComparisonDiffReviewStatus;
  review_note: string | null;
  reviewed_at: string | null;
  reviewed_by: string | null;
  investigation_status: ComparisonInvestigationStatus;
  root_cause_stage: ComparisonRootCauseStage | null;
  root_cause_summary: string | null;
  created_at: string;
}
export type SettlementComparisonDiffInsert = {
  id?: string;
  run_id: string;
  diff_ordinal: number;
  category: ComparisonDiffCategory;
  identity_channel?: string | null;
  identity_type?: string | null;
  identity_title?: string | null;
  field?: string | null;
  candidate_value?: Json | null;
  golden_value?: Json | null;
  review_status?: ComparisonDiffReviewStatus;
  review_note?: string | null;
  reviewed_at?: string | null;
  reviewed_by?: string | null;
  investigation_status?: ComparisonInvestigationStatus;
  root_cause_stage?: ComparisonRootCauseStage | null;
  root_cause_summary?: string | null;
  created_at?: string;
}

export type SettlementComparisonCommentRow = {
  id: string;
  diff_id: string;
  author_type: ComparisonCommentAuthorType;
  body: string;
  created_at: string;
}
export type SettlementComparisonCommentInsert = {
  id?: string;
  diff_id: string;
  author_type: ComparisonCommentAuthorType;
  body: string;
  created_at?: string;
}

export type AuditLogRow = {
  id: number;
  actor: string | null;
  entity: string;
  entity_id: string | null;
  action: string;
  before_data: Json | null;
  after_data: Json | null;
  at: string;
}
export type AuditLogInsert = {
  id?: number;
  actor?: string | null;
  entity: string;
  entity_id?: string | null;
  action: string;
  before_data?: Json | null;
  after_data?: Json | null;
  at?: string;
}

// ------------------------------------------------------------------ //
// sales_records row/insert                                           //
// ------------------------------------------------------------------ //

export type SalesRecordRow = {
  id: string;
  upload_id: string | null;
  raw_record_id: string | null;

  unique_identifier: string | null;
  unique_id: string | null;
  channel_title_jp: string | null;
  title_id: string | null;
  title_kr: string | null;
  title_jp: string | null;

  updated: string | null;
  updated_at: string;
  recoder: string | null;
  company: string | null;
  launch_date: string | null;

  sales_month: string | null;
  settlement_month: string | null;
  deposit_month: string | null;
  /** Month bucket this row belongs to (YYYY-MM-01). */
  settlement_batch: string | null;

  country: string | null;
  client_id: string | null;
  channel_id: string | null;
  type: string | null;
  distribution_strategy: string | null;

  settlement_currency: string | null;
  vehicle_currency: string | null;
  total_amount_jpy: number | null;
  fee_jpy: number | null;
  before_tax_jpy: number | null;
  after_tax_jpy: number | null;
  rs_label: string | null;
  rs_rate: number | null;
  before_tax_income_jpy: number | null;
  withholding_tax_jpy: number | null;
  consumption_tax_jpy: number | null;
  after_tax_income_jpy: number | null;
  after_tax_income_jpy_a: number | null;
  after_tax_income_jpy_b: number | null;

  rate_jpy_krw: number | null;
  rate_krw_krw: number | null;
  col31: number | null;
  exchange_rate: number | null;
  fee_krw: number | null;
  before_tax_krw: number | null;
  after_tax_krw: number | null;
  after_tax_income_krw: number | null;
  vat_krw: number | null;
  withholding_tax_krw: number | null;
  sales_krw: number | null;

  mg_begin: number | null;
  mg_increase: number | null;
  mg_decrease: number | null;
  mg_end: number | null;

  note1: string | null;
  note2: string | null;

  extra_45: number | null;
  extra_46: number | null;
  extra_47: number | null;
  extra_48: number | null;
  extra_49: number | null;
  extra_50: number | null;
  extra_51: number | null;
  extra_52: number | null;
  extra_53: string | null;
  extra_54: number | null;
  extra_55: number | null;
  extra_56: number | null;
  extra_57: number | null;
  extra_58: string | null;
  extra_59: number | null;
  extra_60: number | null;
  extra_61: number | null;
  extra_62: number | null;

  created_at: string;
}

export type SalesRecordInsert = {
  id?: string;
  upload_id?: string | null;
  raw_record_id?: string | null;

  unique_identifier?: string | null;
  unique_id?: string | null;
  channel_title_jp?: string | null;
  title_id?: string | null;
  title_kr?: string | null;
  title_jp?: string | null;

  updated?: string | null;
  updated_at?: string;
  recoder?: string | null;
  company?: string | null;
  launch_date?: string | null;

  sales_month?: string | null;
  settlement_month?: string | null;
  deposit_month?: string | null;
  settlement_batch?: string | null;

  country?: string | null;
  client_id?: string | null;
  channel_id?: string | null;
  type?: string | null;
  distribution_strategy?: string | null;

  settlement_currency?: string | null;
  vehicle_currency?: string | null;
  total_amount_jpy?: number | null;
  fee_jpy?: number | null;
  before_tax_jpy?: number | null;
  after_tax_jpy?: number | null;
  rs_label?: string | null;
  rs_rate?: number | null;
  before_tax_income_jpy?: number | null;
  withholding_tax_jpy?: number | null;
  consumption_tax_jpy?: number | null;
  after_tax_income_jpy?: number | null;
  after_tax_income_jpy_a?: number | null;
  after_tax_income_jpy_b?: number | null;

  rate_jpy_krw?: number | null;
  rate_krw_krw?: number | null;
  col31?: number | null;
  exchange_rate?: number | null;
  fee_krw?: number | null;
  before_tax_krw?: number | null;
  after_tax_krw?: number | null;
  after_tax_income_krw?: number | null;
  vat_krw?: number | null;
  withholding_tax_krw?: number | null;
  sales_krw?: number | null;

  mg_begin?: number | null;
  mg_increase?: number | null;
  mg_decrease?: number | null;
  mg_end?: number | null;

  note1?: string | null;
  note2?: string | null;

  extra_45?: number | null;
  extra_46?: number | null;
  extra_47?: number | null;
  extra_48?: number | null;
  extra_49?: number | null;
  extra_50?: number | null;
  extra_51?: number | null;
  extra_52?: number | null;
  extra_53?: string | null;
  extra_54?: number | null;
  extra_55?: number | null;
  extra_56?: number | null;
  extra_57?: number | null;
  extra_58?: string | null;
  extra_59?: number | null;
  extra_60?: number | null;
  extra_61?: number | null;
  extra_62?: number | null;

  created_at?: string;
}

// ------------------------------------------------------------------ //
// settlement web intake (migration 029)                              //
// ------------------------------------------------------------------ //

export type SettlementIntakeObjectStatus = "uploading" | "finalized" | "quarantined";

export type SettlementIntakeMonthRow = {
  id: string;
  month: string;
  month_key: string;
  draft_revision: number;
  created_by: string;
  created_at: string;
};
export type SettlementIntakeMonthInsert = {
  id?: string;
  month: string;
  month_key: string;
  draft_revision?: number;
  created_by: string;
  created_at?: string;
};

export type SettlementIntakeObjectRow = {
  id: string;
  intake_id: string;
  replacement_for_object_id: string | null;
  status: SettlementIntakeObjectStatus;
  storage_bucket: string;
  storage_path: string;
  path_key: string;
  display_name: string;
  content_type: string;
  expected_size_bytes: number;
  expected_sha256: string;
  observed_size_bytes: number | null;
  observed_sha256: string | null;
  quarantine_reason: string | null;
  created_by: string;
  created_at: string;
};
export type SettlementIntakeObjectInsert = {
  id?: string;
  intake_id: string;
  replacement_for_object_id?: string | null;
  status?: SettlementIntakeObjectStatus;
  storage_bucket?: string;
  storage_path: string;
  path_key: string;
  display_name: string;
  content_type: string;
  expected_size_bytes: number;
  expected_sha256: string;
  observed_size_bytes?: number | null;
  observed_sha256?: string | null;
  quarantine_reason?: string | null;
  created_by: string;
  created_at?: string;
};

export type SettlementIntakeDraftEntryRow = {
  id: string;
  intake_id: string;
  object_id: string;
  position: number;
  revision: number;
  created_at: string;
  updated_at: string;
};
export type SettlementIntakeDraftEntryInsert = {
  id?: string;
  intake_id: string;
  object_id: string;
  position: number;
  revision?: number;
  created_at?: string;
  updated_at?: string;
};

export type SettlementIntakeAuditRow = {
  id: number;
  intake_id: string;
  actor: string;
  action: string;
  detail: Json | null;
  created_at: string;
};
export type SettlementIntakeAuditInsert = {
  id?: number;
  intake_id: string;
  actor: string;
  action: string;
  detail?: Json | null;
  created_at?: string;
};

export type SettlementIntakeVersionRow = {
  id: string;
  intake_id: string;
  version_no: number;
  file_count: number;
  total_size_bytes: number;
  manifest_sha256: string;
  submitted_by: string;
  created_at: string;
};
export type SettlementIntakeVersionInsert = {
  id?: string;
  intake_id: string;
  version_no: number;
  file_count: number;
  total_size_bytes: number;
  manifest_sha256: string;
  submitted_by: string;
  created_at?: string;
};

export type SettlementIntakeVersionFileRow = {
  id: string;
  version_id: string;
  object_id: string;
  position: number;
  path_key: string;
  display_name: string;
  size_bytes: number;
  sha256: string;
  storage_path: string;
  created_at: string;
};
export type SettlementIntakeVersionFileInsert = {
  id?: string;
  version_id: string;
  object_id: string;
  position: number;
  path_key: string;
  display_name: string;
  size_bytes: number;
  sha256: string;
  storage_path: string;
  created_at?: string;
};

// ------------------------------------------------------------------ //
// Main Database type                                                 //
// ------------------------------------------------------------------ //

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "12";
  };
  public: {
    Tables: {
      platforms: {
        Row: PlatformRow;
        Insert: PlatformInsert;
        Update: Partial<PlatformInsert>;
        Relationships: [];
      };
      clients: {
        Row: ClientRow;
        Insert: ClientInsert;
        Update: Partial<ClientInsert>;
        Relationships: [];
      };
      channels: {
        Row: ChannelRow;
        Insert: ChannelInsert;
        Update: Partial<ChannelInsert>;
        Relationships: [];
      };
      titles: {
        Row: TitleRow;
        Insert: TitleInsert;
        Update: Partial<TitleInsert>;
        Relationships: [];
      };
      title_aliases: {
        Row: TitleAliasRow;
        Insert: TitleAliasInsert;
        Update: Partial<TitleAliasInsert>;
        Relationships: [];
      };
      rs_rules: {
        Row: RsRuleRow;
        Insert: RsRuleInsert;
        Update: Partial<RsRuleInsert>;
        Relationships: [];
      };
      exchange_rates: {
        Row: ExchangeRateRow;
        Insert: ExchangeRateInsert;
        Update: Partial<ExchangeRateInsert>;
        Relationships: [];
      };
      raw_uploads: {
        Row: RawUploadRow;
        Insert: RawUploadInsert;
        Update: Partial<RawUploadInsert>;
        Relationships: [];
      };
      raw_records: {
        Row: RawRecordRow;
        Insert: RawRecordInsert;
        Update: Partial<RawRecordInsert>;
        Relationships: [];
      };
      sales_records: {
        Row: SalesRecordRow;
        Insert: SalesRecordInsert;
        Update: Partial<SalesRecordInsert>;
        Relationships: [];
      };
      mg_balances: {
        Row: MgBalanceRow;
        Insert: MgBalanceInsert;
        Update: Partial<MgBalanceInsert>;
        Relationships: [];
      };
      audit_logs: {
        Row: AuditLogRow;
        Insert: AuditLogInsert;
        Update: Partial<AuditLogInsert>;
        Relationships: [];
      };
      settlement_comparison_runs: {
        Row: SettlementComparisonRunRow;
        Insert: SettlementComparisonRunInsert;
        Update: Partial<SettlementComparisonRunInsert>;
        Relationships: [];
      };
      settlement_comparison_diffs: {
        Row: SettlementComparisonDiffRow;
        Insert: SettlementComparisonDiffInsert;
        Update: Partial<SettlementComparisonDiffInsert>;
        Relationships: [];
      };
      settlement_jobs: {
        Row: SettlementJobRow;
        Insert: SettlementJobInsert;
        Update: Partial<SettlementJobInsert>;
        Relationships: [];
      };
      settlement_job_files: {
        Row: SettlementJobFileRow;
        Insert: SettlementJobFileInsert;
        Update: Partial<SettlementJobFileInsert>;
        Relationships: [];
      };
      settlement_intake_months: {
        Row: SettlementIntakeMonthRow;
        Insert: SettlementIntakeMonthInsert;
        Update: Partial<SettlementIntakeMonthInsert>;
        Relationships: [];
      };
      settlement_intake_objects: {
        Row: SettlementIntakeObjectRow;
        Insert: SettlementIntakeObjectInsert;
        Update: Partial<SettlementIntakeObjectInsert>;
        Relationships: [];
      };
      settlement_intake_draft_entries: {
        Row: SettlementIntakeDraftEntryRow;
        Insert: SettlementIntakeDraftEntryInsert;
        Update: Partial<SettlementIntakeDraftEntryInsert>;
        Relationships: [];
      };
      settlement_intake_audit: {
        Row: SettlementIntakeAuditRow;
        Insert: SettlementIntakeAuditInsert;
        Update: { [K in never]: never };
        Relationships: [];
      };
      settlement_intake_versions: {
        Row: SettlementIntakeVersionRow;
        Insert: SettlementIntakeVersionInsert;
        Update: { [K in never]: never };
        Relationships: [];
      };
      settlement_intake_version_files: {
        Row: SettlementIntakeVersionFileRow;
        Insert: SettlementIntakeVersionFileInsert;
        Update: { [K in never]: never };
        Relationships: [];
      };
    };
    Views: {
      v_monthly_summary: {
        Row: {
          settlement_month: string;
          row_count: number;
          total_jpy: number | null;
          before_tax_income_jpy: number | null;
          sales_krw: number | null;
        };
        Relationships: [];
      };
      v_monthly_summary_by_client: {
        Row: {
          settlement_month: string;
          client_bucket: string;
          row_count: number;
          total_jpy: number | null;
          before_tax_income_jpy: number | null;
          after_tax_income_jpy: number | null;
          sales_krw: number | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      enqueue_settlement_job: {
        Args: {
          p_month: string;
          p_files: Json;
          p_parser_version?: string | null;
          p_rule_version?: string | null;
        };
        Returns: string;
      };
      claim_settlement_job: {
        Args: { p_worker_id: string; p_lease_seconds?: number };
        Returns: SettlementJobRow[];
      };
      heartbeat_settlement_job: {
        Args: {
          p_job_id: string;
          p_worker_id: string;
          p_lease_seconds: number;
          p_stage: SettlementJobStage;
          p_progress_current: number;
          p_progress_total: number;
        };
        Returns: boolean;
      };
      release_settlement_job: {
        Args: {
          p_job_id: string;
          p_worker_id: string;
        };
        Returns: boolean;
      };
      finish_settlement_job: {
        Args: {
          p_job_id: string;
          p_worker_id: string;
          p_status: SettlementJobStatus;
          p_error_summary?: string | null;
          p_result_summary?: string | null;
          p_artifact_storage_path?: string | null;
          p_workbook_sheet_count?: number | null;
          p_workbook_row_count?: number | null;
        };
        Returns: boolean;
      };
      create_settlement_intake: {
        Args: { p_month_key: string; p_actor: string };
        Returns: SettlementIntakeMonthRow;
      };
      register_settlement_intake_object: {
        Args: {
          p_intake_id: string;
          p_path_key: string;
          p_display_name: string;
          p_content_type: string;
          p_expected_size_bytes: number;
          p_expected_sha256: string;
          p_actor: string;
          p_expected_draft_revision: number;
          p_replacement_for_object_id: string | null;
        };
        Returns: SettlementIntakeObjectRow;
      };
      finalize_settlement_intake_object: {
        Args: {
          p_object_id: string;
          p_observed_size_bytes: number;
          p_observed_sha256: string;
          p_actor: string;
        };
        Returns: SettlementIntakeObjectRow;
      };
      quarantine_settlement_intake_object: {
        Args: { p_object_id: string; p_reason: string; p_actor: string };
        Returns: SettlementIntakeObjectRow;
      };
      upsert_settlement_intake_draft_entry: {
        Args: {
          p_intake_id: string;
          p_object_id: string;
          p_expected_draft_revision: number;
          p_actor: string;
        };
        Returns: number;
      };
      replace_settlement_intake_draft_entry: {
        Args: {
          p_intake_id: string;
          p_old_object_id: string;
          p_new_object_id: string;
          p_expected_draft_revision: number;
          p_actor: string;
        };
        Returns: number;
      };
      remove_settlement_intake_draft_entry: {
        Args: {
          p_intake_id: string;
          p_object_id: string;
          p_expected_draft_revision: number;
          p_actor: string;
        };
        Returns: number;
      };
      reorder_settlement_intake_draft: {
        Args: {
          p_intake_id: string;
          p_object_ids: string[];
          p_expected_draft_revision: number;
          p_actor: string;
        };
        Returns: number;
      };
      submit_settlement_intake_version: {
        Args: {
          p_intake_id: string;
          p_expected_draft_revision: number;
          p_actor: string;
        };
        Returns: SettlementIntakeVersionRow;
      };
    };
    Enums: { [K in never]: never };
    CompositeTypes: { [K in never]: never };
  };
};

// ------------------------------------------------------------------ //
// Convenience aliases                                                //
// ------------------------------------------------------------------ //

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];
export type InsertTables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];
