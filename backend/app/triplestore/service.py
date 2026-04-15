import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import uuid4

from fastapi import UploadFile
from rdflib import Graph

from backend.app.apv_adapter import (
    build_validation_report_from_local_file,
    build_validation_report_from_remote_endpoint,
)
from backend.app.config import settings
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
MAX_STORED_UPLOADS = 3
MAX_STORED_SESSIONS = 3
TOKEN_REFRESH_MARGIN = timedelta(seconds=30)


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


def _trim_directory(path: Path, keep_last: int) -> None:
    files = [item for item in path.iterdir() if item.is_file()]
    files.sort(key=lambda item: item.stat().st_mtime, reverse=True)
    for stale_file in files[keep_last:]:
        stale_file.unlink(missing_ok=True)


def _save_session(session: QuerySession) -> QuerySession:
    _session_path(session.session_id).write_text(session.model_dump_json(indent=2), encoding="utf-8")
    _trim_directory(_sessions_dir(), MAX_STORED_SESSIONS)
    return session


def load_session(session_id: str) -> QuerySession:
    session_file = _session_path(session_id)
    if not session_file.exists():
        raise QueryExecutionError("This SPARQL session no longer exists. Start again from the upload page.")
    return QuerySession.model_validate_json(session_file.read_text(encoding="utf-8"))


async def process_submission(
    ontology_file: UploadFile | None,
    triplestore_url: str | None,
    jwt_auth_enabled: bool,
    auth_server_url: str | None,
    username: str | None,
    password: str | None,
    jwt_token: str | None,
) -> QuerySession:
    if ontology_file is not None and ontology_file.filename:
        return await create_local_graph_session(ontology_file)

    if triplestore_url:
        return create_remote_session(
            triplestore_url=triplestore_url,
            jwt_auth_enabled=jwt_auth_enabled,
            auth_server_url=auth_server_url,
            username=username,
            password=password,
            jwt_token=jwt_token,
        )

    raise SubmissionError("Provide either an ontology file or a SPARQL endpoint URL.")


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
    _trim_directory(_uploads_dir(), MAX_STORED_UPLOADS)

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
    jwt_auth_enabled: bool,
    auth_server_url: str | None,
    username: str | None,
    password: str | None,
    jwt_token: str | None,
) -> QuerySession:
    session_id = str(uuid4())
    stored_path = _session_path(session_id)
    auth_state = _resolve_remote_auth(
        jwt_auth_enabled=jwt_auth_enabled,
        auth_server_url=auth_server_url,
        username=username,
        password=password,
        jwt_token=jwt_token,
    )
    validation_report, validation_error = _build_remote_validation(triplestore_url, auth_state["auth_header"])
    session = QuerySession(
        session_id=session_id,
        mode="triplestore",
        title=f"Remote SPARQL endpoint: {triplestore_url}",
        triplestore_url=triplestore_url,
        jwt_auth_enabled=jwt_auth_enabled,
        auth_server_url=auth_state["auth_server_url"],
        validation_report=validation_report,
        validation_error=validation_error,
    )
    payload = session.model_dump(mode="json")
    payload["created_at"] = datetime.now(timezone.utc).isoformat()
    payload.update(auth_state)
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
    if session.triplestore_url is None:
        raise QueryExecutionError("This triplestore session is incomplete.")

    auth_header, updated_payload = _resolve_session_auth(session, payload)
    if updated_payload is not payload:
        session_file.write_text(json.dumps(updated_payload, indent=2), encoding="utf-8")

    query_type = _query_type(query)
    accept = "application/sparql-results+json"
    request_format = "json"
    if query_type in {"construct", "describe"}:
        accept = "application/n-triples, text/plain; q=0.9, text/turtle; q=0.8"
        request_format = "nt"

    try:
        response_body, response_type = _execute_remote_query_request(
            endpoint=str(session.triplestore_url),
            query=query,
            request_format=request_format,
            accept=accept,
            auth_header=auth_header,
        )
    except HTTPError as exc:
        if exc.code == 401 and session.jwt_auth_enabled:
            auth_header, refreshed_payload = _resolve_session_auth(session, updated_payload, force_refresh=True)
            try:
                response_body, response_type = _execute_remote_query_request(
                    endpoint=str(session.triplestore_url),
                    query=query,
                    request_format=request_format,
                    accept=accept,
                    auth_header=auth_header,
                )
            except HTTPError as retry_exc:
                detail = _ensure_text(retry_exc.read())
                raise QueryExecutionError(
                    f"SPARQL server returned HTTP {retry_exc.code}: {detail or retry_exc.reason}"
                ) from retry_exc
            session_file.write_text(json.dumps(refreshed_payload, indent=2), encoding="utf-8")
            return _parse_remote_query_result(query_type, response_type, response_body)
        detail = _ensure_text(exc.read())
        raise QueryExecutionError(f"SPARQL server returned HTTP {exc.code}: {detail or exc.reason}") from exc
    except URLError as exc:
        raise QueryExecutionError(f"Could not reach the SPARQL server: {exc.reason}") from exc
    except Exception as exc:
        raise QueryExecutionError(f"SPARQL request failed: {exc}") from exc

    return _parse_remote_query_result(query_type, response_type, response_body)


