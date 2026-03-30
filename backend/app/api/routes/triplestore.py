from html import escape

from fastapi import APIRouter, Form
from fastapi.responses import HTMLResponse

from backend.app.triplestore.deps import SubmissionInputDep
from backend.app.triplestore.schemas import QueryResult, QuerySession, ValidationReport
from backend.app.triplestore.service import (
    QueryExecutionError,
    SubmissionError,
    load_session,
    process_submission,
    run_query,
)


router = APIRouter(prefix="/triplestore", tags=["triplestore"])

DEFAULT_QUERY = """PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?subject ?predicate ?object
WHERE {
  ?subject ?predicate ?object
}
LIMIT 25
"""


def get_home_page(error_message: str | None = None) -> str:
    error_block = ""
    if error_message:
        error_block = f'<div class="alert error">{escape(error_message)}</div>'

    return f"""
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Web APV</title>
    <style>
      :root {{
        color: #132238;
        background:
          radial-gradient(circle at top right, rgba(81, 163, 255, 0.18), transparent 38%),
          linear-gradient(180deg, #eef4ff 0%, #f7f9fd 100%);
        font-family: "Trebuchet MS", "Segoe UI", sans-serif;
      }}
      * {{
        box-sizing: border-box;
      }}
      body {{
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
      }}
      main {{
        width: min(860px, 100%);
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(22, 42, 72, 0.08);
        border-radius: 24px;
        padding: 32px;
        box-shadow: 0 24px 70px rgba(19, 34, 56, 0.14);
      }}
      h1 {{
        margin: 0 0 8px;
        font-size: clamp(2rem, 4vw, 3rem);
      }}
      p {{
        line-height: 1.55;
      }}
      form {{
        display: grid;
        gap: 16px;
        margin-top: 28px;
      }}
      .grid {{
        display: grid;
        gap: 16px;
        grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      }}
      label {{
        display: grid;
        gap: 8px;
        font-weight: 600;
      }}
      input, textarea, button {{
        font: inherit;
      }}
      input, textarea {{
        width: 100%;
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid #bfd0e9;
        background: #fbfdff;
      }}
      textarea {{
        min-height: 220px;
        resize: vertical;
      }}
      button {{
        justify-self: start;
        border: 0;
        border-radius: 999px;
        padding: 12px 18px;
        background: linear-gradient(135deg, #1452cc 0%, #0f7a9f 100%);
        color: white;
        cursor: pointer;
        box-shadow: 0 14px 30px rgba(20, 82, 204, 0.22);
      }}
      .hint {{
        color: #4d607a;
        margin-top: 8px;
      }}
      .alert {{
        margin-top: 16px;
        padding: 14px 16px;
        border-radius: 16px;
      }}
      .error {{
        color: #7a1322;
        background: #fff0f3;
        border: 1px solid #f4bcc8;
      }}
      .panel {{
        margin-top: 24px;
        padding: 18px;
        border-radius: 18px;
        background: #f5f8ff;
        border: 1px solid #dbe5f5;
      }}
    </style>
  </head>
  <body>
    <main>
      <h1>Ontology And SPARQL Workspace</h1>
      <p>Upload an ontology file to validate it with RDFLib and query it locally, or provide a SPARQL endpoint and query the server directly.</p>
      {error_block}
      <form action="/api/v1/triplestore/submit" method="post" enctype="multipart/form-data">
        <div class="panel">
          <label for="ontology_file">Ontology file
            <input id="ontology_file" name="ontology_file" type="file" accept=".rdf,.owl,.xml,.ttl" />
          </label>
          <p class="hint">Accepted file types: .rdf, .owl, .xml, .ttl</p>
        </div>
        <div class="panel">
          <div class="grid">
            <label for="triplestore_url">SPARQL endpoint URL
              <input id="triplestore_url" name="triplestore_url" type="url" placeholder="https://example.com/sparql" />
            </label>
            <label for="username">Username
              <input id="username" name="username" type="text" placeholder="user" />
            </label>
            <label for="password">Password
              <input id="password" name="password" type="password" placeholder="password" />
            </label>
          </div>
          <p class="hint">Submit either a local ontology file or a complete set of triplestore credentials.</p>
        </div>
        <button type="submit">Open Query Interface</button>
      </form>
    </main>
  </body>
</html>
"""


