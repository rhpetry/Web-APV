export const EVALUATION_KEYS = [
  "constraints",
  "ClassURIFormationRule",
  "RelationURIFormationRule",
  "InstanceURIFormationRule",
  "GlobalMinLanguageCoverage",
  "ClassMinAnnotationCoverage",
  "RelationMinAnnotationCoverage",
  "InstanceMinAnnotationCoverage",
  "MinAnnotationLength",
  "MaxAnnotationLength",
  "AnnotationRegularExpression",
  "InstanceOfMinAnnotationCoverage",
] as const;

export const CHECK_PURPOSES: Record<string, string> = {
  constraints: "Read ontology annotations and extract the APV configuration before validation starts.",
  ClassURIFormationRule: "Check whether each class IRI follows the configured naming pattern.",
  RelationURIFormationRule: "Check whether relation and annotation property IRIs follow the configured naming pattern.",
  InstanceURIFormationRule: "Check whether instance IRIs follow the configured naming pattern declared in the ontology.",
  GlobalMinLanguageCoverage: "Capture the required language tags used by annotation coverage checks.",
  ClassMinAnnotationCoverage: "Check whether every class has the required annotation properties with the expected cardinality.",
  RelationMinAnnotationCoverage: "Check whether every relation has the required annotation properties with the expected cardinality.",
  InstanceMinAnnotationCoverage: "Check whether every instance has the required annotation properties with the expected cardinality.",
  MinAnnotationLength: "Check whether annotation values meet the configured minimum character length.",
  MaxAnnotationLength: "Check whether annotation values stay within the configured maximum character length.",
  AnnotationRegularExpression: "Check whether annotation values match the configured syntax or text pattern.",
  InstanceOfMinAnnotationCoverage: "Check whether instances of specific classes carry the required annotation properties with the expected cardinality.",
};

export const APV_CONSTRAINT_INFO: Record<string, { label: string; description: string; example: string }> = {
  ClassURIFormationRule: {
    label: "Class URI formation rule",
    description:
      "Specifies a regular-expression rule for class URIs asserted in the ontology. The value should be a regular expression that every class identifier is expected to match. In APV, this rule is meant to keep identifier minting predictable and to avoid embedding semantic or linguistic meaning directly into the URI itself.",
    example: 'MyOntology (owl:Ontology) --apv:ClassURIFormationRule--> "MyOntoClass_[0-9]{5}"',
  },
  RelationURIFormationRule: {
    label: "Relation URI formation rule",
    description:
      "Specifies a regular-expression rule for relation URIs in the ontology. The value should be a regular expression that object, datatype, and annotation property identifiers are expected to satisfy. This makes relation identifiers consistent and easier to validate automatically.",
    example: 'MyOntology (owl:Ontology) --apv:RelationURIFormationRule--> "MyOntoRel_[0-9]{5}"',
  },
  InstanceURIFormationRule: {
    label: "Instance URI formation rule",
    description:
      "Specifies a regular-expression rule for individual instance URIs. The value should be a regular expression that all asserted instances are expected to match. This lets the ontology enforce a controlled naming convention for individuals.",
    example: 'MyOntology (owl:Ontology) --apv:InstanceURIFormationRule--> "MyOntoInstance_[0-9]{5}"',
  },
  GlobalMinLanguageCoverage: {
    label: "Global minimum language coverage",
    description:
      "Defines the set of language tags that annotation literals should cover across the ontology. In practice, this means APV can verify whether required translations exist for the annotation properties that are expected to be multilingual. The value is a whitespace-separated list of IANA language tags.",
    example: 'MyOntology (owl:Ontology) --apv:GlobalMinLanguageCoverage--> "en-US es pt-BR"',
  },
  ClassMinAnnotationCoverage: {
    label: "Class minimum annotation coverage",
    description:
      "Defines which annotation properties every class must carry, together with optional cardinality requirements. The value is a whitespace-separated sequence of annotation-property IRIs, optionally prefixed with a cardinality like 2^skos:example. If no cardinality is given, APV treats it as 1.",
    example:
      'MyOntology (owl:Ontology) --apv:ClassMinAnnotationCoverage--> "rdfs:label skos:prefLabel skos:definition 2^skos:example"',
  },
  RelationMinAnnotationCoverage: {
    label: "Relation minimum annotation coverage",
    description:
      "Defines which annotation properties every relation must carry, together with optional cardinality requirements. The value uses the same APV coverage syntax as the class variant: annotation-property IRIs with optional cardinalities written as number^property.",
    example:
      'MyOntology (owl:Ontology) --apv:RelationMinAnnotationCoverage--> "rdfs:label skos:definition"',
  },
  InstanceMinAnnotationCoverage: {
    label: "Instance minimum annotation coverage",
    description:
      "Defines which annotation properties every instance must carry, together with optional cardinality requirements. The value follows the same coverage syntax as the class and relation variants, allowing APV to enforce minimum documentation standards for individuals.",
    example: 'MyOntology (owl:Ontology) --apv:InstanceMinAnnotationCoverage--> "rdfs:label 2^skos:example"',
  },
  MinAnnotationLength: {
    label: "Minimum annotation length",
    description:
      "Defines the minimum character length that values of a given annotation property must contain. This annotation is attached to an owl:AnnotationProperty and is used to enforce minimum verbosity or informativeness in annotation values.",
    example: 'rdfs:label (owl:AnnotationProperty) --apv:MinAnnotationLength--> 20',
  },
  MaxAnnotationLength: {
    label: "Maximum annotation length",
    description:
      "Defines the maximum character length that values of a given annotation property may contain. This annotation is attached to an owl:AnnotationProperty and is used to keep annotation values concise and within a reasonable documentation limit.",
    example: 'rdfs:label (owl:AnnotationProperty) --apv:MaxAnnotationLength--> 400',
  },
  AnnotationRegularExpression: {
    label: "Annotation regular expression",
    description:
      "Defines a regular-expression pattern that all values of a given annotation property must match. This annotation is attached to an owl:AnnotationProperty and is used to enforce a syntactic or formatting convention for those values.",
    example:
      'rdfs:label (owl:AnnotationProperty) --apv:AnnotationRegularExpression--> "[a-zA-ZÀ-ú.;,]*"',
  },
  InstanceOfMinAnnotationCoverage: {
    label: "Instance of minimum annotation coverage",
    description:
      "Defines mandatory annotation properties and optional cardinalities for instances of a specific class. Unlike the ontology-wide instance coverage rule, this annotation is attached to an owl:Class and applies only to instances of that class, allowing class-scoped documentation requirements.",
    example:
      'MyClass (owl:Class) --apv:InstanceOfMinAnnotationCoverage--> "myAnnotations:llmFriendlyDescription"',
  },
};

export const DEFAULT_QUERY = `PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
SELECT ?subject ?predicate ?object
WHERE {
  ?subject ?predicate ?object
}
LIMIT 25`;

export const KEYCLOAK_CLIENT_ID = "anzograph";
export const KEYCLOAK_SCOPE = "openid";
