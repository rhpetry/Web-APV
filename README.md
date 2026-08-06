# Web-APV

Web-APV is a browser-based tool for evaluating whether an ontology conforms to
the annotation-quality constraints defined by the Annotation Property
Verificator (APV) methodology. It discovers APV constraints embedded in an RDF
graph, runs the corresponding validation checks, and presents progress and
violations through an interactive web interface.

All local processing takes place in the browser. Ontologies loaded from the
user's computer are parsed and evaluated without being uploaded to an
application server. Web-APV can also evaluate graphs exposed through remote
SPARQL endpoints when those endpoints permit browser access through CORS.

## APV methodology and vocabulary

APV supports explicit, machine-processable quality requirements for ontology
annotations. Ontology authors can use the vocabulary to define requirements
for URI formation, multilingual annotations, annotation coverage and
cardinality, annotation length, and value syntax.

The canonical OWL vocabulary is maintained separately in the
[OWL-APV repository](https://github.com/rhpetry/OWL-APV). That repository is the
authoritative source for `APV.rdf` and its constraint definitions. This
repository contains the companion validation software.

## Validation capabilities

Web-APV discovers and evaluates the following configurable constraints:

| Constraint | Purpose |
| --- | --- |
| `ClassURIFormationRule` | Checks class IRIs against a regular-expression rule. |
| `RelationURIFormationRule` | Checks relation IRIs against a regular-expression rule. |
| `InstanceURIFormationRule` | Checks individual IRIs against a regular-expression rule. |
| `GlobalMinimumLanguageCoverage` | Checks whether annotations provide the required language-tag coverage. |
| `ClassMinAnnotationCoverage` | Checks required annotations and minimum cardinalities for classes. |
| `RelationMinAnnotationCoverage` | Checks required annotations and minimum cardinalities for relations. |
| `InstanceMinAnnotationCoverage` | Checks required annotations and minimum cardinalities for individuals. |
| `MinAnnotationLength` | Checks minimum character lengths for annotation values. |
| `MaxAnnotationLength` | Checks maximum character lengths for annotation values. |
| `AnnotationRegularExpression` | Checks annotation values against configured regular expressions. |
| `InstanceOfMinAnnotationCoverage` | Checks class-specific annotation requirements for individuals. |

Constraint discovery precedes validation. The interface displays the extracted
configuration and allows temporary overrides for the current evaluation
session without modifying the source ontology.

## Features

- Local evaluation of RDF graphs entirely within the browser
- Direct evaluation of CORS-enabled SPARQL endpoints
- Optional bearer-token or Keycloak authentication for remote endpoints
- APV constraint discovery and session-level constraint editing
- Per-check progress, iteration counts, execution time, and violation details
- Prefix resolution for compact IRIs used in constraint values
- An integrated SPARQL workbench for inspecting the selected graph
- A Web Worker execution model that keeps evaluation work off the UI thread

## Architecture

Web-APV is a Vite and React single-page application written in TypeScript. It
uses the WebAssembly build of Oxigraph to parse, store, and query local RDF
graphs. APV constraint discovery and validation execute in a dedicated Web
Worker, while remote datasets are queried directly through their SPARQL HTTP
endpoints.

```text
src/
  App.tsx                    User interface and evaluation workflow
  constants.ts              Constraint descriptions and application constants
  types.ts                  Shared application types
  lib/
    apv.ts                   RDF access and APV validation logic
    workerProtocol.ts        UI/worker message protocol
  workers/
    evaluator.worker.ts      Background evaluation runtime
```

The downloadable `public/OWL-APV.rdf` file is a distribution copy of the
canonical `APV.rdf` artifact maintained on the `main` branch of
[OWL-APV](https://github.com/rhpetry/OWL-APV). Vocabulary development and
version history remain in OWL-APV.

## Running locally

### Requirements

- Node.js with npm
- A current browser with WebAssembly and Web Worker support

Install the dependencies and start the development server:

```bash
git clone https://github.com/rhpetry/Web-APV.git
cd Web-APV
npm install
npm run dev
```

Open the local URL reported by Vite.

To create and preview a production build:

```bash
npm run build
npm run preview
```

## Using Web-APV

1. Select a local ontology file or configure a remote SPARQL endpoint.
2. Start constraint discovery to load the APV configuration encoded in the
   graph.
3. Review the discovered constraints and, if needed, apply temporary overrides.
4. Run the validation checks.
5. Inspect the reported violations, iteration counts, and execution times.

Local inputs support common RDF serializations, including RDF/XML, Turtle,
N-Triples, N3, and JSON-LD. Remote endpoints must allow requests from the
browser through CORS. Authentication credentials entered for a remote endpoint
are used by the browser for that connection; Web-APV has no application backend
to receive or persist them.

## Privacy and execution model

For local-file evaluations, parsing, querying, constraint discovery, and
validation remain in browser memory. The application does not provide
server-side storage, and the in-memory graph is discarded when the page is
reloaded or closed. Remote endpoint evaluations necessarily send SPARQL
requests to the configured endpoint.

## Limitations

- Remote evaluation depends on endpoint availability, supported SPARQL
  behavior, and a compatible CORS configuration.
- Local graphs are held in memory and are not persisted across browser reloads.
- Evaluation time and memory use depend on the size and structure of the graph
  and on the enabled constraints.
- Web-APV validates the APV constraints implemented by this application; it is
  not a general-purpose OWL reasoner or a replacement for ontology consistency
  reasoning.

## Reproducibility scripts

The repository includes scripts used to exercise APV evaluation and benchmark
the implementation:

```bash
npm run reproduce:obo
```

See the scripts in `scripts/` for their expected inputs and execution details.

## Contributing

Issues and pull requests are welcome. Changes to the Web-APV interface or
validation implementation should be proposed in this repository. Changes to
the APV vocabulary itself should be proposed in
[OWL-APV](https://github.com/rhpetry/OWL-APV).

## Citation

If you use Web-APV in academic work, cite the associated APV publication once
its bibliographic record is available. Publication metadata will be added here
when finalized.

## Authors and acknowledgements

The APV methodology was developed at the Federal University of Rio Grande do
Sul (UFRGS). The APV ontology identifies Rafael Humann Petry as creator and
Nicolau O. Santos, Haroldo R. S. Silva, Mara Abel, and Joao C. Netto as
contributors.
