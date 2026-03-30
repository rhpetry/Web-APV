import base64
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import uuid4

from fastapi import UploadFile
from rdflib import Graph

from backend.app.apv.config import settings
from backend.app.triplestore.schemas import QueryResult, QuerySession, ValidationReport


ALLOWED_CONTENT_TYPES = {
    "application/rdf+xml",
    "application/owl+xml",
    "application/xml",
    "application/turtle",
    "application/x-turtle",
    "text/xml",
    "text/turtle",
}
ALLOWED_EXTENSIONS = {".rdf", ".owl", ".xml", ".ttl"}
GRAPH_FORMAT_BY_EXTENSION = {
    ".rdf": "xml",
    ".owl": "xml",
    ".xml": "xml",
    ".ttl": "turtle",
}
GRAPH_FORMAT_BY_CONTENT_TYPE = {
    "application/rdf+xml": "xml",
    "application/owl+xml": "xml",
    "application/xml": "xml",
    "text/xml": "xml",
    "application/turtle": "turtle",
    "application/x-turtle": "turtle",
    "text/turtle": "turtle",
}
QUERY_TYPE_PATTERN = re.compile(r"\b(select|ask|construct|describe)\b", re.IGNORECASE)


class SubmissionError(Exception):
    pass


class QueryExecutionError(Exception):
    pass


def _has_allowed_extension(filename: str) -> bool:
    lowered = filename.lower()
    return any(lowered.endswith(extension) for extension in ALLOWED_EXTENSIONS)


def _get_extension(filename: str) -> str:
    return Path(filename).suffix.lower()


def _infer_graph_format(filename: str, content_type: str) -> str | None:
    extension = _get_extension(filename)
    if extension in GRAPH_FORMAT_BY_EXTENSION:
        return GRAPH_FORMAT_BY_EXTENSION[extension]
    return GRAPH_FORMAT_BY_CONTENT_TYPE.get(content_type)


