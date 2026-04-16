import languageTags from "language-tags";
import initOxigraph, * as oxigraph from "oxigraph/web.js";
import oxigraphWasmUrl from "oxigraph/web_bg.wasm?url";

import { EVALUATION_KEYS, KEYCLOAK_CLIENT_ID, KEYCLOAK_SCOPE } from "../constants";
import type {
  EvaluationKey,
  EvaluationSnapshot,
  EvaluationState,
  QueryResult,
  RemoteSourceInput,
  SourceInput,
  SourceSummary,
} from "../types";

type RdfTerm = oxigraph.Term;
type NamedNode = oxigraph.NamedNode;
type Literal = oxigraph.Literal;
type Statement = oxigraph.Quad;
type Store = oxigraph.Store;
type ProgressReporter = (completed: number, total: number) => void;

type LocalRuntimeSource = {
  mode: "local";
  store: Store;
  summary: SourceSummary;
};

type RemoteRuntimeSource = {
  mode: "remote";
  summary: SourceSummary;
  config: RemoteSourceInput;
  authHeader?: string;
  refreshToken?: string;
  tokenExpiresAt?: string;
};

export type RuntimeSource = LocalRuntimeSource | RemoteRuntimeSource;

export interface ConstraintContext {
  classUriFormationRule: string | null;
  relationUriFormationRule: string | null;
  instanceUriFormationRule: string | null;
  languageTags: string[];
  classAnnotationCardinalities: Array<[string, number]>;
  relationAnnotationCardinalities: Array<[string, number]>;
  instanceAnnotationCardinalities: Array<[string, number]>;
  minAnnotationLengths: Array<[string, number]>;
  maxAnnotationLengths: Array<[string, number]>;
  annotationRegexExpressions: Array<[string, string]>;
  instanceCoverageRequirements: Array<[string, Array<[string, number]>]>;
}

export interface ValidationResult {
  parameter: unknown;
  violations: unknown[];
  totalIterations: number | null;
  completedIterations: number | null;
}

const CONSTRAINTS_KEY = "constraints";
const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  rdf: "application/rdf+xml",
  owl: "application/rdf+xml",
  xml: "application/rdf+xml",
  ttl: "text/turtle",
  nt: "application/n-triples",
  n3: "text/n3",
  jsonld: "application/ld+json",
};

const ESTIMATES: Record<EvaluationKey, number> = {
  constraints: 6,
  ClassURIFormationRule: 7,
  RelationURIFormationRule: 7,
  InstanceURIFormationRule: 8,
  GlobalMinLanguageCoverage: 3,
  ClassMinAnnotationCoverage: 20,
  RelationMinAnnotationCoverage: 20,
  InstanceMinAnnotationCoverage: 22,
  MinAnnotationLength: 12,
  MaxAnnotationLength: 12,
  AnnotationRegularExpression: 14,
  InstanceOfMinAnnotationCoverage: 22,
};

const PREFIX_MAP: Record<string, string> = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
  skos: "http://www.w3.org/2004/02/skos/core#",
  apv: "http://inf.ufrgs.br/ontologies/apv#",
};

const OXIGRAPH_INIT = initOxigraph(oxigraphWasmUrl);

function rdf(localName: string): NamedNode {
  return oxigraph.namedNode(`${PREFIX_MAP.rdf}${localName}`);
}

function owl(localName: string): NamedNode {
  return oxigraph.namedNode(`${PREFIX_MAP.owl}${localName}`);
}

function apv(localName: string): NamedNode {
  return oxigraph.namedNode(`${PREFIX_MAP.apv}${localName}`);
}

export function createEmptySnapshot(): EvaluationSnapshot {
  return {
    source: null,
    evaluations: Object.fromEntries(
      EVALUATION_KEYS.map((key) => [key, buildEvaluationShell(key)]),
    ) as Record<EvaluationKey, EvaluationState>,
  };
}

export function buildEvaluationShell(key: EvaluationKey): EvaluationState {
  const kind = key === CONSTRAINTS_KEY ? "constraints" : "violation";
  return {
    key,
    label: key === CONSTRAINTS_KEY ? "APV Constraints" : key,
    kind,
    status: "pending",
    progressPercent: 0,
    estimatedSeconds: ESTIMATES[key],
    etaSeconds: ESTIMATES[key],
    startedAt: null,
    completedAt: null,
    durationSeconds: null,
    completedIterations: 0,
    totalIterations: null,
    remainingIterations: null,
    issueCount: null,
    parameter: null,
    constraints: {},
    violations: [],
    errorMessage: null,
  };
}

export async function createRuntimeSource(input: SourceInput): Promise<RuntimeSource> {
  if (input.mode === "local") {
    await OXIGRAPH_INIT;
    const store = new oxigraph.Store();
    const base = `https://web-apv.local/${encodeURIComponent(input.filename)}`;
    const contentType = inferContentType(input.filename, input.contentType);
    const prefixes = extractOntologyPrefixes(input.content);
    store.load(input.content, {
      base_iri: base,
      format: contentType,
    });
    return {
      mode: "local",
      store,
      summary: {
        mode: "local",
        title: `Local ontology graph: ${input.filename}`,
        filename: input.filename,
        prefixes,
      },
    };
  }

  return {
    mode: "remote",
    summary: {
      mode: "remote",
      title: `Remote SPARQL endpoint: ${input.endpoint}`,
      endpoint: input.endpoint,
      prefixes: {},
    },
    config: input,
  };
}

