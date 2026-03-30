# AGENTS.md

## Project Summary

APV is a Python CLI for validating OWL ontologies stored as RDF graphs.

It supports two execution modes:

- local RDF file validation
- remote SPARQL endpoint validation

The project reads validation rules from ontology annotations in the `apv:` namespace and then runs SPARQL-based checks against the ontology data.

## Main Goal

The intended goal is to let ontology authors declare quality constraints inside the ontology itself and then verify compliance automatically.

Examples of supported APV constraint annotations:

- `apv:GlobalMinLanguageCoverage`
- `apv:ClassURIFormationRule`
- `apv:RelationURIFormationRule`
- `apv:InstanceURIFormationRule`
- `apv:ClassMinAnnotationCoverage`
- `apv:RelationMinAnnotationCoverage`
- `apv:InstanceMinAnnotationCoverage`
- `apv:MinAnnotationLength`
- `apv:MaxAnnotationLength`
- `apv:AnnotationRegularExpression`
- `apv:InstanceOfMinAnnotationCoverage`

## Tech Stack

- Python `>=3.14`
- `rdflib>=7.6.0`
- `language-tags>=1.2.0`
- dependency management via `uv`

Declared in `pyproject.toml`, locked in `uv.lock`.

## Entrypoint

- `main.py`: thin process entrypoint, calls `apv.cli.main()`

Recommended local run:

```bash
uv run main.py --local data/o3po.ttl
```

Example edited sample:

```bash
uv run main.py --local data/o3po-edited.ttl
```

Human-readable output:

```bash
uv run main.py --local data/o3po-edited.ttl --text
```

Structured JSON output:

```bash
uv run main.py --local data/o3po-edited.ttl --json
```

Remote endpoint mode:

```bash
uv run main.py --remote <SPARQL-endpoint> --user <user> --password <password>
```

## Repository Structure

- `main.py`: CLI entrypoint
- `apv/__init__.py`: package metadata
- `apv/cli.py`: argument parsing, orchestration, console output
- `apv/sparql_client.py`: abstraction over local `rdflib.Graph` and remote `SPARQLStore`
- `apv/quality_criteria.py`: retrieves APV constraints from ontology annotations
- `apv/quality_testing.py`: executes actual validation checks
- `data/o3po.ttl`: base ontology sample
- `data/o3po-edited.ttl`: ontology sample with APV constraints and intentional validation failures
- `README.md`: project intent and advertised feature set

## Architecture

The code follows a simple 4-step flow:

1. Parse CLI arguments in `apv/cli.py`
2. Build a `SparqlClient`
3. Retrieve APV constraints from the ontology via `apv/quality_criteria.py`
4. Run validation logic in `apv/quality_testing.py` and print violations

### Layer Responsibilities

`apv/sparql_client.py`

- `SparqlClient.from_local_file(...)` loads an RDF graph into memory
- `SparqlClient.from_remote_endpoint(...)` creates a SPARQL-backed graph
- `SparqlClient.query(...)` provides a single query interface to both modes

`apv/quality_criteria.py`

- retrieves constraint declarations from ontology metadata
- validates basic syntax of retrieved values
- examples:
  - regex compilation for URI rules and annotation regex constraints
  - IANA language-tag validation via `language-tags`
  - parsing cardinality expressions like `2^skos:example`

`apv/quality_testing.py`

- contains enforcement logic
- currently implemented as direct SPARQL queries plus Python-side checking
- returns lists of violations that the CLI assembles into text or JSON reports

`apv/cli.py`

- coordinates retrieval and enforcement
- supports both text and JSON output modes
- retrieves ontology constraints once, executes validations once, then renders the chosen output format
- JSON output is separated into top-level `constraints` and `violations` sections

## Constraint Encoding Model

The validator expects constraints to be written inside the ontology itself.

Examples:

- ontology-level language coverage:
  - `owl:Ontology apv:GlobalMinLanguageCoverage "pt-br en"`
- ontology-level instance annotation requirement:
  - `owl:Ontology apv:InstanceMinAnnotationCoverage "rdfs:label"`
- ontology-level URI rule:
  - `owl:Ontology apv:InstanceURIFormationRule "https://...#[a-zA-Z]+"`
- annotation-property-level value constraints:
  - `owl:AnnotationProperty apv:MinAnnotationLength 20`
  - `owl:AnnotationProperty apv:MaxAnnotationLength 20`
  - `owl:AnnotationProperty apv:AnnotationRegularExpression "^2$"`
- class-level instance constraints:
  - `owl:Class apv:InstanceOfMinAnnotationCoverage "rdf:label 2^skos:example"`

