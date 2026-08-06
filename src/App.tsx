import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import languageTags from "language-tags";

import { APV_CONSTRAINT_INFO, APV_RDF_URL, CHECK_PURPOSES, DEFAULT_QUERY, EVALUATION_KEYS } from "./constants";
import type { WorkerEvent } from "./lib/workerProtocol";
import type {
  EvaluationKey,
  EvaluationSnapshot,
  EvaluationState,
  QueryResult,
  RemoteSourceInput,
  SourceInput,
} from "./types";
import { createEmptySnapshot } from "./lib/apv";

const worker = new Worker(new URL("./workers/evaluator.worker.ts", import.meta.url), {
  type: "module",
});

function formatSeconds(value: number | null): string {
  if (value == null) {
    return "calculating...";
  }
  if (value <= 0) {
    return "0s";
  }
  const seconds = Math.round(value);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return remaining ? `${minutes}m ${remaining}s` : `${minutes}m`;
}

function formatIterations(state: EvaluationState): string {
  if (state.totalIterations == null) {
    return "Iterations pending";
  }
  return `${state.completedIterations} completed / ${state.remainingIterations ?? 0} remaining of ${state.totalIterations}`;
}

function renderValue(value: unknown): string {
  if (value == null) {
    return "None";
  }
  if (Array.isArray(value)) {
    return JSON.stringify(value, null, 2);
  }
  if (typeof value === "object") {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
}

function isPairEntry(value: unknown): value is [unknown, unknown] {
  return Array.isArray(value) && value.length === 2;
}

function DetailValue({ value }: { value: unknown }) {
  if (value == null) {
    return <div className="detail-empty">None</div>;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return <code className="detail-inline">{String(value)}</code>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <div className="detail-empty">None</div>;
    }

    if (value.every((entry) => isPairEntry(entry))) {
      return (
        <div className="detail-list">
          {value.map(([left, right], index) => (
            <div className="detail-row" key={`${String(left)}-${String(right)}-${index}`}>
              <div className="detail-key">{String(left)}</div>
              <div className="detail-text">{String(right)}</div>
            </div>
          ))}
        </div>
      );
    }

    return (
      <div className="detail-list">
        {value.map((entry, index) => (
          <div className="detail-row" key={`${String(entry)}-${index}`}>
            <div className="detail-text">{String(entry)}</div>
          </div>
        ))}
      </div>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) {
      return <div className="detail-empty">None</div>;
    }
    return (
      <div className="detail-list">
        {entries.map(([key, entryValue]) => (
          <div className="detail-row" key={key}>
            <div className="detail-key">{key}</div>
            <div className="detail-text">{renderValue(entryValue)}</div>
          </div>
        ))}
      </div>
    );
  }

  return <pre>{renderValue(value)}</pre>;
}

function DetailSection({ label, value }: { label: string; value: unknown }) {
  return (
    <section className="detail-section">
      <div className="detail-section-label">{label}</div>
      <DetailValue value={value} />
    </section>
  );
}

const URI_RULE_CRITERIA = new Set([
  "ClassURIFormationRule",
  "RelationURIFormationRule",
  "InstanceURIFormationRule",
]);

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolvePrefixesInRegexText(value: string, prefixes: Record<string, string>): string {
  const orderedPrefixes = Object.entries(prefixes).sort((left, right) => right[1].length - left[1].length);
  let resolved = value;
  for (const [prefix, namespace] of orderedPrefixes) {
    resolved = resolved.replace(
      new RegExp(`(^|[\\s(|^])${escapeForRegex(namespace)}`, "g"),
      `$1${prefix}:`,
    );
  }
  return resolved;
}

function expandPrefixesInRegexText(value: string, prefixes: Record<string, string>): string {
  const orderedPrefixes = Object.entries(prefixes).sort((left, right) => right[0].length - left[0].length);
  let expanded = value;
  for (const [prefix, namespace] of orderedPrefixes) {
    expanded = expanded.replace(
      new RegExp(`(^|[\\s(|^])${escapeForRegex(prefix)}:`, "g"),
      `$1${namespace}`,
    );
  }
  return expanded;
}

function resolvePrefixesInText(value: string, prefixes: Record<string, string>, criterionKey?: string): string {
  if (criterionKey && URI_RULE_CRITERIA.has(criterionKey)) {
    return resolvePrefixesInRegexText(value, prefixes);
  }
  const orderedPrefixes = Object.entries(prefixes).sort((left, right) => right[1].length - left[1].length);
  let resolved = value;
  for (const [prefix, namespace] of orderedPrefixes) {
    if (resolved.includes(namespace)) {
      resolved = resolved.split(namespace).join(`${prefix}:`);
    }
  }
  return resolved;
}

function expandPrefixesInText(value: string, prefixes: Record<string, string>, criterionKey?: string): string {
  if (criterionKey && URI_RULE_CRITERIA.has(criterionKey)) {
    return expandPrefixesInRegexText(value, prefixes);
  }
  const orderedPrefixes = Object.entries(prefixes).sort((left, right) => right[0].length - left[0].length);
  let expanded = value;
  for (const [prefix, namespace] of orderedPrefixes) {
    expanded = expanded.replaceAll(`${prefix}:`, namespace);
  }
  return expanded;
}