function extractOntologyPrefixes(content: string): Record<string, string> {
  const prefixes = new Map<string, string>();

  for (const match of content.matchAll(/xmlns:([A-Za-z][\w.-]*)="([^"]+)"/g)) {
    prefixes.set(match[1], match[2]);
  }
  for (const match of content.matchAll(/@prefix\s+([A-Za-z][\w.-]*):\s*<([^>]+)>\s*\./gi)) {
    prefixes.set(match[1], match[2]);
  }
  for (const match of content.matchAll(/\bPREFIX\s+([A-Za-z][\w.-]*):\s*<([^>]+)>/gi)) {
    prefixes.set(match[1], match[2]);
  }

  return Object.fromEntries(
    [...prefixes.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

export async function collectConstraintContext(
  source: RuntimeSource,
  progress: ProgressReporter,
): Promise<ConstraintContext> {
  const steps: Array<[keyof ConstraintContext, () => Promise<ConstraintContext[keyof ConstraintContext]>]> = [
    ["classUriFormationRule", async () => retrieveClassUriFormationRule(source)],
    ["relationUriFormationRule", async () => retrieveRelationUriFormationRule(source)],
    ["instanceUriFormationRule", async () => retrieveInstanceUriFormationRule(source)],
    ["languageTags", async () => retrieveLanguageTags(source)],
    ["classAnnotationCardinalities", async () => retrieveClassAnnotationCoverage(source)],
    ["relationAnnotationCardinalities", async () => retrieveRelationAnnotationCoverage(source)],
    ["instanceAnnotationCardinalities", async () => retrieveInstanceAnnotationCoverage(source)],
    ["minAnnotationLengths", async () => retrieveMinAnnotationLength(source)],
    ["maxAnnotationLengths", async () => retrieveMaxAnnotationLength(source)],
    ["annotationRegexExpressions", async () => retrieveAnnotationRegularExpression(source)],
    ["instanceCoverageRequirements", async () => retrieveInstanceOfAnnotationCoverage(source)],
  ];

  const context = {} as ConstraintContext;
  for (const [index, [key, fn]] of steps.entries()) {
    context[key] = await fn() as never;
    progress(index + 1, steps.length);
  }
  return context;
}

export function buildConstraintsView(context: ConstraintContext): Record<string, unknown> {
  return {
    ClassURIFormationRule: context.classUriFormationRule,
    RelationURIFormationRule: context.relationUriFormationRule,
    InstanceURIFormationRule: context.instanceUriFormationRule,
    GlobalMinLanguageCoverage: context.languageTags,
    ClassMinAnnotationCoverage: context.classAnnotationCardinalities,
    RelationMinAnnotationCoverage: context.relationAnnotationCardinalities,
    InstanceMinAnnotationCoverage: context.instanceAnnotationCardinalities,
    MinAnnotationLength: context.minAnnotationLengths,
    MaxAnnotationLength: context.maxAnnotationLengths,
    AnnotationRegularExpression: context.annotationRegexExpressions,
    InstanceOfMinAnnotationCoverage: context.instanceCoverageRequirements,
  };
}

export function applyConstraintOverrides(
  baseContext: ConstraintContext,
  overrides?: Record<string, unknown>,
): ConstraintContext {
  if (!overrides) {
    return baseContext;
  }

  return {
    classUriFormationRule: readStringOverride(overrides.ClassURIFormationRule, baseContext.classUriFormationRule),
    relationUriFormationRule: readStringOverride(overrides.RelationURIFormationRule, baseContext.relationUriFormationRule),
    instanceUriFormationRule: readStringOverride(overrides.InstanceURIFormationRule, baseContext.instanceUriFormationRule),
    languageTags: readStringArrayOverride(overrides.GlobalMinLanguageCoverage, baseContext.languageTags),
    classAnnotationCardinalities: readPairNumberArrayOverride(
      overrides.ClassMinAnnotationCoverage,
      baseContext.classAnnotationCardinalities,
    ),
    relationAnnotationCardinalities: readPairNumberArrayOverride(
      overrides.RelationMinAnnotationCoverage,
      baseContext.relationAnnotationCardinalities,
    ),
    instanceAnnotationCardinalities: readPairNumberArrayOverride(
      overrides.InstanceMinAnnotationCoverage,
      baseContext.instanceAnnotationCardinalities,
    ),
    minAnnotationLengths: readPairNumberArrayOverride(overrides.MinAnnotationLength, baseContext.minAnnotationLengths),
    maxAnnotationLengths: readPairNumberArrayOverride(overrides.MaxAnnotationLength, baseContext.maxAnnotationLengths),
    annotationRegexExpressions: readPairStringArrayOverride(
      overrides.AnnotationRegularExpression,
      baseContext.annotationRegexExpressions,
    ),
    instanceCoverageRequirements: readNestedCoverageOverride(
      overrides.InstanceOfMinAnnotationCoverage,
      baseContext.instanceCoverageRequirements,
    ),
  };
}

function readStringOverride(value: unknown, fallback: string | null): string | null {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim() || null;
}

function readStringArrayOverride(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return fallback;
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function readPairNumberArrayOverride(value: unknown, fallback: Array<[string, number]>): Array<[string, number]> {
  if (!Array.isArray(value)) {
    return fallback;
  }
  const normalized = value
    .filter((item): item is [unknown, unknown] => Array.isArray(item) && item.length === 2)
    .map(([left, right]) => [resolveConfiguredIri(String(left).trim()), Number(right)] as [string, number])
    .filter(([left, right]) => Boolean(left) && Number.isFinite(right));
  return normalized;
}

function readPairStringArrayOverride(value: unknown, fallback: Array<[string, string]>): Array<[string, string]> {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value
    .filter((item): item is [unknown, unknown] => Array.isArray(item) && item.length === 2)
    .map(([left, right]) => [resolveConfiguredIri(String(left).trim()), String(right)] as [string, string])
    .filter(([left, right]) => Boolean(left) && Boolean(right));
}

function readNestedCoverageOverride(
  value: unknown,
  fallback: Array<[string, Array<[string, number]>]>,
): Array<[string, Array<[string, number]>]> {
  if (!Array.isArray(value)) {
    return fallback;
  }
  return value
    .filter((item): item is [unknown, unknown] => Array.isArray(item) && item.length === 2)
    .map(([classIri, entries]) => [
      resolveConfiguredIri(String(classIri).trim()),
      readPairNumberArrayOverride(entries, []),
    ] as [string, Array<[string, number]>])
    .filter(([classIri]) => Boolean(classIri));
}

export async function runValidationCheck(
  source: RuntimeSource,
  checkName: EvaluationKey,
  context: ConstraintContext,
  progress: ProgressReporter,
): Promise<ValidationResult> {
  switch (checkName) {
    case "ClassURIFormationRule":
      return {
        parameter: context.classUriFormationRule,
        violations: await checkClassUriFormationRule(source, context.classUriFormationRule, progress),
        totalIterations: null,
        completedIterations: null,
      };
    case "RelationURIFormationRule":
      return {
        parameter: context.relationUriFormationRule,
        violations: await checkRelationUriFormationRule(source, context.relationUriFormationRule, progress),
        totalIterations: null,
        completedIterations: null,
      };
    case "InstanceURIFormationRule":
      return {
        parameter: context.instanceUriFormationRule,
        violations: await checkInstanceUriFormationRule(source, context.instanceUriFormationRule, progress),
        totalIterations: null,
        completedIterations: null,
      };
    case "GlobalMinLanguageCoverage":
      progress(1, 1);
      return {
        parameter: context.languageTags,
        violations: [],
        totalIterations: 1,
        completedIterations: 1,
      };
    case "ClassMinAnnotationCoverage":
      return checkClassMinAnnotationCoverage(source, context, progress);
    case "RelationMinAnnotationCoverage":
      return checkRelationMinAnnotationCoverage(source, context, progress);
    case "InstanceMinAnnotationCoverage":
      return checkInstanceMinAnnotationCoverage(source, context, progress);
    case "MinAnnotationLength":
      return checkMinAnnotationLength(source, context.minAnnotationLengths, progress);
    case "MaxAnnotationLength":
      return checkMaxAnnotationLength(source, context.maxAnnotationLengths, progress);
    case "AnnotationRegularExpression":
      return checkAnnotationRegularExpression(source, context.annotationRegexExpressions, progress);
    case "InstanceOfMinAnnotationCoverage":
      return checkInstanceOfMinAnnotationCoverage(source, context, progress);
    default:
      throw new Error(`Unknown APV validation check: ${checkName}`);
  }
}

export async function runBrowserQuery(source: RuntimeSource, query: string): Promise<QueryResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    throw new Error("Enter a SPARQL query before running it.");
  }

  if (source.mode === "local") {
    return runLocalQuery(source, trimmed);
  }

  return runRemoteQuery(source, trimmed);
}

function inferContentType(filename: string, contentType?: string): string {
  if (contentType && contentType.trim()) {
    return contentType;
  }
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? "application/rdf+xml";
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseDurationSeconds(startedAt: string | null): number | null {
  if (!startedAt) {
    return null;
  }
  return (Date.now() - new Date(startedAt).getTime()) / 1000;
}

function detectQueryType(query: string): QueryResult["queryType"] {
  const match = query.match(/\b(select|ask|construct|describe)\b/i);
  return (match?.[1]?.toLowerCase() as QueryResult["queryType"]) ?? "unknown";
}

function ensureNamedNode(term: RdfTerm | null | undefined): NamedNode | null {
  return term && term.termType === "NamedNode" ? (term as NamedNode) : null;
}

function ensureLiteral(term: RdfTerm | null | undefined): Literal | null {
  return term && term.termType === "Literal" ? (term as Literal) : null;
}

function resolveConfiguredIri(value: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.includes("://")) {
    const [prefix, local] = value.split(":", 2);
    const namespace = PREFIX_MAP[prefix];
    if (!namespace) {
      throw new Error(`Unsupported prefixed IRI '${value}'. Use a full IRI or one of: ${Object.keys(PREFIX_MAP).join(", ")}.`);
    }
    return `${namespace}${local}`;
  }
  return value;
}

function normalizeAnnotationLiteral(term: RdfTerm): string {
  return term.value;
}

function dedupeNamedNodes(nodes: Array<RdfTerm | null | undefined>): NamedNode[] {
  const unique = new Map<string, NamedNode>();
  for (const node of nodes) {
    const named = ensureNamedNode(node);
    if (named) {
      unique.set(named.value, named);
    }
  }
  return [...unique.values()];
}

function getOntologyNode(store: Store): NamedNode | null {
  return dedupeNamedNodes(store.match(null, rdf("type"), owl("Ontology"), null).map((quad) => quad.subject))[0] ?? null;
}

function getNamedNodesByType(store: Store, types: NamedNode[]): NamedNode[] {
  return dedupeNamedNodes(types.flatMap((type) => store.match(null, rdf("type"), type, null).map((quad) => quad.subject)));
}

function getClassNodes(store: Store): NamedNode[] {
  return getNamedNodesByType(store, [owl("Class")]);
}

function getRelationNodes(store: Store): NamedNode[] {
  return getNamedNodesByType(store, [owl("ObjectProperty"), owl("DatatypeProperty"), owl("AnnotationProperty")]);
}

function getAnnotationPropertyNodes(store: Store): NamedNode[] {
  return getNamedNodesByType(store, [owl("AnnotationProperty")]);
}

function getInstanceNodes(store: Store): NamedNode[] {
  const classSet = new Set(getClassNodes(store).map((term) => term.value));
  const candidates = store.match(null, rdf("type"), null, null)
    .filter((statement) => ensureNamedNode(statement.subject) && ensureNamedNode(statement.object))
    .filter((statement) => classSet.has(statement.object.value))
    .map((statement) => statement.subject);
  return dedupeNamedNodes(candidates);
}

function getObjects(store: Store, subject: NamedNode, predicate: NamedNode): RdfTerm[] {
  return store.match(subject, predicate, null, null).map((quad) => quad.object);
}

function countAnnotationValues(
  store: Store,
  subject: NamedNode,
  predicateIri: string,
  requiredLang?: string,
): number {
  const predicate = oxigraph.namedNode(predicateIri);
  const values = getObjects(store, subject, predicate);
  if (!requiredLang) {
    return values.length;
  }
  return values.filter((value) => ensureLiteral(value)?.language.toLowerCase() === requiredLang.toLowerCase()).length;
}

function getAnnotationSubjects(store: Store, predicateIri: string): Statement[] {
  return store.match(null, oxigraph.namedNode(predicateIri), null, null)
    .filter((statement) => ensureNamedNode(statement.subject) !== null);
}

function getFirstObject(store: Store, subject: NamedNode, predicate: NamedNode): RdfTerm | null {
  return getObjects(store, subject, predicate)[0] ?? null;
}

async function runSelectRemote(
  source: RemoteRuntimeSource,
  query: string,
): Promise<Array<Record<string, RdfTerm>>> {
  const response = await executeRemoteQuery(source, query, "application/sparql-results+json", "json");
  const payload = JSON.parse(response.body) as {
    head?: { vars?: string[] };
    results?: { bindings?: Array<Record<string, { type: string; value: string; ["xml:lang"]?: string; datatype?: string }>> };
  };
  const variables = payload.head?.vars ?? [];
  return (payload.results?.bindings ?? []).map((binding) => {
    const row: Record<string, RdfTerm> = {};
    for (const variable of variables) {
      const value = binding[variable];
      if (!value) {
        continue;
      }
      if (value.type === "uri") {
        row[variable] = oxigraph.namedNode(value.value);
      } else if (value.type === "bnode") {
        row[variable] = oxigraph.blankNode(value.value);
      } else {
        row[variable] = value["xml:lang"]
          ? (oxigraph.literal(value.value, value["xml:lang"]) as unknown as RdfTerm)
          : value.datatype
            ? (oxigraph.literal(value.value, oxigraph.namedNode(value.datatype)) as unknown as RdfTerm)
            : (oxigraph.literal(value.value) as unknown as RdfTerm);
      }
    }
    return row;
  });
}

async function executeRemoteQuery(
  source: RemoteRuntimeSource,
  query: string,
  accept: string,
  format: string,
): Promise<{ body: string; contentType: string }> {
  const authHeader = await resolveRemoteAuthHeader(source, false);
  let response: Response;
  try {
    response = await fetch(source.config.endpoint, {
      method: "POST",
      headers: {
        Accept: accept,
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
      body: new URLSearchParams({ query, format }).toString(),
    });
  } catch (error) {
    throw new Error(buildNetworkErrorMessage("SPARQL endpoint", source.config.endpoint, error));
  }

  if (response.status === 401 && source.config.jwtAuthEnabled) {
    const retryAuth = await resolveRemoteAuthHeader(source, true);
    let retry: Response;
    try {
      retry = await fetch(source.config.endpoint, {
        method: "POST",
        headers: {
          Accept: accept,
          "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
          ...(retryAuth ? { Authorization: retryAuth } : {}),
        },
        body: new URLSearchParams({ query, format }).toString(),
      });
    } catch (error) {
      throw new Error(buildNetworkErrorMessage("SPARQL endpoint", source.config.endpoint, error));
    }
    if (!retry.ok) {
      throw new Error(await formatRemoteError(retry));
    }
    return {
      body: await retry.text(),
      contentType: retry.headers.get("content-type") ?? "text/plain",
    };
  }

  if (!response.ok) {
    throw new Error(await formatRemoteError(response));
  }

  return {
    body: await response.text(),
    contentType: response.headers.get("content-type") ?? "text/plain",
  };
}

async function formatRemoteError(response: Response): Promise<string> {
  const detail = await response.text();
  return `SPARQL server returned HTTP ${response.status}: ${detail || response.statusText}`;
}

async function resolveRemoteAuthHeader(source: RemoteRuntimeSource, forceRefresh: boolean): Promise<string | undefined> {
  if (!source.config.jwtAuthEnabled) {
    return undefined;
  }
  const clientId = source.config.clientId?.trim() || KEYCLOAK_CLIENT_ID;

  if (source.authHeader && !forceRefresh && !tokenIsExpiring(source.tokenExpiresAt)) {
    return source.authHeader;
  }

  if (source.config.jwtToken?.trim() && !forceRefresh) {
    source.authHeader = `Bearer ${source.config.jwtToken.trim()}`;
    return source.authHeader;
  }

  if (source.refreshToken && source.config.authServerUrl) {
    const payload = await requestKeycloakToken(source.config.authServerUrl, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: source.refreshToken,
      ...(KEYCLOAK_SCOPE ? { scope: KEYCLOAK_SCOPE } : {}),
    });
    applyTokenPayload(source, payload);
    return source.authHeader;
  }

  if (source.config.authServerUrl && source.config.username && source.config.password) {
    const payload = await requestKeycloakToken(source.config.authServerUrl, {
      grant_type: "password",
      client_id: clientId,
      username: source.config.username,
      password: source.config.password,
      ...(KEYCLOAK_SCOPE ? { scope: KEYCLOAK_SCOPE } : {}),
    });
    applyTokenPayload(source, payload);
    return source.authHeader;
  }

  if (source.config.jwtToken?.trim()) {
    source.authHeader = `Bearer ${source.config.jwtToken.trim()}`;
    return source.authHeader;
  }

  throw new Error(
    "This JWT-authenticated SPARQL session cannot be renewed in the browser. Provide a bearer token or a CORS-enabled Keycloak token endpoint with credentials.",
  );
}

async function requestKeycloakToken(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      body: new URLSearchParams(body).toString(),
    });
  } catch (error) {
    throw new Error(buildNetworkErrorMessage("Keycloak token endpoint", url, error));
  }
  if (!response.ok) {
    throw new Error(`Could not retrieve a JWT token: HTTP ${response.status}: ${await response.text()}`);
  }
  return await response.json() as Record<string, unknown>;
}