## Current Behavior

All major checks advertised in the codebase are now implemented except for a standalone enforcement pass for `GlobalMinLanguageCoverage`.

### Retrieved constraints

- class URI formation rule
- relation URI formation rule
- instance URI formation rule
- global minimum language coverage
- class minimum annotation coverage
- relation minimum annotation coverage
- instance minimum annotation coverage
- minimum annotation length
- maximum annotation length
- annotation regular expression
- instance-of minimum annotation coverage

### Enforced checks

- class URI formation rule
- relation URI formation rule
- instance URI formation rule
- class minimum annotation coverage
- relation minimum annotation coverage
- instance minimum annotation coverage
- minimum annotation length
- maximum annotation length
- annotation regular expression
- instance-of minimum annotation coverage

### Constraint without dedicated enforcement

- `GlobalMinLanguageCoverage`

The language coverage values are still used by the coverage validators, but there is no separate validator that checks ontology-wide translation completeness as an independent pass.

## Output Modes

The CLI supports two output modes:

- `--text`
  - default
  - prints retrieved constraints first, then human-readable violation summaries
- `--json`
  - prints a JSON object with this shape:

```json
{
  "constraints": {
    "class_uri_formation_rule": null,
    "language_coverage": ["pt-br", "en"]
  },
  "violations": [
    {
      "check": "InstanceURIFormationRule",
      "parameter": "https://...#[a-zA-Z]+",
      "violations": ["https://...#v1234"]
    }
  ]
}
```

Notes:

- `constraints` contains the retrieved ontology quality parameters
- `violations` contains per-check violation outputs
- today the `violations` entries still include a `parameter` field even though the top-level `constraints` section exists; this is redundant but currently intentional in the implementation

## Important Runtime Notes

- Validation is query-driven and may become slow on large ontologies because many checks issue nested SPARQL queries inside Python loops.
- The coverage checks enforce exact cardinality, not merely minimum cardinality.
- If language tags are configured, coverage checks require the exact count per configured language.
- Prefix-style annotation properties such as `rdfs:label` are passed through directly into SPARQL queries.
- Full IRIs are normalized by wrapping them in `<...>` before query interpolation.

## Known Gaps and Risks

### 1. Feature mismatch with README

The README advertises more checks than the code currently enforces.

### 2. Reporting model is partially redundant

JSON output now exists, but the per-check objects in `violations` still repeat a `parameter` field that overlaps with the top-level `constraints` section.

### 3. Exit-code policy is still minimal

The CLI returns `0` even when violations are found. There is still no failure exit-code policy for validation errors.

### 4. No automated tests

The repository currently has no unit or integration test suite.

### 5. Very new Python baseline

The project requires Python `3.14`, which may be stricter than necessary and can reduce portability.

### 6. Type annotations are inconsistent

Some function return annotations do not match actual return values precisely.

## Sample Data Guidance

`data/o3po.ttl`

- clean ontology sample
- useful as a baseline ontology input

`data/o3po-edited.ttl`

- includes APV annotations
- includes intentionally useful validation cases
- observed runtime behavior includes:
  - instance URI violations for resources whose IRIs do not match the configured pattern
  - instance annotation coverage failures
  - annotation regex failures
  - class-scoped instance coverage failures
- this file changes during development, so treat its current contents as the source of truth for expected manual test output

## Good Next Tasks for Agents

- add a dedicated standalone validator for `GlobalMinLanguageCoverage`
- remove redundant `parameter` duplication from JSON `violations` entries if the team wants a cleaner output contract
- define exit-code behavior for validation failures
- add tests around sample ontologies
- consider consolidating repeated SPARQL patterns
- consider normalizing JSON tuple-like outputs into explicit dictionaries for downstream consumers

## Working Assumptions For Future Agents

- prefer preserving the current architecture unless the task explicitly asks for refactoring
- treat `data/o3po-edited.ttl` as the main manual verification fixture
- if changing validation semantics, verify whether the intended rule is minimum cardinality or exact cardinality
- keep local-file and remote-endpoint support working through the same `SparqlClient` interface
- avoid assuming the README is fully synchronized with implementation
- if you change JSON output, verify both `--text` and `--json` modes because they share the same result-building path

## Quick Orientation

If you are new to the repo, read files in this order:

1. `README.md`
2. `pyproject.toml`
3. `apv/cli.py`
4. `apv/sparql_client.py`
5. `apv/quality_criteria.py`
6. `apv/quality_testing.py`
7. `data/o3po-edited.ttl`

This gives the fastest path to understanding the project’s intent, data model, and current implementation state.
