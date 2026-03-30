from typing import Any, Literal

from pydantic import BaseModel, Field, HttpUrl


class ValidationCheck(BaseModel):
    check: str
    parameter: Any = None
    violations: list[Any] = Field(default_factory=list)


class ValidationReport(BaseModel):
    constraints: dict[str, Any] = Field(default_factory=dict)
    violations: list[ValidationCheck] = Field(default_factory=list)


class QuerySession(BaseModel):
    session_id: str
    mode: Literal["local", "triplestore"]
    title: str
    stored_path: str | None = None
    graph_format: str | None = None
    filename: str | None = None
    triplestore_url: HttpUrl | None = None
    username: str | None = None
    validation_report: ValidationReport | None = None
    validation_error: str | None = None


class QueryResult(BaseModel):
    query_type: Literal["select", "ask", "construct", "describe", "unknown"]
    columns: list[str] = Field(default_factory=list)
    rows: list[list[str]] = Field(default_factory=list)
    boolean_result: bool | None = None
    graph_text: str | None = None
    raw_text: str | None = None