function buildNetworkErrorMessage(targetLabel: string, url: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  const origin = typeof globalThis.location?.origin === "string" ? globalThis.location.origin : "this app origin";
  return `Could not reach the ${targetLabel} at ${url} from ${origin}. For remote authenticated SPARQL access, this usually means the server or gateway is rejecting browser CORS/preflight requests for this origin or the Authorization header. It can also be a network, TLS/certificate, or mixed-content issue. Browser error: ${detail}`;
}

function applyTokenPayload(source: RemoteRuntimeSource, payload: Record<string, unknown>): void {
  const accessToken = String(payload.access_token ?? "");
  if (!accessToken) {
    throw new Error("The authentication server response did not include an access token.");
  }
  source.authHeader = `Bearer ${accessToken}`;
  source.refreshToken = typeof payload.refresh_token === "string" ? payload.refresh_token : undefined;
  const expiresIn = Number(payload.expires_in ?? 0);
  if (Number.isFinite(expiresIn) && expiresIn > 0) {
    source.tokenExpiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
  }
}

function tokenIsExpiring(expiresAt?: string): boolean {
  if (!expiresAt) {
    return false;
  }
  return new Date(expiresAt).getTime() <= Date.now() + 30_000;
}

async function runRemoteQuery(source: RemoteRuntimeSource, query: string): Promise<QueryResult> {
  const queryType = detectQueryType(query);
  const response = await executeRemoteQuery(
    source,
    query,
    queryType === "construct" || queryType === "describe"
      ? "application/n-triples, text/turtle; q=0.9, text/plain; q=0.8"
      : "application/sparql-results+json",
    queryType === "construct" || queryType === "describe" ? "nt" : "json",
  );

  if (queryType === "construct" || queryType === "describe") {
    return {
      queryType,
      graphText: response.body,
    };
  }

  const payload = JSON.parse(response.body) as {
    boolean?: boolean;
    head?: { vars?: string[] };
    results?: { bindings?: Array<Record<string, { value: string }>> };
  };
  if (typeof payload.boolean === "boolean") {
    return {
      queryType: "ask",
      booleanResult: payload.boolean,
    };
  }
  const columns = payload.head?.vars ?? [];
  const rows = (payload.results?.bindings ?? []).map((binding) =>
    columns.map((column) => binding[column]?.value ?? ""),
  );
  return {
    queryType: "select",
    columns,
    rows,
  };
}