def _render_result(result: QueryResult | None) -> str:
    if result is None:
        return ""

    if result.query_type == "ask":
        outcome = "true" if result.boolean_result else "false"
        return f'<section class="results"><h2>ASK Result</h2><p><strong>{outcome}</strong></p></section>'

    if result.query_type == "select":
        headers = "".join(f"<th>{escape(column)}</th>" for column in result.columns)
        rows = []
        for row in result.rows:
            cells = "".join(f"<td>{escape(value)}</td>" for value in row)
            rows.append(f"<tr>{cells}</tr>")
        body = "".join(rows) or '<tr><td colspan="100%">No rows returned.</td></tr>'
        return f"""
<section class="results">
  <h2>SELECT Result</h2>
  <div class="table-wrap">
    <table>
      <thead><tr>{headers}</tr></thead>
      <tbody>{body}</tbody>
    </table>
  </div>
</section>
"""

    if result.query_type in {"construct", "describe"}:
        graph_text = escape(result.graph_text or "")
        return f"""
<section class="results">
  <h2>{result.query_type.upper()} Result</h2>
  <pre>{graph_text}</pre>
</section>
"""

    raw_text = escape(result.raw_text or "")
    return f"""
<section class="results">
  <h2>Result</h2>
  <pre>{raw_text}</pre>
</section>
"""


def _render_value(value: object) -> str:
    if value is None:
        return '<span class="muted">None</span>'
    if isinstance(value, list):
        if not value:
            return '<span class="muted">None</span>'
        items = "".join(f"<li>{_render_value(item)}</li>" for item in value)
        return f"<ul>{items}</ul>"
    if isinstance(value, tuple):
        return _render_value(list(value))
    if isinstance(value, dict):
        items = "".join(
            f"<li><strong>{escape(str(key))}:</strong> {_render_value(item)}</li>"
            for key, item in value.items()
        )
        return f"<ul>{items}</ul>"
    return escape(str(value))


def _sorted_checks(report: ValidationReport) -> list:
    return sorted(
        report.violations,
        key=lambda check: (-len(check.violations), check.check.lower()),
    )


def _render_constraints(report: ValidationReport | None) -> str:
    if report is None:
        return ""

    constraint_items = "".join(
        f"<tr><th>{escape(name)}</th><td>{_render_value(value)}</td></tr>"
        for name, value in report.constraints.items()
    )
    if not constraint_items:
        constraint_items = '<tr><td colspan="2"><span class="muted">No APV constraints found.</span></td></tr>'

    return f"""
<section class="results">
  <div class="section-heading">
    <h2>APV Constraints</h2>
    <p>Constraints detected in the ontology or remote endpoint metadata.</p>
  </div>
  <div class="table-wrap">
    <table>
      <thead>
        <tr><th>Constraint</th><th>Value</th></tr>
      </thead>
      <tbody>{constraint_items}</tbody>
    </table>
  </div>
</section>
"""


def _render_violations(report: ValidationReport | None, error_message: str | None) -> str:
    if report is None:
        return f"""
<section class="results">
  <div class="section-heading">
    <h2>APV Violations</h2>
    <p>Validation could not be completed for this source.</p>
  </div>
  <div class="alert error">{escape(error_message or "Validation failed.")}</div>
</section>
"""

    violation_count = sum(len(check.violations) for check in report.violations)
    summary = "No violations found." if violation_count == 0 else f"{violation_count} violations found."
    check_items = []
    for check in _sorted_checks(report):
        if check.violations:
            details = "".join(f"<li>{_render_value(item)}</li>" for item in check.violations)
            status = "violating"
        else:
            details = '<li><span class="muted">No violations</span></li>'
            status = "clean"
        check_items.append(
            f"""
<details class="check-card {status}" {"open" if check.violations else ""}>
  <summary class="card-top">
    <h3>{escape(check.check)}</h3>
    <span class="badge">{len(check.violations)} issues</span>
  </summary>
  <div class="check-body">
    <div class="detail-section">
      <h4>Parameters</h4>
      <div class="detail-content">{_render_value(check.parameter)}</div>
    </div>
    <div class="detail-section">
      <h4>Violations</h4>
      <ul>{details}</ul>
    </div>
  </div>
</details>
"""
        )
    checks_html = "".join(check_items)
    error_block = ""
    if error_message:
        error_block = f'<div class="alert error">{escape(error_message)}</div>'

    return f"""
<section class="results">
  <div class="section-heading">
    <h2>APV Violations</h2>
    <p>{escape(summary)}</p>
  </div>
  {error_block}
  <div class="check-grid">{checks_html}</div>
</section>
"""