def _execute_remote_query_request(
    endpoint: str,
    query: str,
    request_format: str,
    accept: str,
    auth_header: str | None,
) -> tuple[bytes, str]:
    body = urlencode({"query": query, "format": request_format}).encode("utf-8")
    request = Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Accept": accept,
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
            **({"Authorization": auth_header} if auth_header else {}),
        },
    )
    with urlopen(request, timeout=30) as response:
        return response.read(), response.headers.get_content_type()


def _parse_remote_query_result(query_type: str, response_type: str, response_body: bytes) -> QueryResult:
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


def _resolve_remote_auth(
    jwt_auth_enabled: bool,
    auth_server_url: str | None,
    username: str | None,
    password: str | None,
    jwt_token: str | None,
) -> dict[str, str | None]:
    if not jwt_auth_enabled:
        return {
            "auth_header": None,
            "auth_server_url": None,
            "refresh_token": None,
            "token_expires_at": None,
            "username": None,
            "password": None,
        }

    token = (jwt_token or "").strip()
    if token:
        return {
            "auth_header": _bearer_auth_header(token),
            "auth_server_url": _clean_optional_text(auth_server_url),
            "refresh_token": None,
            "token_expires_at": None,
            "username": None,
            "password": None,
        }

    cleaned_auth_server_url = _clean_optional_text(auth_server_url)
    cleaned_username = _clean_optional_text(username)
    cleaned_password = _clean_optional_text(password)
    if not cleaned_auth_server_url or not cleaned_username or not cleaned_password:
        raise SubmissionError(
            "When JWT authentication is enabled, provide a JWT token or fill in authentication server URL, username, and password."
        )

    token_payload = _request_keycloak_token(
        auth_server_url=cleaned_auth_server_url,
        username=cleaned_username,
        password=cleaned_password,
    )
    return _build_auth_state(
        auth_server_url=cleaned_auth_server_url,
        token_payload=token_payload,
        username=cleaned_username,
        password=cleaned_password,
    )


def _request_keycloak_token(auth_server_url: str, username: str, password: str) -> dict[str, Any]:
    token_request_payload = {
        "grant_type": "password",
        "client_id": settings.KEYCLOAK_CLIENT_ID,
        "username": username,
        "password": password,
    }
    if settings.KEYCLOAK_SCOPE:
        token_request_payload["scope"] = settings.KEYCLOAK_SCOPE

    body = urlencode(token_request_payload).encode("utf-8")
    request = Request(
        auth_server_url,
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        },
    )

    try:
        with urlopen(request, timeout=30) as response:
            payload = json.loads(_ensure_text(response.read()))
    except HTTPError as exc:
        detail = _ensure_text(exc.read())
        raise SubmissionError(f"Could not retrieve a JWT token from the authentication server: HTTP {exc.code}: {detail or exc.reason}") from exc
    except URLError as exc:
        raise SubmissionError(f"Could not reach the authentication server: {exc.reason}") from exc
    except json.JSONDecodeError as exc:
        raise SubmissionError("The authentication server did not return valid JSON.") from exc
    except Exception as exc:
        raise SubmissionError(f"JWT authentication failed: {exc}") from exc

    return _validate_token_payload(payload)


