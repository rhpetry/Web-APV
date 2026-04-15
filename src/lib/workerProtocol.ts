import type {
  EvaluationKey,
  EvaluationSnapshot,
  EvaluationState,
  QueryResult,
  SourceInput,
  SourceSummary,
} from "../types";

export interface SetSourceMessage {
  type: "set-source";
  payload: SourceInput;
}

export interface StartConstraintDiscoveryMessage {
  type: "start-constraints";
}

export interface StartValidationsMessage {
  type: "start-validations";
  payload?: {
    constraintOverrides?: Record<string, unknown>;
  };
}

export interface RunQueryMessage {
  type: "run-query";
  payload: {
    requestId: string;
    query: string;
  };
}

export interface GetEvaluationStateMessage {
  type: "get-evaluation-state";
  payload: {
    requestId: string;
    key: EvaluationKey;
  };
}

export interface GetSnapshotMessage {
  type: "get-snapshot";
  payload: {
    requestId: string;
  };
}

export type WorkerRequest =
  | SetSourceMessage
  | StartConstraintDiscoveryMessage
  | StartValidationsMessage
  | RunQueryMessage
  | GetEvaluationStateMessage
  | GetSnapshotMessage;

export interface SourceReadyMessage {
  type: "source-ready";
  payload: SourceSummary;
}

export interface SourceErrorMessage {
  type: "source-error";
  payload: {
    message: string;
  };
}

export interface EvaluationUpdateMessage {
  type: "evaluation-update";
  payload: EvaluationState;
}

export interface SnapshotResponseMessage {
  type: "snapshot-response";
  payload: {
    requestId: string;
    snapshot: EvaluationSnapshot;
  };
}

export interface EvaluationStateResponseMessage {
  type: "evaluation-state-response";
  payload: {
    requestId: string;
    state: EvaluationState;
  };
}

export interface QuerySuccessMessage {
  type: "query-success";
  payload: {
    requestId: string;
    result: QueryResult;
  };
}

export interface QueryErrorMessage {
  type: "query-error";
  payload: {
    requestId: string;
    message: string;
  };
}

export type WorkerEvent =
  | SourceReadyMessage
  | SourceErrorMessage
  | EvaluationUpdateMessage
  | SnapshotResponseMessage
  | EvaluationStateResponseMessage
  | QuerySuccessMessage
  | QueryErrorMessage;