async function runLocalQuery(source: LocalRuntimeSource, query: string): Promise<QueryResult> {
  const queryType = detectQueryType(query);
  if (queryType === "ask") {
    const result = source.store.query(query);
    if (typeof result !== "boolean") {
      throw new Error("The local SPARQL ASK query did not return a boolean result.");
    }
    return {
      queryType: "ask",
      booleanResult: result,
    };
  }

  if (queryType === "construct" || queryType === "describe") {
    const result = source.store.query(query);
    if (!Array.isArray(result) || (result.length > 0 && !("subject" in result[0]))) {
      throw new Error("The local SPARQL graph query did not return quads.");
    }
    return {
      queryType,
      graphText: result.map((quad) => quad.toString()).join("\n"),
    };
  }

  const result = source.store.query(query);
  if (!Array.isArray(result) || (result.length > 0 && !(result[0] instanceof Map))) {
    throw new Error("The local SPARQL SELECT query did not return bindings.");
  }
  const bindings = result as Map<string, RdfTerm>[];
  const columns = [...new Set(bindings.flatMap((row) => [...row.keys()]))];
  const rows = bindings.map((row) => columns.map((column) => row.get(column)?.value ?? ""));

  return {
    queryType: "select",
    columns,
    rows,
  };
}

async function querySingleValue(source: RuntimeSource, query: string, variable: string): Promise<string | null> {
  if (source.mode === "local") {
    const result = source.store.query(query);
    if (!Array.isArray(result) || (result.length > 0 && !(result[0] instanceof Map))) {
      throw new Error("The local SPARQL query did not return bindings.");
    }
    return (result[0] as Map<string, RdfTerm> | undefined)?.get(variable)?.value?.trim() ?? null;
  }
  const rows = await runSelectRemote(source, query);
  const value = rows[0]?.[variable];
  return value ? value.value.trim() : null;
}

async function queryRows(source: RuntimeSource, query: string): Promise<Array<Record<string, RdfTerm>>> {
  if (source.mode === "local") {
    const result = source.store.query(query);
    if (!Array.isArray(result) || (result.length > 0 && !(result[0] instanceof Map))) {
      throw new Error("The local SPARQL query did not return bindings.");
    }
    return (result as Map<string, RdfTerm>[]).map((binding) =>
      Object.fromEntries(binding.entries()) as Record<string, RdfTerm>
    );
  }
  return runSelectRemote(source, query);
}