function resolvePrefixesInValue(value: unknown, prefixes: Record<string, string>, criterionKey?: string): unknown {
  if (typeof value === "string") {
    return resolvePrefixesInText(value, prefixes, criterionKey);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolvePrefixesInValue(item, prefixes, criterionKey));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        resolvePrefixesInText(key, prefixes, criterionKey),
        resolvePrefixesInValue(item, prefixes, criterionKey),
      ]),
    );
  }
  return value;
}

function expandPrefixesInValue(value: unknown, prefixes: Record<string, string>, criterionKey?: string): unknown {
  if (typeof value === "string") {
    return expandPrefixesInText(value, prefixes, criterionKey);
  }
  if (Array.isArray(value)) {
    return value.map((item) => expandPrefixesInValue(item, prefixes, criterionKey));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        expandPrefixesInValue(item, prefixes, criterionKey),
      ]),
    );
  }
  return value;
}

function serializeConstraintEditorValue(criterionKey: string, value: unknown): string {
  if (criterionKey === "GlobalMinLanguageCoverage" && Array.isArray(value)) {
    return value.map((item) => String(item)).join("\n");
  }
  if (
    criterionKey === "ClassMinAnnotationCoverage" ||
    criterionKey === "RelationMinAnnotationCoverage" ||
    criterionKey === "InstanceMinAnnotationCoverage" ||
    criterionKey === "MinAnnotationLength" ||
    criterionKey === "MaxAnnotationLength" ||
    criterionKey === "AnnotationRegularExpression"
  ) {
    return Array.isArray(value)
      ? value
          .filter((item): item is [unknown, unknown] => Array.isArray(item) && item.length === 2)
          .map(([left, right]) => `${String(left)} | ${String(right)}`)
          .join("\n")
      : "";
  }
  if (criterionKey === "InstanceOfMinAnnotationCoverage") {
    return Array.isArray(value)
      ? value
          .filter((item): item is [unknown, unknown] => Array.isArray(item) && item.length === 2)
          .map(([classIri, entries]) => {
            const serializedEntries = Array.isArray(entries)
              ? entries
                  .filter((entry): entry is [unknown, unknown] => Array.isArray(entry) && entry.length === 2)
                  .map(([left, right]) => `${String(left)} | ${String(right)}`)
                  .join(" ; ")
              : "";
            return `${String(classIri)} => ${serializedEntries}`;
          })
          .join("\n")
      : "";
  }
  return typeof value === "string" ? value : "";
}

function parseConstraintEditorValue(criterionKey: string, rawValue: string): unknown {
  const trimmed = rawValue.trim();
  if (
    criterionKey === "ClassURIFormationRule" ||
    criterionKey === "RelationURIFormationRule" ||
    criterionKey === "InstanceURIFormationRule"
  ) {
    return trimmed;
  }
  if (criterionKey === "GlobalMinLanguageCoverage") {
    return trimmed
      ? trimmed.split(/\n+/).map((item) => item.trim()).filter(Boolean)
      : [];
  }
  if (
    criterionKey === "ClassMinAnnotationCoverage" ||
    criterionKey === "RelationMinAnnotationCoverage" ||
    criterionKey === "InstanceMinAnnotationCoverage" ||
    criterionKey === "MinAnnotationLength" ||
    criterionKey === "MaxAnnotationLength" ||
    criterionKey === "AnnotationRegularExpression"
  ) {
    if (!trimmed) {
      return [];
    }
    return trimmed
      .split(/\n+/)
      .map((line) => line.split("|").map((part) => part.trim()))
      .filter((parts) => parts.length >= 2 && parts[0] && parts[1])
      .map(([left, right]) => {
        if (
          criterionKey === "ClassMinAnnotationCoverage" ||
          criterionKey === "RelationMinAnnotationCoverage" ||
          criterionKey === "InstanceMinAnnotationCoverage" ||
          criterionKey === "MinAnnotationLength" ||
          criterionKey === "MaxAnnotationLength"
        ) {
          return [left, Number(right)] as [string, number];
        }
        return [left, right] as [string, string];
      });
  }
  if (criterionKey === "InstanceOfMinAnnotationCoverage") {
    if (!trimmed) {
      return [];
    }
    return trimmed
      .split(/\n+/)
      .map((line) => line.split("=>").map((part) => part.trim()))
      .filter((parts) => parts.length >= 2 && parts[0])
      .map(([classIri, entryBlock]) => [
        classIri,
        entryBlock
          .split(";")
          .map((part) => part.split("|").map((item) => item.trim()))
          .filter((parts) => parts.length >= 2 && parts[0] && parts[1])
          .map(([left, right]) => [left, Number(right)] as [string, number]),
      ]);
  }
  return trimmed;
}

type ConstraintDraftValidation = {
  value: unknown;
  error: string | null;
};

