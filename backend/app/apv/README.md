# APV - OWL Ontology Verification CLI

A small CLI tool to verify OWL ontologies (RDF graphs) by executing SPARQL queries against a local RDF file or a remote SPARQL endpoint.

## Features

- Load an RDF file locally (`--local, -l`).
- Connect to a SPARQL endpoint remotely (`--remote, -r`) with optional credentials.
- Run quality criteria checks (e.g., list distinct annotation properties used in the ontology).

## Supported tests

| Subject                      	| Annotation                          	| Purpose                                                                                                  	|
|------------------------------	|-------------------------------------	|----------------------------------------------------------------------------------------------------------	|
| owl:Ontology                 	| apv:GlobalMinLanguageCoverage       	| Ensures all annotation properties have mandatory translations                                            	|
| owl:Ontology                 	| apv:*URIFormationRule               	| Enforce URI naming conventions for Classes, Relations and Instances                                      	|
| owl:Ontology                 	| apv:*MinAnnotationCoverage          	| Ensures mandatory annotation properties and cardinality on Classes, Relations, Instances and InstancesOf 	|
| owl:AnnotationProperty 	| apv:[Min\|Max]AnnotationLength      	| Enforce a minimum and maximum character length for the annotation value                                  	|
| owl:AnnotationProperty 	| apv:AnnotationRegularExpression     	| Enforce a syntactic convention for the annotation value                                                  	|
| owl:Class               	| apv:InstanceOfMinAnnotationCoverage 	| Ensures Instances of the Class have mandatory annotation properties and cardinality                      	|

## Annotation usage examples

| Predicate | Object | Example |
| --- | --- | --- |
| owl:Ontology | apv:GlobalMinLanguageCoverage | en-US es pt-BR # IANA lang-code |
| owl:Ontology | apv:ClassURIFormationRule | MyOntoClass\_[0-9]{5} #Regular expression |
| owl:Ontology | apv:RelationURIFormationRule | MyOntoRel\_[0-9]{5} #Regular expression |
| owl:Ontology | apv:InstanceURIFormationRule | MyOntoInstance\_[0-9]{5} #Regular expression |
| owl:Ontology | apv:ClassMinAnnotationCoverage | rdfs:label skos:prefLabel skos:definition 2ˆskos:example #Cardinality constraint |
| owl:Ontology | apv:RelationMinAnnotationCoverage | rdfs:label skos:definition #Cardinality constraint |
| owl:Ontology | apv:InstanceMinAnnotationCoverage | rdfs:label #Cardinality constraint |
| owl:AnnotationProperty | apv:MinAnnotationLength | 20 #Min char size |
| owl:AnnotationProperty | apv:MaxAnnotationLength | 400 #Max char size |
| owl:AnnotationProperty | apv:AnnotationRegularExpression | [a-zA-ZÀ-ú.;,]* #Value format constraint |
| owl:Class | apv:InstanceOfMinAnnotationCoverage | myAnnotations:llmFriendlyDescription #Aditional constraint over portion of the taxonomy |

## Quickstart

Run locally against an RDF file:

```bash
uv run main.py --local data/o3po.ttl
```

Run against a remote SPARQL endpoint:

```bash
uv run main.py --remote <SPARQL-server>
```