async function retrieveLanguageTags(source: RuntimeSource): Promise<string[]> {
  if (source.mode === "local") {
    const ontology = getOntologyNode(source.store);
    if (!ontology) {
      return [];
    }
    const raw = ensureLiteral(getFirstObject(source.store, ontology, apv("GlobalMinLanguageCoverage")))?.value.trim() ?? "";
    return validateLanguageTags(raw ? raw.split(/\s+/) : []);
  }
  const raw = await querySingleValue(source, `
    PREFIX owl: <${PREFIX_MAP.owl}>
    PREFIX apv: <${PREFIX_MAP.apv}>
    SELECT ?gmlc WHERE {
      ?o a owl:Ontology ;
         apv:GlobalMinLanguageCoverage ?gmlc .
    }
  `, "gmlc");
  return validateLanguageTags(raw ? raw.split(/\s+/) : []);
}

function validateLanguageTags(tags: string[]): string[] {
  for (const tag of tags) {
    if (!languageTags.check(tag)) {
      throw new Error(`Invalid language tag in GlobalMinLanguageCoverage: '${tag}'`);
    }
  }
  return tags;
}

async function retrieveRegexConstraint(source: RuntimeSource, predicate: NamedNode, label: string): Promise<string | null> {
  if (source.mode === "local") {
    const ontology = getOntologyNode(source.store);
    if (!ontology) {
      return null;
    }
    const value = ensureLiteral(getFirstObject(source.store, ontology, predicate))?.value.trim() ?? "";
    if (!value) {
      return null;
    }
    compileRegex(value, label);
    return value;
  }
  const variable = label === "ClassURIFormationRule" ? "cfre" : label === "RelationURIFormationRule" ? "rfre" : "ifre";
  const raw = await querySingleValue(source, `
    PREFIX owl: <${PREFIX_MAP.owl}>
    PREFIX apv: <${PREFIX_MAP.apv}>
    SELECT ?${variable} WHERE {
      ?o a owl:Ontology ;
         apv:${label} ?${variable} .
    }
  `, variable);
  if (!raw) {
    return null;
  }
  compileRegex(raw, label);
  return raw;
}

async function retrieveClassUriFormationRule(source: RuntimeSource): Promise<string | null> {
  return retrieveRegexConstraint(source, apv("ClassURIFormationRule"), "ClassURIFormationRule");
}

async function retrieveRelationUriFormationRule(source: RuntimeSource): Promise<string | null> {
  return retrieveRegexConstraint(source, apv("RelationURIFormationRule"), "RelationURIFormationRule");
}

async function retrieveInstanceUriFormationRule(source: RuntimeSource): Promise<string | null> {
  return retrieveRegexConstraint(source, apv("InstanceURIFormationRule"), "InstanceURIFormationRule");
}

function parseCoverageTokens(raw: string, label: string): Array<[string, number]> {
  if (!raw.trim()) {
    return [];
  }
  return raw.trim().split(/\s+/).map((token) => {
    if (/^\d+\^[\w:./-]+$/.test(token)) {
      const [cardinality, annotationIri] = token.split("^");
      return [resolveConfiguredIri(annotationIri), Number(cardinality)];
    }
    if (/^[\w:./-]+$/.test(token)) {
      return [resolveConfiguredIri(token), 1];
    }
    throw new Error(`Invalid format for ${label}: '${token}'`);
  });
}

async function retrieveCoverageSetting(source: RuntimeSource, predicateLabel: string, variable: string): Promise<Array<[string, number]>> {
  if (source.mode === "local") {
    const ontology = getOntologyNode(source.store);
    if (!ontology) {
      return [];
    }
    const raw = ensureLiteral(getFirstObject(source.store, ontology, apv(predicateLabel)))?.value ?? "";
    return parseCoverageTokens(raw, predicateLabel);
  }
  const raw = await querySingleValue(source, `
    PREFIX owl: <${PREFIX_MAP.owl}>
    PREFIX apv: <${PREFIX_MAP.apv}>
    SELECT ?${variable} WHERE {
      ?o a owl:Ontology ;
         apv:${predicateLabel} ?${variable} .
    }
  `, variable);
  return parseCoverageTokens(raw ?? "", predicateLabel);
}

async function retrieveClassAnnotationCoverage(source: RuntimeSource): Promise<Array<[string, number]>> {
  return retrieveCoverageSetting(source, "ClassMinAnnotationCoverage", "cmac");
}

async function retrieveRelationAnnotationCoverage(source: RuntimeSource): Promise<Array<[string, number]>> {
  return retrieveCoverageSetting(source, "RelationMinAnnotationCoverage", "rmac");
}

async function retrieveInstanceAnnotationCoverage(source: RuntimeSource): Promise<Array<[string, number]>> {
  return retrieveCoverageSetting(source, "InstanceMinAnnotationCoverage", "imac");
}

async function retrieveMinAnnotationLength(source: RuntimeSource): Promise<Array<[string, number]>> {
  if (source.mode === "local") {
    return getAnnotationPropertyNodes(source.store).flatMap((property) =>
      getObjects(source.store, property, apv("MinAnnotationLength"))
        .map((term) => ensureLiteral(term)?.value)
        .filter((value): value is string => Boolean(value))
        .map((value) => [property.value, Number(value)] as [string, number]),
    );
  }
  const rows = await queryRows(source, `
    PREFIX owl: <${PREFIX_MAP.owl}>
    PREFIX apv: <${PREFIX_MAP.apv}>
    SELECT ?ap ?mal WHERE {
      ?ap a owl:AnnotationProperty ;
          apv:MinAnnotationLength ?mal .
    }
  `);
  return rows.map((row) => [row.ap.value, Number(row.mal.value)]);
}

async function retrieveMaxAnnotationLength(source: RuntimeSource): Promise<Array<[string, number]>> {
  if (source.mode === "local") {
    return getAnnotationPropertyNodes(source.store).flatMap((property) =>
      getObjects(source.store, property, apv("MaxAnnotationLength"))
        .map((term) => ensureLiteral(term)?.value)
        .filter((value): value is string => Boolean(value))
        .map((value) => [property.value, Number(value)] as [string, number]),
    );
  }
  const rows = await queryRows(source, `
    PREFIX owl: <${PREFIX_MAP.owl}>
    PREFIX apv: <${PREFIX_MAP.apv}>
    SELECT ?ap ?mal WHERE {
      ?ap a owl:AnnotationProperty ;
          apv:MaxAnnotationLength ?mal .
    }
  `);
  return rows.map((row) => [row.ap.value, Number(row.mal.value)]);
}