def _ensure_directory(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def _sessions_dir() -> Path:
    return _ensure_directory(Path(settings.TRIPLESTORE_STORAGE_DIR) / "sessions")


def _uploads_dir() -> Path:
    return _ensure_directory(Path(settings.TRIPLESTORE_STORAGE_DIR) / "uploads")


def _session_path(session_id: str) -> Path:
    return _sessions_dir() / f"{session_id}.json"


def _query_type(query: str) -> str:
    match = QUERY_TYPE_PATTERN.search(query)
    if match is None:
        return "unknown"
    return match.group(1).lower()


def _save_session(session: QuerySession) -> QuerySession:
    _session_path(session.session_id).write_text(session.model_dump_json(indent=2), encoding="utf-8")
    return session


def load_session(session_id: str) -> QuerySession:
    session_file = _session_path(session_id)
    if not session_file.exists():
        raise QueryExecutionError("This SPARQL session no longer exists. Start again from the upload page.")
    return QuerySession.model_validate_json(session_file.read_text(encoding="utf-8"))


async def process_submission(
    ontology_file: UploadFile | None,
    triplestore_url: str | None,
    username: str | None,
    password: str | None,
) -> QuerySession:
    if ontology_file is not None and ontology_file.filename:
        return await create_local_graph_session(ontology_file)

    if triplestore_url and username and password:
        return create_remote_session(
            triplestore_url=triplestore_url,
            username=username,
            password=password,
        )

    raise SubmissionError("Provide either an ontology file or all triplestore credentials fields.")


async def create_local_graph_session(ontology_file: UploadFile) -> QuerySession:
    content_type = ontology_file.content_type or ""
    if not _has_allowed_extension(ontology_file.filename) and content_type not in ALLOWED_CONTENT_TYPES:
        raise SubmissionError("Ontology file must be RDF, OWL, XML, or TTL.")

    graph_format = _infer_graph_format(ontology_file.filename, content_type)
    if graph_format is None:
        raise SubmissionError("Could not determine how to parse the ontology file.")

    content = await ontology_file.read()
    stored_name = f"{uuid4()}-{ontology_file.filename}"
    stored_path = _uploads_dir() / stored_name
    stored_path.write_bytes(content)

    try:
        graph = Graph()
        graph.parse(location=str(stored_path), format=graph_format)
    except Exception as exc:
        stored_path.unlink(missing_ok=True)
        raise SubmissionError(f"RDF parsing failed: {exc}") from exc

    validation_report, validation_error = _build_local_validation(stored_path, graph_format)

    session = QuerySession(
        session_id=str(uuid4()),
        mode="local",
        title=f"Local ontology graph: {ontology_file.filename}",
        stored_path=str(stored_path),
        graph_format=graph_format,
        filename=ontology_file.filename,
        validation_report=validation_report,
        validation_error=validation_error,
    )
    _save_session(session)
    return session


def create_remote_session(
    triplestore_url: str,
    username: str,
    password: str,
) -> QuerySession:
    session_id = str(uuid4())
    stored_path = _session_path(session_id)
    validation_report, validation_error = _build_remote_validation(triplestore_url, username, password)
    session = QuerySession(
        session_id=session_id,
        mode="triplestore",
        title=f"Remote SPARQL endpoint: {triplestore_url}",
        triplestore_url=triplestore_url,
        username=username,
        validation_report=validation_report,
        validation_error=validation_error,
    )
    payload = session.model_dump(mode="json")
    payload["created_at"] = datetime.now(timezone.utc).isoformat()
    payload["password"] = password
    stored_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return load_session(session_id)


def run_query(session_id: str, query: str) -> QueryResult:
    cleaned_query = query.strip()
    if not cleaned_query:
        raise QueryExecutionError("Enter a SPARQL query before running it.")

    session = load_session(session_id)
    if session.mode == "local":
        return _run_local_query(session, cleaned_query)
    return _run_remote_query(session_id, session, cleaned_query)


def _run_local_query(session: QuerySession, query: str) -> QueryResult:
    if not session.stored_path or not session.graph_format:
        raise QueryExecutionError("This local graph session is incomplete.")

    graph = Graph()
    graph.parse(location=session.stored_path, format=session.graph_format)

    try:
        result = graph.query(query)
    except Exception as exc:
        raise QueryExecutionError(f"SPARQL query failed: {exc}") from exc

    result_type = str(result.type).lower() if getattr(result, "type", None) else _query_type(query)
    if result_type == "select":
        columns = [str(column) for column in getattr(result, "vars", [])]
        rows = []
        for row in result:
            rows.append(["" if value is None else str(value) for value in row])
        return QueryResult(query_type="select", columns=columns, rows=rows)

    if result_type == "ask":
        return QueryResult(query_type="ask", boolean_result=bool(result.askAnswer))

    if result_type in {"construct", "describe"}:
        graph_text = result.graph.serialize(format="turtle")
        return QueryResult(query_type=result_type, graph_text=_ensure_text(graph_text))

    return QueryResult(query_type="unknown", raw_text=str(result))


def _run_remote_query(session_id: str, session: QuerySession, query: str) -> QueryResult:
    session_file = _session_path(session_id)
    payload = json.loads(session_file.read_text(encoding="utf-8"))
    password = payload.get("password")
    if not password or session.triplestore_url is None:
        raise QueryExecutionError("This triplestore session is incomplete.")

    query_type = _query_type(query)
    accept = "application/sparql-results+json"
    if query_type in {"construct", "describe"}:
        accept = "text/turtle"

    body = urlencode({"query": query}).encode("utf-8")
    request = Request(
        str(session.triplestore_url),
        data=body,
        method="POST",
        headers={
            "Accept": accept,
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
            "Authorization": _basic_auth_header(session.username or "", password),
        },
    )

    try:
        with urlopen(request, timeout=30) as response:
            response_body = response.read()
            response_type = response.headers.get_content_type()
    except HTTPError as exc:
        detail = _ensure_text(exc.read())
        raise QueryExecutionError(f"SPARQL server returned HTTP {exc.code}: {detail or exc.reason}") from exc
    except URLError as exc:
        raise QueryExecutionError(f"Could not reach the SPARQL server: {exc.reason}") from exc
    except Exception as exc:
        raise QueryExecutionError(f"SPARQL request failed: {exc}") from exc

    if query_type in {"select", "ask"} or response_type == "application/sparql-results+json":
        try:
            parsed = json.loads(_ensure_text(response_body))
        except json.JSONDecodeError as exc:
            raise QueryExecutionError("SPARQL server did not return valid JSON results.") from exc

        if "boolean" in parsed:
            return QueryResult(query_type="ask", boolean_result=bool(parsed["boolean"]))

        variables = [str(variable) for variable in parsed.get("head", {}).get("vars", [])]
        rows = []
        for binding in parsed.get("results", {}).get("bindings", []):
            row = []
            for variable in variables:
                value = binding.get(variable, {}).get("value", "")
                row.append(str(value))
            rows.append(row)
        return QueryResult(query_type="select", columns=variables, rows=rows)

    if query_type in {"construct", "describe"}:
        return QueryResult(query_type=query_type, graph_text=_ensure_text(response_body))

    return QueryResult(query_type="unknown", raw_text=_ensure_text(response_body))


def _basic_auth_header(username: str, password: str) -> str:
    token = base64.b64encode(f"{username}:{password}".encode("utf-8")).decode("ascii")
    return f"Basic {token}"


def _ensure_text(value: str | bytes) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def _build_local_validation(stored_path: Path, graph_format: str) -> tuple[ValidationReport | None, str | None]:
    try:
        from backend.app.apv.apv.reporting import build_validation_report
        from backend.app.apv.apv.sparql_client import SparqlClient

        report = build_validation_report(
            SparqlClient.from_local_file(str(stored_path), format=graph_format)
        )
    except Exception as exc:
        return None, f"APV validation could not be completed: {exc}"
    return _coerce_validation_report(report), None


def _build_remote_validation(
    triplestore_url: str,
    username: str,
    password: str,
) -> tuple[ValidationReport | None, str | None]:
    try:
        from backend.app.apv.apv.reporting import build_validation_report
        from backend.app.apv.apv.sparql_client import SparqlClient

        report = build_validation_report(
            SparqlClient.from_remote_endpoint(
                triplestore_url,
                user=username,
                password=password,
            )
        )
    except Exception as exc:
        return None, f"APV validation could not be completed: {exc}"
    return _coerce_validation_report(report), None


def _coerce_validation_report(report: dict[str, Any]) -> ValidationReport:
    normalized = {
        "constraints": report.get("constraints", {}),
        "violations": [],
    }
    for check in report.get("violations", []):
        violations = []
        for item in check.get("violations", []):
            if isinstance(item, tuple):
                violations.append([str(part) for part in item])
            else:
                violations.append(str(item))
        parameter = check.get("parameter")
        if isinstance(parameter, tuple):
            parameter = list(parameter)
        normalized["violations"].append(
            {
                "check": str(check.get("check", "")),
                "parameter": parameter,
                "violations": violations,
            }
        )
    return ValidationReport.model_validate(normalized)
