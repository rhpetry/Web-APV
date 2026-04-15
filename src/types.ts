import type { EVALUATION_KEYS } from "./constants";

export type EvaluationKey = (typeof EVALUATION_KEYS)[number];
export type EvaluationStatus = "pending" | "running" | "completed" | "error";
export type SourceMode = "local" | "remote";

export interface EvaluationState {
  key: EvaluationKey;
  label: string;
  kind: "constraints" | "violation";
  status: EvaluationStatus;
  progressPercent: number;
  estimatedSeconds: number | null;
  etaSeconds: number | null;
  startedAt: string | null;
  completedAt: string | null;
  durationSeconds: number | null;
  completedIterations: number;
  totalIterations: number | null;
  remainingIterations: number | null;
  issueCount: number | null;
  parameter: unknown;
  constraints: Record<string, unknown>;
  violations: unknown[];
  errorMessage: string | null;
}

export interface QueryResult {
  queryType: "select" | "ask" | "construct" | "describe" | "unknown";
  columns?: string[];
  rows?: string[][];
  booleanResult?: boolean;
  graphText?: string;
  rawText?: string;
}

export interface LocalSourceInput {
  mode: "local";
  filename: string;
  content: string;
  contentType?: string;
}

export interface RemoteSourceInput {
  mode: "remote";
  endpoint: string;
  jwtAuthEnabled: boolean;
  authServerUrl?: string;
  username?: string;
  password?: string;
  jwtToken?: string;
}

export type SourceInput = LocalSourceInput | RemoteSourceInput;

export interface SourceSummary {
  title: string;
  mode: SourceMode;
  filename?: string;
  endpoint?: string;
  prefixes?: Record<string, string>;
}

export interface EvaluationSnapshot {
  source: SourceSummary | null;
  evaluations: Record<EvaluationKey, EvaluationState>;
}
