# Web APV

FastAPI starter organized to mirror the backend layout of `fastapi/full-stack-fastapi-template`, using `backend/app/main.py`, `backend/app/api/main.py`, route modules, and a small `core/config.py`.

## Structure

```text
backend/
  app/
    api/
      deps.py
      main.py
      routes/
        reporting.py
        triplestore.py
    core/
      config.py
    schemas/
      triplestore.py
    services/
      triplestore.py
    main.py
main.py
```

## Endpoints

- `GET /` serves a webpage that displays `hello`
- `POST /api/v1/triplestore/submit` accepts either:
- an ontology file in `.rdf`, `.owl`, or `.xml`
- a triplestore URL plus login credentials
- `GET /api/v1/reporting/` is a placeholder module for future reporting features

## Run

```bash
uv run main.py
```

Then open `http://127.0.0.1:8000`.

## API behavior

- If a file is uploaded, the API returns basic metadata about the file.
- If `triplestore_url`, `username`, and `password` are provided, the API returns the submitted connection data except for the password.
- If neither input mode is complete, the API returns `400 Bad Request`.
