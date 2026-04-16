/// <reference lib="webworker" />

import type { WorkerEvent, WorkerRequest } from "../lib/workerProtocol";
import {
  applyConstraintOverrides,
  beginEvaluation,
  collectConstraintContext,
  completeConstraintsEvaluation,
  completeValidationEvaluation,
  createEmptySnapshot,
  createRuntimeSource,
  failEvaluation,
  runBrowserQuery,
  runValidationCheck,
  updateEvaluationProgress,
  type RuntimeSource,
} from "../lib/apv";
import { EVALUATION_KEYS } from "../constants";
import type { EvaluationKey, EvaluationState } from "../types";
import type { ConstraintContext } from "../lib/apv";

const scope = self as DedicatedWorkerGlobalScope;

let source: RuntimeSource | null = null;
let snapshot = createEmptySnapshot();
let activeRunId = 0;
let cachedConstraintContext: ConstraintContext | null = null;

function emit(event: WorkerEvent): void {
  scope.postMessage(event);
}

function updateState(key: EvaluationKey, nextState: EvaluationState): void {
  snapshot = {
    ...snapshot,
    evaluations: {
      ...snapshot.evaluations,
      [key]: nextState,
    },
  };
  emit({
    type: "evaluation-update",
    payload: nextState,
  });
}

async function handleSetSource(request: Extract<WorkerRequest, { type: "set-source" }>): Promise<void> {
  activeRunId += 1;
  source = await createRuntimeSource(request.payload);
  cachedConstraintContext = null;
  snapshot = createEmptySnapshot();
  snapshot = {
    ...snapshot,
    source: source.summary,
  };
  emit({
    type: "source-ready",
    payload: source.summary,
  });
  for (const key of EVALUATION_KEYS) {
    emit({
      type: "evaluation-update",
      payload: snapshot.evaluations[key],
    });
  }
}

function resetViolationStates(): void {
  for (const key of EVALUATION_KEYS.filter((item) => item !== "constraints")) {
    updateState(key, createEmptySnapshot().evaluations[key]);
  }
}

async function handleStartConstraints(): Promise<void> {
  if (!source) {
    throw new Error("Load a source before starting constraint discovery.");
  }
  const runId = ++activeRunId;
  cachedConstraintContext = null;
  resetViolationStates();
  let constraintsState = beginEvaluation(snapshot.evaluations.constraints);
  updateState("constraints", constraintsState);

  try {
    const context = await collectConstraintContext(source, (completed, total) => {
      if (runId !== activeRunId) {
        return;
      }
      constraintsState = updateEvaluationProgress(constraintsState, completed, total);
      updateState("constraints", constraintsState);
    });
    if (runId !== activeRunId) {
      return;
    }
    cachedConstraintContext = context;
    constraintsState = completeConstraintsEvaluation(constraintsState, context);
    updateState("constraints", constraintsState);
  } catch (error) {
    constraintsState = failEvaluation(constraintsState, error);
    updateState("constraints", constraintsState);
    cachedConstraintContext = null;
  }
}

async function handleStartValidations(request?: Extract<WorkerRequest, { type: "start-validations" }>): Promise<void> {
  if (!source) {
    throw new Error("Load a source before starting APV evaluations.");
  }
  const runtimeSource = source;
  if (!cachedConstraintContext || snapshot.evaluations.constraints.status !== "completed") {
    throw new Error("Discover constraints before starting APV evaluations.");
  }
  const runId = ++activeRunId;
  const context = applyConstraintOverrides(
    cachedConstraintContext,
    request?.payload?.constraintOverrides,
  );

  const validationKeys = EVALUATION_KEYS.filter((item) => item !== "constraints");
  await Promise.all(validationKeys.map(async (key) => {
    let evaluationState = beginEvaluation(snapshot.evaluations[key]);
    updateState(key, evaluationState);
    try {
      const result = await runValidationCheck(runtimeSource, key, context, (completed, total) => {
        if (runId !== activeRunId) {
          return;
        }
        evaluationState = updateEvaluationProgress(evaluationState, completed, total);
        updateState(key, evaluationState);
      });
      if (runId !== activeRunId) {
        return;
      }
      evaluationState = completeValidationEvaluation(evaluationState, result);
      updateState(key, evaluationState);
    } catch (error) {
      evaluationState = failEvaluation(evaluationState, error);
      updateState(key, evaluationState);
    }
  }));
}

scope.addEventListener("message", async (event: MessageEvent<WorkerRequest>) => {
  try {
    switch (event.data.type) {
      case "set-source":
        await handleSetSource(event.data);
        return;
      case "start-constraints":
        await handleStartConstraints();
        return;
      case "start-validations":
        await handleStartValidations(event.data);
        return;
      case "run-query":
        if (!source) {
          throw new Error("Load a source before running a SPARQL query.");
        }
        emit({
          type: "query-success",
          payload: {
            requestId: event.data.payload.requestId,
            result: await runBrowserQuery(source, event.data.payload.query),
          },
        });
        return;
      case "get-evaluation-state":
        emit({
          type: "evaluation-state-response",
          payload: {
            requestId: event.data.payload.requestId,
            state: snapshot.evaluations[event.data.payload.key],
          },
        });
        return;
      case "get-snapshot":
        emit({
          type: "snapshot-response",
          payload: {
            requestId: event.data.payload.requestId,
            snapshot,
          },
        });
        return;
      default:
        return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (event.data.type === "run-query") {
      emit({
        type: "query-error",
        payload: {
          requestId: event.data.payload.requestId,
          message,
        },
      });
      return;
    }
    emit({
      type: "source-error",
      payload: { message },
    });
  }
});