async function retrieveAnnotationRegularExpression(source: RuntimeSource): Promise<Array<[string, string]>> {
  if (source.mode === "local") {
    return getAnnotationPropertyNodes(source.store).flatMap((property) =>
      getObjects(source.store, property, apv("AnnotationRegularExpression"))
        .map((term) => ensureLiteral(term)?.value.trim())
        .filter((value): value is string => Boolean(value))
        .map((pattern) => {
          compileRegex(pattern, `AnnotationRegularExpression on ${property.value}`);
          return [property.value, pattern] as [string, string];
        }),
    );
  }
  const rows = await queryRows(source, `
    PREFIX owl: <${PREFIX_MAP.owl}>
    PREFIX apv: <${PREFIX_MAP.apv}>
    SELECT ?ap ?are WHERE {
      ?ap a owl:AnnotationProperty ;
          apv:AnnotationRegularExpression ?are .
    }
  `);
  return rows.map((row) => {
    compileRegex(row.are.value, `AnnotationRegularExpression on ${row.ap.value}`);
    return [row.ap.value, row.are.value];
  });
}

async function retrieveInstanceOfAnnotationCoverage(source: RuntimeSource): Promise<Array<[string, Array<[string, number]>]>> {
  if (source.mode === "local") {
    return getClassNodes(source.store).flatMap((classNode) =>
      getObjects(source.store, classNode, apv("InstanceOfMinAnnotationCoverage"))
        .map((term) => ensureLiteral(term)?.value)
        .filter((value): value is string => Boolean(value))
        .map((raw) => [classNode.value, parseCoverageTokens(raw, `InstanceOfMinAnnotationCoverage on ${classNode.value}`)] as [string, Array<[string, number]>]),
    );
  }
  const rows = await queryRows(source, `
    PREFIX owl: <${PREFIX_MAP.owl}>
    PREFIX apv: <${PREFIX_MAP.apv}>
    SELECT ?class ?ioac WHERE {
      ?class a owl:Class ;
             apv:InstanceOfMinAnnotationCoverage ?ioac .
    }
  `);
  return rows.map((row) => [row.class.value, parseCoverageTokens(row.ioac.value, `InstanceOfMinAnnotationCoverage on ${row.class.value}`)]);
}

function parseRegexPattern(pattern: string, label: string): { source: string; flags: string } {
  const trimmed = pattern.trim();
  if (!trimmed) {
    throw new Error(`Invalid regex pattern for ${label}: the pattern is empty.`);
  }
  if (!trimmed.startsWith("/")) {
    return { source: trimmed, flags: "" };
  }

  let closingSlashIndex = -1;
  let escaping = false;
  for (let index = trimmed.length - 1; index > 0; index -= 1) {
    const char = trimmed[index];
    if (char === "/" && !escaping) {
      closingSlashIndex = index;
      break;
    }
    escaping = char === "\\" ? !escaping : false;
  }

  if (closingSlashIndex <= 0) {
    throw new Error(`Invalid regex pattern for ${label}: '${pattern}' - missing closing slash.`);
  }

  const source = trimmed.slice(1, closingSlashIndex);
  const flags = trimmed.slice(closingSlashIndex + 1);
  if (!source) {
    throw new Error(`Invalid regex pattern for ${label}: '${pattern}' - empty regex body.`);
  }
  if (flags && !/^[dgimsuvy]*$/.test(flags)) {
    throw new Error(`Invalid regex pattern for ${label}: '${pattern}' - unsupported flags '${flags}'.`);
  }

  return { source, flags };
}

function compileRegex(pattern: string, label: string, options?: { matchEntireValue?: boolean }): RegExp {
  try {
    const { source, flags } = parseRegexPattern(pattern, label);
    const normalizedSource = options?.matchEntireValue ? `^(?:${source})$` : source;
    const normalizedFlags = flags.replace(/[gy]/g, "");
    return new RegExp(normalizedSource, normalizedFlags);
  } catch (error) {
    throw new Error(`Invalid regex pattern for ${label}: '${pattern}' - ${String(error)}`);
  }
}

async function checkClassUriFormationRule(
  source: RuntimeSource,
  patternText: string | null,
  progress: ProgressReporter,
): Promise<string[]> {
  if (!patternText) {
    return [];
  }
  const pattern = compileRegex(patternText, "ClassURIFormationRule", { matchEntireValue: true });
  const classUris = source.mode === "local"
    ? getClassNodes(source.store).map((term) => term.value)
    : (await queryRows(source, `
      PREFIX owl: <${PREFIX_MAP.owl}>
      SELECT DISTINCT ?class WHERE {
        ?class a owl:Class .
        FILTER(!isBlank(?class))
      }
    `)).map((row) => row.class.value);
  const violations: string[] = [];
  progress(0, classUris.length);
  classUris.forEach((uri, index) => {
    if (!pattern.test(uri)) {
      violations.push(uri);
    }
    progress(index + 1, classUris.length);
  });
  return violations;
}

async function checkRelationUriFormationRule(
  source: RuntimeSource,
  patternText: string | null,
  progress: ProgressReporter,
): Promise<string[]> {
  if (!patternText) {
    return [];
  }
  const pattern = compileRegex(patternText, "RelationURIFormationRule", { matchEntireValue: true });
  const relationUris = source.mode === "local"
    ? getRelationNodes(source.store).map((term) => term.value)
    : (await queryRows(source, `
      PREFIX owl: <${PREFIX_MAP.owl}>
      SELECT DISTINCT ?relation WHERE {
        VALUES ?type { owl:ObjectProperty owl:DatatypeProperty owl:AnnotationProperty }
        ?relation a ?type .
        FILTER(!isBlank(?relation))
      }
    `)).map((row) => row.relation.value);
  const violations: string[] = [];
  progress(0, relationUris.length);
  relationUris.forEach((uri, index) => {
    if (!pattern.test(uri)) {
      violations.push(uri);
    }
    progress(index + 1, relationUris.length);
  });
  return violations;
}

async function checkInstanceUriFormationRule(
  source: RuntimeSource,
  patternText: string | null,
  progress: ProgressReporter,
): Promise<string[]> {
  if (!patternText) {
    return [];
  }
  const pattern = compileRegex(patternText, "InstanceURIFormationRule", { matchEntireValue: true });
  const instanceUris = source.mode === "local"
    ? getInstanceNodes(source.store).map((term) => term.value)
    : (await queryRows(source, `
      PREFIX owl: <${PREFIX_MAP.owl}>
      PREFIX rdf: <${PREFIX_MAP.rdf}>
      SELECT DISTINCT ?instance WHERE {
        ?class rdf:type owl:Class .
        ?instance rdf:type ?class .
        FILTER(!isBlank(?instance))
      }
    `)).map((row) => row.instance.value);
  const violations: string[] = [];
  progress(0, instanceUris.length);
  instanceUris.forEach((uri, index) => {
    if (!pattern.test(uri)) {
      violations.push(uri);
    }
    progress(index + 1, instanceUris.length);
  });
  return violations;
}

function buildCoverageViolationMessage(annotationIri: string, requiredLang: string | null, count: number, requiredCardinality: number): string {
  if (requiredLang) {
    return `Annotation ${annotationIri} with language ${requiredLang} has ${count} values, requires exactly ${requiredCardinality}`;
  }
  return `Annotation ${annotationIri} has ${count} values, requires exactly ${requiredCardinality}`;
}