function validateConstraintEditorValue(criterionKey: string, rawValue: string): ConstraintDraftValidation {
  if (!rawValue) {
    return { value: parseConstraintEditorValue(criterionKey, rawValue), error: null };
  }

  if (criterionKey === "GlobalMinLanguageCoverage") {
    if (/^\s|\s$/.test(rawValue)) {
      return {
        value: null,
        error: "Complete the language tag after the whitespace separator.",
      };
    }
    const tags = rawValue.split(/\s+/);
    const invalidTag = tags.find((tag) => !languageTags.check(tag));
    return invalidTag
      ? { value: null, error: `“${invalidTag}” is not a valid IANA language tag.` }
      : { value: tags, error: null };
  }

  const pairCriteria = new Set([
    "ClassMinAnnotationCoverage",
    "RelationMinAnnotationCoverage",
    "InstanceMinAnnotationCoverage",
    "MinAnnotationLength",
    "MaxAnnotationLength",
    "AnnotationRegularExpression",
  ]);
  if (pairCriteria.has(criterionKey)) {
    const lines = rawValue.split("\n");
    const incompleteLine = lines.findIndex((line) => {
      const parts = line.split("|");
      return parts.length !== 2 || !parts[0].trim() || !parts[1].trim();
    });
    if (incompleteLine >= 0) {
      return {
        value: null,
        error: `Line ${incompleteLine + 1} must use the format “left | right”.`,
      };
    }

    if (criterionKey !== "AnnotationRegularExpression") {
      const invalidNumberLine = lines.findIndex((line) => {
        const right = line.split("|")[1].trim();
        return !/^\d+$/.test(right) || Number(right) < 1;
      });
      if (invalidNumberLine >= 0) {
        return {
          value: null,
          error: `Line ${invalidNumberLine + 1} requires a positive whole number on the right.`,
        };
      }
    } else {
      const invalidRegexLine = lines.findIndex((line) => {
        try {
          new RegExp(line.split("|")[1].trim());
          return false;
        } catch {
          return true;
        }
      });
      if (invalidRegexLine >= 0) {
        return { value: null, error: `Line ${invalidRegexLine + 1} contains an invalid regular expression.` };
      }
    }
  }

  if (criterionKey === "InstanceOfMinAnnotationCoverage") {
    const lines = rawValue.split("\n");
    const invalidLine = lines.findIndex((line) => {
      const parts = line.split("=>");
      if (parts.length !== 2 || !parts[0].trim() || !parts[1].trim()) {
        return true;
      }
      return parts[1].split(";").some((entry) => {
        const entryParts = entry.split("|");
        return entryParts.length !== 2 || !entryParts[0].trim() || !/^\d+$/.test(entryParts[1].trim()) || Number(entryParts[1].trim()) < 1;
      });
    });
    if (invalidLine >= 0) {
      return {
        value: null,
        error: `Line ${invalidLine + 1} must use “classIRI => annotationIRI | positive cardinality”.`,
      };
    }
  }

  return { value: parseConstraintEditorValue(criterionKey, rawValue), error: null };
}

function constraintEditorHint(criterionKey: string): string {
  if (criterionKey === "GlobalMinLanguageCoverage") {
    return "Enter IANA language tags separated by whitespace (for example: en pt-BR).";
  }
  if (
    criterionKey === "ClassMinAnnotationCoverage" ||
    criterionKey === "RelationMinAnnotationCoverage" ||
    criterionKey === "InstanceMinAnnotationCoverage" ||
    criterionKey === "MinAnnotationLength" ||
    criterionKey === "MaxAnnotationLength" ||
    criterionKey === "AnnotationRegularExpression"
  ) {
    return "One entry per line in the format: left | right";
  }
  if (criterionKey === "InstanceOfMinAnnotationCoverage") {
    return "One class per line in the format: classIRI => annotationIRI | cardinality ; annotationIRI | cardinality";
  }
  return "Edit the value used for this evaluation session only.";
}

function isPairList(value: unknown): value is Array<[unknown, unknown]> {
  return Array.isArray(value) && value.every((item) => Array.isArray(item) && item.length === 2);
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function ConstraintValue({ value }: { value: unknown }) {
  if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) {
    return <span className="constraint-empty">None</span>;
  }

  if (isPairList(value)) {
    return (
      <ul className="constraint-pair-list">
        {value.map(([left, right], index) => (
          <li key={`${String(left)}-${index}`}>
            <span className="constraint-key">{String(left)}</span>
            <span className="constraint-arrow">→</span>
            <span className="constraint-value-text">{renderValue(right)}</span>
          </li>
        ))}
      </ul>
    );
  }

  if (Array.isArray(value)) {
    return (
      <div className="constraint-chip-row">
        {value.map((item, index) => (
          <span className="constraint-chip" key={`${String(item)}-${index}`}>
            {renderValue(item)}
          </span>
        ))}
      </div>
    );
  }

  if (typeof value === "object") {
    return (
      <div className="constraint-object">
        {Object.entries(value).map(([key, item]) => (
          <div className="constraint-object-row" key={key}>
            <span className="constraint-object-key">{key}</span>
            <ConstraintValue value={item} />
          </div>
        ))}
      </div>
    );
  }

  return <span className="constraint-value-text">{String(value)}</span>;
}

function ConstraintInfoButton({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className="constraint-info-trigger"
      type="button"
      aria-expanded={open}
      aria-label={`More information about ${label}`}
      onClick={onToggle}
    >
      More Info
    </button>
  );
}

function ConstraintEditButton({
  label,
  open,
  onToggle,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className="constraint-info-trigger"
      type="button"
      aria-expanded={open}
      aria-label={`Edit ${label} for this session`}
      onClick={onToggle}
    >
      Edit
    </button>
  );
}

function ConstraintDiscardButton({
  label,
  onDiscard,
}: {
  label: string;
  onDiscard: () => void;
}) {
  return (
    <button
      className="constraint-discard-trigger"
      type="button"
      aria-label={`Discard session override for ${label}`}
      onClick={onDiscard}
    >
      Discard
    </button>
  );
}