def _refresh_keycloak_token(auth_server_url: str, refresh_token: str) -> dict[str, Any]:
    token_request_payload = {
        "grant_type": "refresh_token",
        "client_id": settings.KEYCLOAK_CLIENT_ID,
        "refresh_token": refresh_token,
    }
    if settings.KEYCLOAK_SCOPE:
        token_request_payload["scope"] = settings.KEYCLOAK_SCOPE

    body = urlencode(token_request_payload).encode("utf-8")
    request = Request(
        auth_server_url,
        data=body,
        method="POST",
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
        },
    )

    try:
        with urlopen(request, timeout=30) as response:
            payload = json.loads(_ensure_text(response.read()))
    except HTTPError as exc:
        detail = _ensure_text(exc.read())
        raise SubmissionError(f"Could not refresh the JWT token: HTTP {exc.code}: {detail or exc.reason}") from exc
    except URLError as exc:
        raise SubmissionError(f"Could not reach the authentication server: {exc.reason}") from exc
    except json.JSONDecodeError as exc:
        raise SubmissionError("The authentication server did not return valid JSON.") from exc
    except Exception as exc:
        raise SubmissionError(f"JWT authentication failed: {exc}") from exc

    return _validate_token_payload(payload)


def _validate_token_payload(payload: dict[str, Any]) -> dict[str, Any]:
    token = payload.get("access_token")
    if not token:
        raise SubmissionError("The authentication server response did not include an access token.")
    return payload


def _build_auth_state(
    auth_server_url: str,
    token_payload: dict[str, Any],
    username: str | None,
    password: str | None,
) -> dict[str, str | None]:
    expires_in = _parse_expires_in(token_payload.get("expires_in"))
    expires_at = None
    if expires_in is not None:
        expires_at = (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat()
    return {
        "auth_header": _bearer_auth_header(str(token_payload["access_token"])),
        "auth_server_url": auth_server_url,
        "refresh_token": _clean_optional_text(token_payload.get("refresh_token")),
        "token_expires_at": expires_at,
        "username": username,
        "password": password,
    }


def _resolve_session_auth(
    session: QuerySession,
    payload: dict[str, Any],
    force_refresh: bool = False,
) -> tuple[str | None, dict[str, Any]]:
    auth_header = _clean_optional_text(payload.get("auth_header"))
    if not session.jwt_auth_enabled:
        return auth_header, payload

    if not force_refresh and auth_header and not _token_is_expiring(payload.get("token_expires_at")):
        return auth_header, payload

    auth_server_url = _clean_optional_text(payload.get("auth_server_url"))
    refresh_token = _clean_optional_text(payload.get("refresh_token"))
    username = _clean_optional_text(payload.get("username"))
    password = _clean_optional_text(payload.get("password"))

    if refresh_token and auth_server_url:
        token_payload = _refresh_keycloak_token(auth_server_url, refresh_token)
        updated_payload = dict(payload)
        updated_payload.update(
            _build_auth_state(
                auth_server_url=auth_server_url,
                token_payload=token_payload,
                username=username,
                password=password,
            )
        )
        return updated_payload["auth_header"], updated_payload

    if auth_server_url and username and password:
        token_payload = _request_keycloak_token(auth_server_url, username, password)
        updated_payload = dict(payload)
        updated_payload.update(
            _build_auth_state(
                auth_server_url=auth_server_url,
                token_payload=token_payload,
                username=username,
                password=password,
            )
        )
        return updated_payload["auth_header"], updated_payload

    if auth_header and not force_refresh:
        return auth_header, payload

    raise QueryExecutionError(
        "This JWT-authenticated SPARQL session expired and cannot be renewed. Submit the endpoint again with Keycloak credentials or a fresh token."
    )


def _bearer_auth_header(token: str) -> str:
    return f"Bearer {token.strip()}"


def _clean_optional_text(value: str | None) -> str | None:
    if value is None:
        return None
    cleaned = value.strip()
    return cleaned or None


def _parse_expires_in(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _token_is_expiring(expires_at: Any) -> bool:
    if not expires_at:
        return False
    try:
        expires_at_dt = datetime.fromisoformat(str(expires_at))
    except ValueError:
        return True
    if expires_at_dt.tzinfo is None:
        expires_at_dt = expires_at_dt.replace(tzinfo=timezone.utc)
    return expires_at_dt <= datetime.now(timezone.utc) + TOKEN_REFRESH_MARGIN


def _ensure_text(value: str | bytes) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def _build_local_validation(stored_path: Path, graph_format: str) -> tuple[ValidationReport | None, str | None]:
    try:
        report = build_validation_report_from_local_file(str(stored_path), graph_format)
    except Exception as exc:
        return None, f"APV validation could not be completed: {exc}"
    return _coerce_validation_report(report), None


def _build_remote_validation(
    triplestore_url: str,
    auth_header: str | None,
) -> tuple[ValidationReport | None, str | None]:
    try:
        report = build_validation_report_from_remote_endpoint(
            triplestore_url,
            auth_header,
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