async function checkCoverageAgainstSubjects(
  source: RuntimeSource,
  subjectUris: string[],
  requirements: Array<[string, number]>,
  languageTags: string[],
  progress: ProgressReporter,
): Promise<{ violations: Array<[string, string]>; totalIterations: number; completedIterations: number }> {
  const perSubjectChecks = requirements.length * Math.max(languageTags.length, 1);
  const total = subjectUris.length * perSubjectChecks;
  let completed = 0;
  const violations: Array<[string, string]> = [];
  progress(0, total);

  const checkOne = async (subjectUri: string, annotationIri: string, requiredCardinality: number, requiredLang: string | null) => {
    const count = source.mode === "local"
      ? countAnnotationValues(source.store, oxigraph.namedNode(subjectUri), annotationIri, requiredLang ?? undefined)
      : await countRemoteAnnotationValues(source, subjectUri, annotationIri, requiredLang);
    if (count !== requiredCardinality) {
      violations.push([subjectUri, buildCoverageViolationMessage(annotationIri, requiredLang, count, requiredCardinality)]);
    }
    completed += 1;
    progress(completed, total);
  };

  for (const subjectUri of subjectUris) {
    for (const [annotationIri, requiredCardinality] of requirements) {
      if (languageTags.length > 0) {
        for (const requiredLang of languageTags) {
          await checkOne(subjectUri, annotationIri, requiredCardinality, requiredLang);
        }
      } else {
        await checkOne(subjectUri, annotationIri, requiredCardinality, null);
      }
    }
  }

  return { violations, totalIterations: total, completedIterations: completed };
}

async function countRemoteAnnotationValues(
  source: RemoteRuntimeSource,
  subjectUri: string,
  annotationIri: string,
  requiredLang: string | null,
): Promise<number> {
  const filterClause = requiredLang ? `FILTER(lang(?value) = "${requiredLang}")` : "";
  const annotationRef = `<${annotationIri}>`;
  const rows = await queryRows(source, `
    SELECT (COUNT(?value) AS ?count) WHERE {
      <${subjectUri}> ${annotationRef} ?value .
      ${filterClause}
    }
  `);
  return Number(rows[0]?.count.value ?? 0);
}

async function checkClassMinAnnotationCoverage(
  source: RuntimeSource,
  context: ConstraintContext,
  progress: ProgressReporter,
): Promise<ValidationResult> {
  const subjectUris = source.mode === "local"
    ? getClassNodes(source.store).map((term) => term.value)
    : (await queryRows(source, `
      PREFIX owl: <${PREFIX_MAP.owl}>
      SELECT DISTINCT ?class WHERE {
        ?class a owl:Class .
        FILTER(!isBlank(?class))
      }
    `)).map((row) => row.class.value);
  const result = await checkCoverageAgainstSubjects(source, subjectUris, context.classAnnotationCardinalities, context.languageTags, progress);
  return {
    parameter: context.classAnnotationCardinalities,
    violations: result.violations,
    totalIterations: result.totalIterations,
    completedIterations: result.completedIterations,
  };
}

async function checkRelationMinAnnotationCoverage(
  source: RuntimeSource,
  context: ConstraintContext,
  progress: ProgressReporter,
): Promise<ValidationResult> {
  const subjectUris = source.mode === "local"
    ? getRelationNodes(source.store).map((term) => term.value)
    : (await queryRows(source, `
      PREFIX owl: <${PREFIX_MAP.owl}>
      SELECT DISTINCT ?relation WHERE {
        VALUES ?type { owl:ObjectProperty owl:DatatypeProperty owl:AnnotationProperty }
        ?relation a ?type .
        FILTER(!isBlank(?relation))
      }
    `)).map((row) => row.relation.value);
  const result = await checkCoverageAgainstSubjects(source, subjectUris, context.relationAnnotationCardinalities, context.languageTags, progress);
  return {
    parameter: context.relationAnnotationCardinalities,
    violations: result.violations,
    totalIterations: result.totalIterations,
    completedIterations: result.completedIterations,
  };
}

async function checkInstanceMinAnnotationCoverage(
  source: RuntimeSource,
  context: ConstraintContext,
  progress: ProgressReporter,
): Promise<ValidationResult> {
  const subjectUris = source.mode === "local"
    ? getInstanceNodes(source.store).map((term) => term.value)
    : (await queryRows(source, `
      PREFIX rdf: <${PREFIX_MAP.rdf}>
      PREFIX owl: <${PREFIX_MAP.owl}>
      SELECT DISTINCT ?instance WHERE {
        ?instance rdf:type ?class .
        ?class a owl:Class .
        FILTER(!isBlank(?instance))
      }
    `)).map((row) => row.instance.value);
  const result = await checkCoverageAgainstSubjects(source, subjectUris, context.instanceAnnotationCardinalities, context.languageTags, progress);
  return {
    parameter: context.instanceAnnotationCardinalities,
    violations: result.violations,
    totalIterations: result.totalIterations,
    completedIterations: result.completedIterations,
  };
}

async function checkMinAnnotationLength(
  source: RuntimeSource,
  requirements: Array<[string, number]>,
  progress: ProgressReporter,
): Promise<ValidationResult> {
  return checkAnnotationLengths(source, requirements, progress, "min");
}

async function checkMaxAnnotationLength(
  source: RuntimeSource,
  requirements: Array<[string, number]>,
  progress: ProgressReporter,
): Promise<ValidationResult> {
  return checkAnnotationLengths(source, requirements, progress, "max");
}

async function checkAnnotationLengths(
  source: RuntimeSource,
  requirements: Array<[string, number]>,
  progress: ProgressReporter,
  direction: "min" | "max",
): Promise<ValidationResult> {
  const violations: Array<[string, string]> = [];
  let total = 0;
  const rowsByProperty: Array<[string, number, Array<[string, string]>]> = [];

  for (const [propertyIri, threshold] of requirements) {
    const rows = source.mode === "local"
      ? getAnnotationSubjects(source.store, propertyIri).map((statement) => [statement.subject.value, normalizeAnnotationLiteral(statement.object)] as [string, string])
      : (await queryRows(source, `
        SELECT DISTINCT ?subject ?value WHERE {
          ?subject <${propertyIri}> ?value .
        }
      `)).map((row) => [row.subject.value, row.value.value] as [string, string]);
    rowsByProperty.push([propertyIri, threshold, rows]);
    total += rows.length;
  }

  let completed = 0;
  progress(0, total);
  for (const [propertyIri, threshold, rows] of rowsByProperty) {
    for (const [subjectUri, value] of rows) {
      const length = value.length;
      const isViolation = direction === "min" ? length < threshold : length > threshold;
      if (isViolation) {
        const requirementText = direction === "min" ? `at least ${threshold}` : `at most ${threshold}`;
        violations.push([subjectUri, `Annotation ${propertyIri} value '${value}' has ${length} characters, requires ${requirementText}`]);
      }
      completed += 1;
      progress(completed, total);
    }
  }

  return {
    parameter: requirements,
    violations,
    totalIterations: total,
    completedIterations: completed,
  };
}