function ConstraintRow({ criterionKey, value }: { criterionKey: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  const info = APV_CONSTRAINT_INFO[criterionKey];

  return (
    <div className="constraint-row">
      <div className="constraint-heading">
        <div className="constraint-label">{info?.label ?? criterionKey}</div>
        {info ? (
          <ConstraintInfoButton
            label={info.label}
            open={open}
            onToggle={() => setOpen((current) => !current)}
          />
        ) : null}
      </div>
      <div className="constraint-content">
        <ConstraintValue value={value} />
      </div>
      {info && open ? (
        <div className="constraint-info-panel">
          <p>{info.description}</p>
          <div className="constraint-info-example">
            <strong>Example from APV.rdf</strong>
            <code>{info.example}</code>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function EditableConstraintRow({
  criterionKey,
  value,
  hasSessionOverride,
  onChange,
  onDiscard,
  onValidityChange,
}: {
  criterionKey: string;
  value: unknown;
  hasSessionOverride: boolean;
  onChange: (nextValue: unknown) => void;
  onDiscard: () => void;
  onValidityChange: (error: string | null) => void;
}) {
  const [openInfo, setOpenInfo] = useState(false);
  const [openEditor, setOpenEditor] = useState(false);
  const info = APV_CONSTRAINT_INFO[criterionKey];
  const [draft, setDraft] = useState(() => serializeConstraintEditorValue(criterionKey, value));
  const validation = useMemo(() => validateConstraintEditorValue(criterionKey, draft), [criterionKey, draft]);

  useEffect(() => {
    if (!openEditor) {
      setDraft(serializeConstraintEditorValue(criterionKey, value));
    }
  }, [criterionKey, openEditor, value]);

  useEffect(() => {
    onValidityChange(openEditor ? validation.error : null);
    return () => onValidityChange(null);
  }, [openEditor, onValidityChange, validation.error]);

  return (
    <div className="constraint-row editable">
      <div className="constraint-heading">
        <div className="constraint-label">{info?.label ?? criterionKey}</div>
        {info ? (
          <ConstraintInfoButton
            label={info.label}
            open={openInfo}
            onToggle={() => setOpenInfo((current) => !current)}
          />
        ) : null}
        <ConstraintEditButton
          label={info?.label ?? criterionKey}
          open={openEditor}
          onToggle={() => {
            if (!openEditor) {
              setDraft(serializeConstraintEditorValue(criterionKey, value));
            }
            setOpenEditor((current) => !current);
          }}
        />
        {hasSessionOverride ? (
          <>
            <span className="constraint-override-pill">Session Override</span>
            <ConstraintDiscardButton
              label={info?.label ?? criterionKey}
              onDiscard={() => {
                setOpenEditor(false);
                onValidityChange(null);
                onDiscard();
              }}
            />
          </>
        ) : null}
      </div>
      <div className="constraint-content">
        <ConstraintValue value={value} />
      </div>
      {openEditor ? (
        <div className="constraint-editor">
          <label className="constraint-editor-label" htmlFor={`editor-${criterionKey}`}>
            Session override
          </label>
          <textarea
            id={`editor-${criterionKey}`}
            value={draft}
            aria-invalid={validation.error ? "true" : "false"}
            aria-describedby={`editor-help-${criterionKey}`}
            className={validation.error ? "invalid" : undefined}
            onChange={(event) => {
              const nextDraft = event.target.value;
              setDraft(nextDraft);
              const nextValidation = validateConstraintEditorValue(criterionKey, nextDraft);
              if (!nextValidation.error) {
                onChange(nextValidation.value);
              }
            }}
          />
          <div
            id={`editor-help-${criterionKey}`}
            className={validation.error ? "constraint-editor-error" : "constraint-editor-hint"}
            role={validation.error ? "alert" : undefined}
          >
            {validation.error ?? constraintEditorHint(criterionKey)}
          </div>
        </div>
      ) : null}
      {info && openInfo ? (
        <div className="constraint-info-panel">
          <p>{info.description}</p>
          <div className="constraint-info-example">
            <strong>Example from APV.rdf</strong>
            <code>{info.example}</code>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function useWorkerBridge() {
  const [snapshot, setSnapshot] = useState<EvaluationSnapshot>(() => createEmptySnapshot());
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const pendingRequests = useRef(new Map<string, (event: WorkerEvent) => void>());
  const pendingSourceLoad = useRef<{
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);

  useEffect(() => {
    const onMessage = (event: MessageEvent<WorkerEvent>) => {
      const payload = event.data;
      if (payload.type === "source-ready") {
        setSourceError(null);
        setSnapshot((current) => ({
          ...current,
          source: payload.payload,
        }));
        pendingSourceLoad.current?.resolve();
        pendingSourceLoad.current = null;
        return;
      }
      if (payload.type === "source-error") {
        setSourceError(payload.payload.message);
        pendingSourceLoad.current?.reject(new Error(payload.payload.message));
        pendingSourceLoad.current = null;
        return;
      }
      if (payload.type === "evaluation-update") {
        setSnapshot((current) => ({
          ...current,
          evaluations: {
            ...current.evaluations,
            [payload.payload.key]: payload.payload,
          },
        }));
        return;
      }
      if (payload.type === "query-error" || payload.type === "query-success") {
        const resolver = pendingRequests.current.get(payload.payload.requestId);
        if (resolver) {
          pendingRequests.current.delete(payload.payload.requestId);
          resolver(payload);
        }
        if (payload.type === "query-error") {
          setQueryError(payload.payload.message);
        } else {
          setQueryError(null);
          setQueryResult(payload.payload.result);
        }
        return;
      }
      const requestId = "payload" in payload && "requestId" in payload.payload
        ? payload.payload.requestId
        : null;
      if (!requestId) {
        return;
      }
      const resolver = pendingRequests.current.get(requestId);
      if (resolver) {
        pendingRequests.current.delete(requestId);
        resolver(payload);
      }
    };

    worker.addEventListener("message", onMessage);
    return () => worker.removeEventListener("message", onMessage);
  }, []);

  function post(message: Parameters<Worker["postMessage"]>[0]) {
    worker.postMessage(message);
  }

  function setSource(payload: SourceInput): Promise<void> {
    if (pendingSourceLoad.current) {
      pendingSourceLoad.current.reject(new Error("A source is already being loaded."));
      pendingSourceLoad.current = null;
    }
    return new Promise((resolve, reject) => {
      pendingSourceLoad.current = { resolve, reject };
      post({
        type: "set-source",
        payload,
      });
    });
  }

  function requestSnapshot(): Promise<EvaluationSnapshot> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      pendingRequests.current.set(requestId, (event) => {
        if (event.type === "snapshot-response") {
          setSnapshot(event.payload.snapshot);
          resolve(event.payload.snapshot);
        }
      });
      post({ type: "get-snapshot", payload: { requestId } });
    });
  }

  function runQuery(query: string): Promise<QueryResult> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      pendingRequests.current.set(requestId, (event) => {
        if (event.type === "query-success") {
          resolve(event.payload.result);
          return;
        }
        if (event.type === "query-error") {
          reject(new Error(event.payload.message));
        }
      });
      post({
        type: "run-query",
        payload: {
          requestId,
          query,
        },
      });
    });
  }

  return {
    snapshot,
    sourceError,
    queryError,
    queryResult,
    setQueryResult,
    post,
    setSource,
    requestSnapshot,
    runQuery,
  };
}

export default function App() {
  const {
    snapshot,
    sourceError,
    queryError,
    queryResult,
    setQueryResult,
    post,
    setSource,
    requestSnapshot,
    runQuery,
  } = useWorkerBridge();

  const [mode, setMode] = useState<"local" | "remote">("local");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [graphLoading, setGraphLoading] = useState(false);
  const [validating, setValidating] = useState(false);
  const [resolvePrefixes, setResolvePrefixes] = useState(true);
  const [editableConstraints, setEditableConstraints] = useState<Record<string, unknown>>({});
  const [constraintDraftErrors, setConstraintDraftErrors] = useState<Record<string, string>>({});
  const [query, setQuery] = useState(DEFAULT_QUERY);
  const [querying, setQuerying] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [remoteConfig, setRemoteConfig] = useState<RemoteSourceInput>({
    mode: "remote",
    endpoint: "",
    jwtAuthEnabled: false,
    clientId: "anzograph",
    authServerUrl: "",
    username: "",
    password: "",
    jwtToken: "",
  });

  const violationKeys = useMemo(
    () => EVALUATION_KEYS.filter((key) => key !== "constraints"),
    [],
  );
  const sortedViolationKeys = useMemo(
    () => [...violationKeys].sort((leftKey, rightKey) => {
      const leftState = snapshot.evaluations[leftKey];
      const rightState = snapshot.evaluations[rightKey];
      const leftCompleted = leftState.status === "completed";
      const rightCompleted = rightState.status === "completed";

      if (leftCompleted !== rightCompleted) {
        return leftCompleted ? 1 : -1;
      }

      if (leftCompleted && rightCompleted) {
        const violationDelta = (rightState.issueCount ?? 0) - (leftState.issueCount ?? 0);
        if (violationDelta !== 0) {
          return violationDelta;
        }
      }

      return violationKeys.indexOf(leftKey) - violationKeys.indexOf(rightKey);
    }),
    [snapshot.evaluations, violationKeys],
  );
  const constraintsState = snapshot.evaluations.constraints;
  const canStartValidations = snapshot.source !== null && constraintsState.status === "completed";
  const hasInvalidConstraintDrafts = Object.keys(constraintDraftErrors).length > 0;
  const ontologyPrefixes = snapshot.source?.prefixes ?? {};
  const hasOntologyPrefixes = Object.keys(ontologyPrefixes).length > 0;
  const displayedConstraints = hasOntologyPrefixes && resolvePrefixes
    ? Object.fromEntries(
        Object.entries(constraintsState.constraints).map(([key, value]) => [
          key,
          resolvePrefixesInValue(value, ontologyPrefixes, key),
        ]),
      )
    : constraintsState.constraints;
  const displayedEditableConstraints = hasOntologyPrefixes && resolvePrefixes
    ? Object.fromEntries(
        Object.entries(editableConstraints).map(([key, value]) => [
          key,
          resolvePrefixesInValue(value, ontologyPrefixes, key),
        ]),
      )
    : editableConstraints;

  useEffect(() => {
    if (constraintsState.status === "completed") {
      setEditableConstraints(constraintsState.constraints);
    }
  }, [constraintsState.completedAt, constraintsState.status, constraintsState.constraints]);

  async function handleDiscoverConstraints(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setGraphLoading(true);
    setValidating(false);
    setQueryResult(null);
    try {
      if (mode === "local") {
        if (!selectedFile) {
          throw new Error("Choose an ontology file before starting the browser evaluation.");
        }
        const content = await selectedFile.text();
        await setSource({
          mode: "local",
          filename: selectedFile.name,
          content,
          contentType: selectedFile.type,
        });
      } else {
        if (!remoteConfig.endpoint.trim()) {
          throw new Error("Provide a SPARQL endpoint URL before starting the browser evaluation.");
        }
        await setSource({
          ...remoteConfig,
          endpoint: remoteConfig.endpoint.trim(),
        });
      }
      setGraphLoading(false);
      post({ type: "start-constraints" });
      setConstraintDraftErrors({});
      setFormError(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setGraphLoading(false);
      setSubmitting(false);
    }
  }

  async function handleStartValidations() {
    setValidating(true);
    try {
      const validationOverrides = hasOntologyPrefixes && resolvePrefixes
        ? Object.fromEntries(
            Object.entries(editableConstraints).map(([key, value]) => [
              key,
              expandPrefixesInValue(value, ontologyPrefixes, key),
            ]),
          )
        : editableConstraints;
      post({
        type: "start-validations",
        payload: {
          constraintOverrides: validationOverrides,
        },
      });
      setFormError(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setValidating(false);
    }
  }

  async function handleRunQuery() {
    setQuerying(true);
    try {
      await runQuery(query);
    } finally {
      setQuerying(false);
    }
  }

  const handleConstraintValidityChange = useCallback((criterionKey: string, error: string | null) => {
    setConstraintDraftErrors((current) => {
      if (error) {
        return current[criterionKey] === error
          ? current
          : { ...current, [criterionKey]: error };
      }
      if (!(criterionKey in current)) {
        return current;
      }
      const next = { ...current };
      delete next[criterionKey];
      return next;
    });
  }, []);

  return (
    <div className="app-shell">
      <header className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Browser-Native Ontology Validation</span>
          <h1>Web APV runs entirely in the user’s browser now.</h1>
          <p>
            Load a local ontology file or connect directly to a CORS-enabled SPARQL endpoint,
            then evaluate APV constraints without any FastAPI backend or server-side RDF runtime.
            The canonical APV vocabulary file is available below as a reference for the constraint definitions.
          </p>
          <div className="hero-actions">
            <a
              className="ghost-button download-button"
              href={APV_RDF_URL}
              download="OWL-APV.rdf"
            >
              Download OWL-APV
            </a>
          </div>
        </div>
        <div className="hero-panel">
          <div className="metric">
            <span className="metric-label">Project</span>
            <strong>
              Developed as part of a masters thesis @{" "}
              <a href="https://www.inf.ufrgs.br/" target="_blank" rel="noreferrer">
                INF-UFRGS
              </a>
            </strong>
          </div>
          <div className="metric">
            <span className="metric-label">Author</span>
            <strong>Rafael Humann Petry</strong>
          </div>
          <div className="metric">
            <span className="metric-label">Contributors</span>
            <strong>Nicolau O. Santos, Haroldo R. S. Silva, Mara Abel, Joao C. Netto</strong>
          </div>
          <button className="ghost-button" type="button" onClick={() => void requestSnapshot()}>
            Refresh Worker Snapshot
          </button>
        </div>
      </header>

      <main className="workspace">
        <section className="panel source-panel">
          <div className="panel-heading">
            <h2>Source</h2>
            <p>Choose whether the browser should parse a local ontology or talk directly to a remote endpoint.</p>
          </div>
          <form className="source-form" onSubmit={(event) => void handleDiscoverConstraints(event)}>
            <div className="mode-switch">
              <button
                className={mode === "local" ? "mode-button active" : "mode-button"}
                type="button"
                onClick={() => setMode("local")}
              >
                Local File
              </button>
              <button
                className={mode === "remote" ? "mode-button active" : "mode-button"}
                type="button"
                onClick={() => setMode("remote")}
              >
                Remote Endpoint
              </button>
            </div>

            {mode === "local" ? (
              <label className="field">
                Ontology file
                <input
                  type="file"
                  accept=".rdf,.owl,.xml,.ttl,.nt,.n3,.jsonld"
                  onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                />
              </label>
            ) : (
              <div className="remote-fields">
                <label className="field">
                  SPARQL endpoint URL
                  <input
                    type="url"
                    value={remoteConfig.endpoint}
                    onChange={(event) =>
                      setRemoteConfig((current) => ({ ...current, endpoint: event.target.value }))
                    }
                    placeholder="https://example.com/sparql"
                  />
                </label>
                <label className="field toggle-field">
                  <span className="toggle-control">
                    <input
                      type="checkbox"
                      checked={remoteConfig.jwtAuthEnabled}
                      onChange={(event) =>
                        setRemoteConfig((current) => ({ ...current, jwtAuthEnabled: event.target.checked }))
                      }
                    />
                    <span className="toggle-slider" aria-hidden="true" />
                  </span>
                  <span>Enable bearer token / Keycloak authentication</span>
                </label>
                {remoteConfig.jwtAuthEnabled ? (
                  <div className="auth-fields">
                    <label className="field">
                      Bearer token
                      <input
                        type="password"
                        value={remoteConfig.jwtToken}
                        onChange={(event) =>
                          setRemoteConfig((current) => ({ ...current, jwtToken: event.target.value }))
                        }
                      />
                    </label>
                    <div className="field-grid auth-grid">
                      <label className="field">
                        Keycloak client ID
                        <input
                          type="text"
                          value={remoteConfig.clientId ?? ""}
                          onChange={(event) =>
                            setRemoteConfig((current) => ({ ...current, clientId: event.target.value }))
                          }
                          placeholder="anzograph"
                        />
                      </label>
                      <label className="field">
                        Keycloak token endpoint
                        <input
                          type="url"
                          value={remoteConfig.authServerUrl}
                          onChange={(event) =>
                            setRemoteConfig((current) => ({ ...current, authServerUrl: event.target.value }))
                          }
                        />
                      </label>
                      <label className="field">
                        Username
                        <input
                          type="text"
                          value={remoteConfig.username}
                          onChange={(event) =>
                            setRemoteConfig((current) => ({ ...current, username: event.target.value }))
                          }
                        />
                      </label>
                      <label className="field">
                        Password
                        <input
                          type="password"
                          value={remoteConfig.password}
                          onChange={(event) =>
                            setRemoteConfig((current) => ({ ...current, password: event.target.value }))
                          }
                        />
                      </label>
                    </div>
                  </div>
                ) : null}
              </div>
            )}

            <div className="callout">
              Local ontologies are parsed entirely in the browser worker. Remote endpoints also run
              from the browser and therefore must allow CORS for direct requests.
            </div>

            {graphLoading ? (
              <div className="callout">Loading graph into the browser worker...</div>
            ) : null}

            {formError ? <div className="alert error">{formError}</div> : null}
            {sourceError ? <div className="alert error">{sourceError}</div> : null}

            <button
              className="primary-button"
              type="submit"
              disabled={submitting || graphLoading || constraintsState.status === "running"}
            >
              {graphLoading
                ? "Loading Graph..."
                : constraintsState.status === "running"
                  ? "Discovering Constraints..."
                  : mode === "local"
                    ? "Load Ontology and Discover Constraints"
                    : "Discover Constraints"}
            </button>
          </form>
        </section>

        <section className="panel constraints-panel">
          <div className="panel-heading">
            <h2>Constraint Discovery</h2>
            <p>The APV constraint phase runs first and feeds the validation checks.</p>
          </div>
          {hasOntologyPrefixes ? (
            <label className="field toggle-field constraint-toggle">
              <span className="toggle-control">
                <input
                  type="checkbox"
                  checked={resolvePrefixes}
                  onChange={(event) => setResolvePrefixes(event.target.checked)}
                />
                <span className="toggle-slider" aria-hidden="true" />
              </span>
              <span>Resolve prefixes in APV constraint values</span>
            </label>
          ) : null}
          <EvaluationCard
            state={constraintsState}
            displayValue={displayedEditableConstraints}
            defaultDisplayValue={displayedConstraints}
            editableConstraints={displayedEditableConstraints}
            onEditConstraint={(criterionKey, nextValue) =>
              setEditableConstraints((current) => ({
                ...current,
                [criterionKey]: nextValue,
              }))
            }
            onResetConstraint={(criterionKey) =>
              setEditableConstraints((current) => ({
                ...current,
                [criterionKey]: constraintsState.constraints[criterionKey],
              }))
            }
            onConstraintValidityChange={handleConstraintValidityChange}
          />
          <div className="constraints-actions">
            <button
              className="primary-button"
              type="button"
              disabled={!canStartValidations || validating || hasInvalidConstraintDrafts}
              onClick={() => void handleStartValidations()}
            >
              {validating ? "Starting evaluations..." : "Evaluate in Browser"}
            </button>
            {hasInvalidConstraintDrafts ? (
              <p className="constraint-validation-summary" role="alert">
                Correct the highlighted constraint syntax before starting the evaluation.
              </p>
            ) : null}
          </div>
        </section>

        <section className="panel violations-panel">
          <div className="panel-heading">
            <h2>Validation Checks</h2>
            <p>Each APV check exposes progress, iterations, and violation details from the browser worker.</p>
          </div>
          <div className="card-grid">
            {sortedViolationKeys.map((key) => (
              <EvaluationCard key={key} state={snapshot.evaluations[key]} />
            ))}
          </div>
        </section>

        <section className="panel query-panel">
          <div className="panel-heading">
            <h2>SPARQL Workbench</h2>
            <p>
              Remote endpoints are queried directly from the browser, and local uploaded ontologies
              run through an in-worker Oxigraph store for browser-based SPARQL execution.
            </p>
          </div>
          <div className="query-layout">
            <label className="field">
              SPARQL query
              <textarea value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <div className="query-actions">
              <button className="primary-button" type="button" onClick={() => void handleRunQuery()} disabled={querying}>
                Run Query
              </button>
            </div>
            {queryError ? <div className="alert error">{queryError}</div> : null}
            {queryResult ? (
              <QueryResultPanel result={queryResult} />
            ) : (
              <div className="empty-state">Run a query to inspect the active source.</div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}

function EvaluationCard({
  state,
  displayValue,
  editableConstraints,
  defaultDisplayValue,
  onEditConstraint,
  onResetConstraint,
  onConstraintValidityChange,
}: {
  state: EvaluationState;
  displayValue?: unknown;
  editableConstraints?: Record<string, unknown>;
  defaultDisplayValue?: Record<string, unknown>;
  onEditConstraint?: (criterionKey: string, nextValue: unknown) => void;
  onResetConstraint?: (criterionKey: string) => void;
  onConstraintValidityChange?: (criterionKey: string, error: string | null) => void;
}) {
  const purpose = CHECK_PURPOSES[state.key] ?? "APV evaluation";
  const isValidationCheck = state.kind === "violation";
  const displayLabel = APV_CONSTRAINT_INFO[state.key]?.label ?? state.label;
  const completedViolations = `${state.issueCount ?? 0} violations`;
  const inProgressLabel = state.totalIterations != null
    ? `${state.completedIterations} / ${state.totalIterations}`
    : `${Math.round(state.progressPercent)}% complete`;
  const showProgressRail = !isValidationCheck || state.status !== "completed";
  const violationVariant = (state.issueCount ?? 0) === 0 ? "zero" : "nonzero";
  const [detailsOpen, setDetailsOpen] = useState(false);
  const headerInteractionProps = isValidationCheck
    ? {
        role: "button" as const,
        tabIndex: 0,
        "aria-expanded": detailsOpen,
        onClick: () => setDetailsOpen((current) => !current),
        onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setDetailsOpen((current) => !current);
          }
        },
      }
    : {};

  return (
    <article
      className={`evaluation-card ${state.status} ${isValidationCheck ? "validation-check-card" : ""} ${detailsOpen ? "expanded" : ""}`}
    >
      <div className="card-head" {...headerInteractionProps}>
        <div>
          <span className="card-badge">{state.kind === "constraints" ? "Constraints" : "Check"}</span>
          <h3>{displayLabel}</h3>
          <p className={isValidationCheck ? "validation-check-subtitle" : undefined}>{purpose}</p>
        </div>
        <div className="card-status-group">
          <span className={`status-pill ${state.status}`}>{state.status}</span>
          {isValidationCheck && state.status === "completed" ? (
            <span className={`status-pill violation-pill ${violationVariant}`}>{completedViolations}</span>
          ) : null}
        </div>
      </div>

      {showProgressRail ? (
        <div className="progress-rail" aria-hidden="true">
          <div className="progress-bar" style={{ width: `${state.progressPercent}%` }} />
        </div>
      ) : null}

      <div className="card-meta">
        {isValidationCheck ? (
          state.status === "running" ? (
            <>
              <span>{inProgressLabel}</span>
              <span>{formatIterations(state)}</span>
            </>
          ) : state.status === "completed" ? (
            null
          ) : state.status === "error" ? (
            <span>Failed</span>
          ) : (
            <span>Waiting to start</span>
          )
        ) : (
          <>
            <span>{state.status === "completed" ? `Finished in ${formatSeconds(state.durationSeconds)}` : `ETA ${formatSeconds(state.etaSeconds)}`}</span>
            <span>{formatIterations(state)}</span>
            <span>
              {state.status === "completed"
                ? state.issueCount != null
                  ? `${state.issueCount} issues`
                  : "Completed"
                : "In progress"}
            </span>
          </>
        )}
      </div>

      {state.errorMessage ? <div className="alert error">{state.errorMessage}</div> : null}

      {state.kind === "constraints" && Object.keys(state.constraints).length > 0 ? (
        <div className="constraint-list">
          {Object.entries((displayValue as Record<string, unknown>) ?? state.constraints).map(([key, value]) => (
            editableConstraints && onEditConstraint && onResetConstraint && onConstraintValidityChange ? (
              <EditableConstraintRow
                key={key}
                criterionKey={key}
                value={value}
                hasSessionOverride={!valuesEqual(value, defaultDisplayValue?.[key])}
                onChange={(nextValue) => onEditConstraint(key, nextValue)}
                onDiscard={() => onResetConstraint(key)}
                onValidityChange={(error) => onConstraintValidityChange(key, error)}
              />
            ) : (
              <ConstraintRow key={key} criterionKey={key} value={value} />
            )
          ))}
        </div>
      ) : null}

      {state.kind === "violation" && detailsOpen ? (
        <div className="details-block">
          <div className="details-stack">
            <DetailSection label="Parameters" value={state.parameter} />
            <DetailSection label="Violations" value={state.violations} />
          </div>
        </div>
      ) : null}
    </article>
  );
}

function QueryResultPanel({ result }: { result: QueryResult }) {
  if (result.queryType === "ask") {
    return <div className="query-result">ASK result: {String(result.booleanResult)}</div>;
  }

  if (result.queryType === "select") {
    return (
      <div className="table-shell">
        <table>
          <thead>
            <tr>
              {(result.columns ?? []).map((column) => (
                <th key={column}>{column}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(result.rows ?? []).map((row, index) => (
              <tr key={`${index}-${row.join("|")}`}>
                {row.map((value, valueIndex) => (
                  <td key={`${index}-${valueIndex}`}>{value}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (result.graphText) {
    return <pre className="query-result">{result.graphText}</pre>;
  }

  return <pre className="query-result">{result.rawText ?? "No query result available."}</pre>;
}