def render_query_page(
    session: QuerySession,
    query: str = DEFAULT_QUERY,
    result: QueryResult | None = None,
    error_message: str | None = None,
) -> str:
    error_block = ""
    if error_message:
        error_block = f'<div class="alert error">{escape(error_message)}</div>'

    source_details = ""
    if session.mode == "local":
        source_details = f"<p><strong>Local graph:</strong> {escape(session.filename or 'uploaded ontology')}</p>"
    else:
        source_details = (
            f"<p><strong>Remote endpoint:</strong> {escape(str(session.triplestore_url or ''))}</p>"
            f"<p><strong>Username:</strong> {escape(session.username or '')}</p>"
        )

    return f"""
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{escape(session.title)}</title>
    <style>
      :root {{
        color: #122033;
        background:
          radial-gradient(circle at top left, rgba(14, 146, 105, 0.12), transparent 32%),
          linear-gradient(180deg, #f7fbff 0%, #eef6f1 100%);
        font-family: "Trebuchet MS", "Segoe UI", sans-serif;
      }}
      * {{
        box-sizing: border-box;
      }}
      body {{
        margin: 0;
        min-height: 100vh;
        padding: 24px;
      }}
      main {{
        width: min(1080px, 100%);
        margin: 0 auto;
        background: rgba(255, 255, 255, 0.96);
        border: 1px solid rgba(18, 32, 51, 0.08);
        border-radius: 24px;
        padding: 28px;
        box-shadow: 0 24px 70px rgba(18, 32, 51, 0.12);
      }}
      h1, h2, h3, h4 {{
        margin-top: 0;
      }}
      p {{
        line-height: 1.55;
      }}
      form {{
        display: grid;
        gap: 16px;
      }}
      textarea, button {{
        font: inherit;
      }}
      textarea {{
        width: 100%;
        min-height: 260px;
        padding: 14px 16px;
        border-radius: 16px;
        border: 1px solid #b8cde0;
        background: #fbfdff;
        resize: vertical;
      }}
      button, .link-button, .menu-button {{
        display: inline-block;
        border: 0;
        border-radius: 999px;
        padding: 12px 18px;
        background: linear-gradient(135deg, #0d7a83 0%, #1466c9 100%);
        color: white;
        cursor: pointer;
        text-decoration: none;
      }}
      .toolbar {{
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        align-items: center;
      }}
      .page-top {{
        display: flex;
        gap: 16px;
        align-items: flex-start;
        justify-content: space-between;
        margin-bottom: 18px;
      }}
      .page-top p {{
        margin-bottom: 0;
      }}
      .menu-button {{
        min-width: 56px;
        min-height: 56px;
        padding: 0;
        border-radius: 18px;
        font-size: 1.35rem;
        box-shadow: 0 16px 30px rgba(13, 122, 131, 0.22);
      }}
      .menu-button span {{
        display: inline-block;
        transform: translateY(-1px);
      }}
      .alert {{
        margin: 16px 0;
        padding: 14px 16px;
        border-radius: 16px;
      }}
      .error {{
        color: #7a1322;
        background: #fff0f3;
        border: 1px solid #f4bcc8;
      }}
      .meta {{
        margin: 0 0 24px;
        padding: 16px 18px;
        border-radius: 18px;
        background: #f5fbf8;
        border: 1px solid #d6e8dd;
      }}
      .section-heading {{
        display: flex;
        justify-content: space-between;
        gap: 16px;
        align-items: end;
        margin-bottom: 14px;
      }}
      .section-heading p {{
        margin: 0;
        color: #56697e;
      }}
      .results {{
        margin-top: 28px;
      }}
      .check-grid {{
        display: grid;
        gap: 18px;
        margin-top: 18px;
      }}
      .check-card {{
        width: 100%;
        border-radius: 18px;
        background: #f7fafc;
        border: 1px solid #dce6ef;
        overflow: hidden;
      }}
      .check-card.clean {{
        background: #f7fbf5;
        border-color: #d9ead1;
      }}
      .check-card.violating {{
        background: #fff8f3;
        border-color: #f0d6c1;
      }}
      .card-top {{
        display: flex;
        gap: 12px;
        justify-content: space-between;
        align-items: center;
        padding: 16px 18px;
        cursor: pointer;
        list-style: none;
      }}
      .card-top::-webkit-details-marker {{
        display: none;
      }}
      .check-body {{
        padding: 0 18px 18px;
      }}
      .detail-section + .detail-section {{
        margin-top: 18px;
      }}
      .detail-section h4 {{
        margin-bottom: 8px;
        color: #466079;
        letter-spacing: 0.02em;
        text-transform: uppercase;
        font-size: 0.82rem;
      }}
      .detail-content {{
        overflow-wrap: anywhere;
        word-break: break-word;
      }}
      .check-body p,
      .check-body li,
      .check-body td,
      .check-body strong,
      .check-body span {{
        overflow-wrap: anywhere;
        word-break: break-word;
      }}
      .badge {{
        white-space: nowrap;
        padding: 6px 10px;
        border-radius: 999px;
        background: #eaf0f8;
        color: #47607a;
        font-size: 0.85rem;
      }}
      .table-wrap {{
        overflow-x: auto;
        border: 1px solid #d7e0ea;
        border-radius: 18px;
      }}
      table {{
        width: 100%;
        border-collapse: collapse;
      }}
      th, td {{
        text-align: left;
        padding: 12px 14px;
        border-bottom: 1px solid #e4ebf2;
        vertical-align: top;
      }}
      th {{
        background: #f7fafc;
      }}
      pre {{
        margin: 0;
        padding: 16px;
        overflow-x: auto;
        border-radius: 18px;
        background: #0f1722;
        color: #eef5ff;
      }}
      ul {{
        margin: 8px 0 0 18px;
        padding: 0;
      }}
      .muted {{
        color: #61758b;
      }}
      .drawer {{
        position: fixed;
        top: 0;
        right: 0;
        width: min(520px, 100%);
        height: 100vh;
        padding: 24px;
        background: rgba(248, 252, 255, 0.98);
        border-left: 1px solid rgba(18, 32, 51, 0.1);
        box-shadow: -18px 0 48px rgba(18, 32, 51, 0.16);
        transform: translateX(100%);
        transition: transform 220ms ease;
        z-index: 20;
        overflow-y: auto;
      }}
      .drawer.open {{
        transform: translateX(0);
      }}
      .drawer-header {{
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: start;
        margin-bottom: 18px;
      }}
      .drawer-close {{
        border: 0;
        background: transparent;
        color: #45596f;
        font-size: 1.5rem;
        cursor: pointer;
      }}
      .drawer-scrim {{
        position: fixed;
        inset: 0;
        background: rgba(8, 17, 29, 0.32);
        opacity: 0;
        pointer-events: none;
        transition: opacity 220ms ease;
        z-index: 10;
      }}
      .drawer-scrim.open {{
        opacity: 1;
        pointer-events: auto;
      }}
      .query-shell {{
        display: grid;
        gap: 16px;
      }}
      .loading {{
        position: fixed;
        inset: 0;
        display: none;
        place-items: center;
        background: rgba(12, 20, 31, 0.36);
        z-index: 30;
      }}
      .loading.visible {{
        display: grid;
      }}
      .loading-card {{
        min-width: 280px;
        padding: 24px;
        border-radius: 24px;
        background: white;
        box-shadow: 0 24px 60px rgba(18, 32, 51, 0.18);
        text-align: center;
      }}
      .spinner {{
        width: 42px;
        height: 42px;
        margin: 0 auto 14px;
        border-radius: 50%;
        border: 4px solid #d7e7f5;
        border-top-color: #1466c9;
        animation: spin 0.8s linear infinite;
      }}
      @keyframes spin {{
        to {{
          transform: rotate(360deg);
        }}
      }}
      @media (max-width: 720px) {{
        body {{
          padding: 14px;
        }}
        main {{
          padding: 20px;
        }}
        .page-top {{
          align-items: stretch;
        }}
      }}
    </style>
  </head>
  <body>
    <div id="drawer-scrim" class="drawer-scrim" onclick="closeDrawer()"></div>
    <aside id="sparql-drawer" class="drawer" aria-hidden="true">
      <div class="drawer-header">
        <div>
          <h2>SPARQL Console</h2>
          <p>Run ad hoc queries without leaving the APV report.</p>
        </div>
        <button class="drawer-close" type="button" aria-label="Close SPARQL panel" onclick="closeDrawer()">×</button>
      </div>
      <div class="query-shell">
        {error_block}
        <form action="/api/v1/triplestore/query" method="post" onsubmit="showLoading()">
          <input type="hidden" name="session_id" value="{escape(session.session_id)}" />
          <label for="query"><strong>SPARQL query</strong></label>
          <textarea id="query" name="query">{escape(query)}</textarea>
          <div class="toolbar">
            <button type="submit">Run Query</button>
            <a class="link-button" href="/">Start Over</a>
          </div>
        </form>
        {_render_result(result)}
      </div>
    </aside>
    <main>
      <div class="page-top">
        <div>
          <h1>{escape(session.title)}</h1>
          <p>Review the APV constraints and validation violations for the selected ontology source.</p>
        </div>
        <button class="menu-button" type="button" aria-label="Open SPARQL menu" onclick="openDrawer()"><span>☰</span></button>
      </div>
      <div class="meta">{source_details}</div>
      {_render_constraints(session.validation_report)}
      {_render_violations(session.validation_report, session.validation_error)}
    </main>
    <div id="loading" class="loading" aria-hidden="true">
      <div class="loading-card">
        <div class="spinner"></div>
        <h3>Running SPARQL Query</h3>
        <p>This can take a little while for larger graphs or remote endpoints.</p>
      </div>
    </div>
    <script>
      const drawer = document.getElementById("sparql-drawer");
      const scrim = document.getElementById("drawer-scrim");
      const loading = document.getElementById("loading");
      const hasQueryFeedback = {str(bool(result or error_message)).lower()};

      function openDrawer() {{
        drawer.classList.add("open");
        scrim.classList.add("open");
        drawer.setAttribute("aria-hidden", "false");
      }}

      function closeDrawer() {{
        drawer.classList.remove("open");
        scrim.classList.remove("open");
        drawer.setAttribute("aria-hidden", "true");
      }}

      function showLoading() {{
        loading.classList.add("visible");
        loading.setAttribute("aria-hidden", "false");
      }}

      if (hasQueryFeedback) {{
        openDrawer();
      }}
    </script>
  </body>
</html>
"""


@router.post("/submit", response_class=HTMLResponse, summary="Open the SPARQL query interface")
async def submit_triplestore_input(submission: SubmissionInputDep) -> HTMLResponse:
    try:
        session = await process_submission(
            ontology_file=submission.ontology_file,
            triplestore_url=submission.triplestore_url,
            username=submission.username,
            password=submission.password,
        )
    except SubmissionError as exc:
        return HTMLResponse(content=get_home_page(str(exc)), status_code=400)

    return HTMLResponse(content=render_query_page(session))


@router.post("/query", response_class=HTMLResponse, summary="Run a SPARQL query against the active source")
async def query_triplestore(
    session_id: str = Form(...),
    query: str = Form(...),
) -> HTMLResponse:
    try:
        session = load_session(session_id)
        result = run_query(session_id, query)
    except (QueryExecutionError, SubmissionError) as exc:
        try:
            session = load_session(session_id)
            return HTMLResponse(content=render_query_page(session, query=query, error_message=str(exc)), status_code=400)
        except QueryExecutionError:
            return HTMLResponse(content=get_home_page(str(exc)), status_code=400)

    return HTMLResponse(content=render_query_page(session, query=query, result=result))