async function checkAnnotationRegularExpression(
  source: RuntimeSource,
  requirements: Array<[string, string]>,
  progress: ProgressReporter,
): Promise<ValidationResult> {
  const violations: Array<[string, string]> = [];
  let total = 0;
  const rowsByProperty: Array<[string, RegExp, string, Array<[string, string]>]> = [];

  for (const [propertyIri, regexText] of requirements) {
    const regex = compileRegex(regexText, `AnnotationRegularExpression on ${propertyIri}`);
    const rows = source.mode === "local"
      ? getAnnotationSubjects(source.store, propertyIri).map((statement) => [statement.subject.value, normalizeAnnotationLiteral(statement.object)] as [string, string])
      : (await queryRows(source, `
        SELECT DISTINCT ?subject ?value WHERE {
          ?subject <${propertyIri}> ?value .
        }
      `)).map((row) => [row.subject.value, row.value.value] as [string, string]);
    rowsByProperty.push([propertyIri, regex, regexText, rows]);
    total += rows.length;
  }

  let completed = 0;
  progress(0, total);
  for (const [propertyIri, regex, regexText, rows] of rowsByProperty) {
    for (const [subjectUri, value] of rows) {
      if (!regex.test(value)) {
        violations.push([subjectUri, `Annotation ${propertyIri} value '${value}' does not match regex '${regexText}'`]);
      }
      completed += 1;
      progress(completed, total);
    }
  }

  return {
    parameter: requirements,
    violations,
    totalIterations: total,
    completedIterations: completed,
  };
}

async function checkInstanceOfMinAnnotationCoverage(
  source: RuntimeSource,
  context: ConstraintContext,
  progress: ProgressReporter,
): Promise<ValidationResult> {
  let total = 0;
  const plans: Array<[string, Array<[string, number]>, string[]]> = [];

  for (const [classUri, requiredAnnotations] of context.instanceCoverageRequirements) {
    const instanceUris = source.mode === "local"
      ? source.store.match(null, rdf("type"), oxigraph.namedNode(classUri), null)
          .map((quad) => ensureNamedNode(quad.subject))
          .filter((term): term is NamedNode => Boolean(term))
          .map((term) => term.value)
      : (await queryRows(source, `
        PREFIX rdf: <${PREFIX_MAP.rdf}>
        SELECT DISTINCT ?instance WHERE {
          ?instance rdf:type <${classUri}> .
          FILTER(!isBlank(?instance))
        }
      `)).map((row) => row.instance.value);
    plans.push([classUri, requiredAnnotations, instanceUris]);
    total += instanceUris.length * requiredAnnotations.length * Math.max(context.languageTags.length, 1);
  }

  const violations: Array<[string, string]> = [];
  let completed = 0;
  progress(0, total);

  for (const [classUri, requiredAnnotations, instanceUris] of plans) {
    for (const instanceUri of instanceUris) {
      for (const [annotationIri, requiredCardinality] of requiredAnnotations) {
        if (context.languageTags.length > 0) {
          for (const languageTag of context.languageTags) {
            const count = source.mode === "local"
              ? countAnnotationValues(source.store, oxigraph.namedNode(instanceUri), annotationIri, languageTag)
              : await countRemoteAnnotationValues(source, instanceUri, annotationIri, languageTag);
            if (count !== requiredCardinality) {
              violations.push([
                instanceUri,
                `Instance of ${classUri} is missing required annotation ${annotationIri} for language ${languageTag}: has ${count} values, requires exactly ${requiredCardinality}`,
              ]);
            }
            completed += 1;
            progress(completed, total);
          }
        } else {
          const count = source.mode === "local"
            ? countAnnotationValues(source.store, oxigraph.namedNode(instanceUri), annotationIri)
            : await countRemoteAnnotationValues(source, instanceUri, annotationIri, null);
          if (count !== requiredCardinality) {
            violations.push([
              instanceUri,
              `Instance of ${classUri} is missing required annotation ${annotationIri}: has ${count} values, requires exactly ${requiredCardinality}`,
            ]);
          }
          completed += 1;
          progress(completed, total);
        }
      }
    }
  }

  return {
    parameter: context.instanceCoverageRequirements,
    violations,
    totalIterations: total,
    completedIterations: completed,
  };
}

export function beginEvaluation(state: EvaluationState): EvaluationState {
  return {
    ...state,
    status: "running",
    startedAt: nowIso(),
    completedAt: null,
    durationSeconds: null,
    progressPercent: 0,
    etaSeconds: state.estimatedSeconds,
    completedIterations: 0,
    totalIterations: null,
    remainingIterations: null,
    issueCount: null,
    parameter: null,
    constraints: {},
    violations: [],
    errorMessage: null,
  };
}

export function updateEvaluationProgress(
  state: EvaluationState,
  completedIterations: number,
  totalIterations: number,
): EvaluationState {
  const elapsed = parseDurationSeconds(state.startedAt) ?? 0;
  const progressPercent = totalIterations > 0
    ? Math.min(99, Math.floor((completedIterations / totalIterations) * 100))
    : 0;
  return {
    ...state,
    completedIterations,
    totalIterations,
    remainingIterations: Math.max(totalIterations - completedIterations, 0),
    progressPercent,
    etaSeconds: state.estimatedSeconds == null ? null : Math.max(Math.ceil(state.estimatedSeconds - elapsed), 1),
  };
}

export function completeConstraintsEvaluation(state: EvaluationState, context: ConstraintContext): EvaluationState {
  const completedAt = nowIso();
  return {
    ...state,
    status: "completed",
    constraints: buildConstraintsView(context),
    progressPercent: 100,
    completedAt,
    durationSeconds: parseDurationSeconds(state.startedAt),
    etaSeconds: 0,
    completedIterations: 11,
    totalIterations: 11,
    remainingIterations: 0,
    errorMessage: null,
  };
}

export function completeValidationEvaluation(state: EvaluationState, result: ValidationResult): EvaluationState {
  return {
    ...state,
    status: "completed",
    progressPercent: 100,
    completedAt: nowIso(),
    durationSeconds: parseDurationSeconds(state.startedAt),
    etaSeconds: 0,
    parameter: result.parameter,
    violations: result.violations,
    issueCount: result.violations.length,
    completedIterations: result.completedIterations ?? result.totalIterations ?? state.completedIterations,
    totalIterations: result.totalIterations ?? state.totalIterations,
    remainingIterations: result.totalIterations == null ? state.remainingIterations : 0,
    errorMessage: null,
  };
}

export function failEvaluation(state: EvaluationState, error: unknown): EvaluationState {
  return {
    ...state,
    status: "error",
    progressPercent: 100,
    completedAt: nowIso(),
    durationSeconds: parseDurationSeconds(state.startedAt),
    etaSeconds: 0,
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}
