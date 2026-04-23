import fs from "fs";
import path from "path";
import { performance } from "perf_hooks";

import * as oxigraph from "oxigraph";

const NS = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
  apv: "http://inf.ufrgs.br/ontologies/apv#",
  skos: "http://www.w3.org/2004/02/skos/core#",
};

const INPUT_FILES = [
  "data/ontologies/mondo-base-edited.owl",
  "data/ontologies/o3po.owl",
  "data/ontologies/o3po-edit.owl",
  "data/ontologies/o3po-base-edited.owl",
];

function namedNode(iri) {
  return oxigraph.namedNode(iri);
}

function rdf(localName) {
  return namedNode(`${NS.rdf}${localName}`);
}

function rdfs(localName) {
  return namedNode(`${NS.rdfs}${localName}`);
}

function owl(localName) {
  return namedNode(`${NS.owl}${localName}`);
}

function apv(localName) {
  return namedNode(`${NS.apv}${localName}`);
}

function ensureNamedNode(term) {
  return term?.termType === "NamedNode" ? term : null;
}

function ensureLiteral(term) {
  return term?.termType === "Literal" ? term : null;
}

function dedupeNamedNodes(nodes) {
  return [...new Map(nodes.filter(Boolean).map((node) => [node.value, node])).values()];
}

function getObjects(store, subject, predicate) {
  return store.match(subject, predicate, null, null).map((quad) => quad.object);
}

function getOntologyNode(store) {
  return dedupeNamedNodes(
    store.match(null, rdf("type"), owl("Ontology"), null).map((quad) => ensureNamedNode(quad.subject)),
  )[0] ?? null;
}

function getNamedNodesByType(store, types) {
  return dedupeNamedNodes(
    types.flatMap((type) =>
      store.match(null, rdf("type"), type, null).map((quad) => ensureNamedNode(quad.subject)),
    ),
  );
}

function getClassNodes(store) {
  return getNamedNodesByType(store, [owl("Class")]);
}

function getRelationNodes(store) {
  return getNamedNodesByType(store, [
    owl("ObjectProperty"),
    owl("DatatypeProperty"),
    owl("AnnotationProperty"),
  ]);
}

function getInstanceNodes(store) {
  const classSet = new Set(getClassNodes(store).map((node) => node.value));
  const candidates = store
    .match(null, rdf("type"), null, null)
    .filter((quad) => ensureNamedNode(quad.subject) && ensureNamedNode(quad.object))
    .filter((quad) => classSet.has(quad.object.value))
    .map((quad) => ensureNamedNode(quad.subject));
  return dedupeNamedNodes(candidates);
}

function resolveConfiguredIri(value) {
  const prefixMap = {
    rdf: NS.rdf,
    rdfs: NS.rdfs,
    owl: NS.owl,
    skos: NS.skos,
    apv: NS.apv,
  };

  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !value.includes("://")) {
    const [prefix, localName] = value.split(":", 2);
    return prefixMap[prefix] ? `${prefixMap[prefix]}${localName}` : value;
  }

  return value;
}

function parseCoverageTokens(raw) {
  if (!raw.trim()) {
    return [];
  }

  return raw.trim().split(/\s+/).map((token) => {
    if (/^\d+\^[\w:./-]+$/.test(token)) {
      const [cardinality, annotationIri] = token.split("^");
      return [resolveConfiguredIri(annotationIri), Number(cardinality)];
    }
    return [resolveConfiguredIri(token), 1];
  });
}

function getLiteralValue(store, subject, predicate) {
  return ensureLiteral(getObjects(store, subject, predicate)[0])?.value?.trim() ?? "";
}

function getLanguageTags(store) {
  const ontology = getOntologyNode(store);
  if (!ontology) {
    return [];
  }
  const raw = getLiteralValue(store, ontology, apv("GlobalMinLanguageCoverage"));
  return raw ? raw.split(/\s+/) : [];
}

function getCoverageSetting(store, label) {
  const ontology = getOntologyNode(store);
  if (!ontology) {
    return [];
  }
  return parseCoverageTokens(getLiteralValue(store, ontology, apv(label)));
}

function getRegexSetting(store, label) {
  const ontology = getOntologyNode(store);
  if (!ontology) {
    return null;
  }
  const value = getLiteralValue(store, ontology, apv(label));
  return value || null;
}

function countAnnotationValues(store, subject, predicateIri, requiredLang) {
  const values = getObjects(store, subject, namedNode(predicateIri));
  if (!requiredLang) {
    return values.length;
  }
  return values.filter((value) => ensureLiteral(value)?.language.toLowerCase() === requiredLang.toLowerCase()).length;
}

function countUriViolations(nodes, patternText) {
  if (!patternText) {
    return 0;
  }
  const pattern = new RegExp(`^(?:${patternText})$`);
  let violations = 0;
  for (const node of nodes) {
    if (!pattern.test(node.value)) {
      violations += 1;
    }
  }
  return violations;
}

function countCoverageViolations(store, nodes, requirements, languageTags) {
  let violations = 0;
  for (const subject of nodes) {
    for (const [annotationIri, requiredCardinality] of requirements) {
      if (languageTags.length > 0) {
        for (const languageTag of languageTags) {
          const count = countAnnotationValues(store, subject, annotationIri, languageTag);
          if (count !== requiredCardinality) {
            violations += 1;
          }
        }
      } else {
        const count = countAnnotationValues(store, subject, annotationIri, null);
        if (count !== requiredCardinality) {
          violations += 1;
        }
      }
    }
  }
  return violations;
}

function countAnnotationPropertyConstraints(store) {
  const annotationProperties = getNamedNodesByType(store, [owl("AnnotationProperty")]);
  let minAnnotationLength = 0;
  let maxAnnotationLength = 0;
  let annotationRegex = 0;

  for (const property of annotationProperties) {
    minAnnotationLength += getObjects(store, property, apv("MinAnnotationLength")).length;
    maxAnnotationLength += getObjects(store, property, apv("MaxAnnotationLength")).length;
    annotationRegex += getObjects(store, property, apv("AnnotationRegularExpression")).length;
  }

  return {
    minAnnotationLength,
    maxAnnotationLength,
    annotationRegex,
  };
}

function runLabelReachabilityQueries(store) {
  const queries = {
    namedClasses: `
      PREFIX owl: <${NS.owl}>
      SELECT (COUNT(DISTINCT ?c) AS ?count) WHERE {
        ?c a owl:Class .
        FILTER(!isBlank(?c))
      }
    `,
    classesWithAnyLabel: `
      PREFIX owl: <${NS.owl}>
      PREFIX rdfs: <${NS.rdfs}>
      SELECT (COUNT(DISTINCT ?c) AS ?count) WHERE {
        ?c a owl:Class ;
           rdfs:label ?label .
        FILTER(!isBlank(?c))
      }
    `,
    classesWithEnglishLabel: `
      PREFIX owl: <${NS.owl}>
      PREFIX rdfs: <${NS.rdfs}>
      SELECT (COUNT(DISTINCT ?c) AS ?count) WHERE {
        ?c a owl:Class ;
           rdfs:label ?label .
        FILTER(!isBlank(?c))
        FILTER(lang(?label) = "en")
      }
    `,
  };

  const response = {};
  for (const [key, query] of Object.entries(queries)) {
    const result = store.query(query);
    const count = result[0]?.get("count")?.value ?? "0";
    response[key] = Number(count);
  }
  return response;
}

function countTriples(store) {
  let triples = 0;
  for (const _quad of store.match(null, null, null, null)) {
    triples += 1;
  }
  return triples;
}

function evaluateFile(relativePath) {
  const absolutePath = path.resolve(relativePath);
  const content = fs.readFileSync(absolutePath, "utf8");
  const sizeBytes = fs.statSync(absolutePath).size;

  const parseStart = performance.now();
  const store = new oxigraph.Store();
  store.load(content, {
    base_iri: `file://${absolutePath}`,
    format: "application/rdf+xml",
  });
  const parseMs = performance.now() - parseStart;

  const classes = getClassNodes(store);
  const relations = getRelationNodes(store);
  const instances = getInstanceNodes(store);
  const languageTags = getLanguageTags(store);

  const classCoverage = getCoverageSetting(store, "ClassMinAnnotationCoverage");
  const relationCoverage = getCoverageSetting(store, "RelationMinAnnotationCoverage");
  const instanceCoverage = getCoverageSetting(store, "InstanceMinAnnotationCoverage");

  const evaluationStart = performance.now();
  const metrics = {
    classUriViolations: countUriViolations(classes, getRegexSetting(store, "ClassURIFormationRule")),
    relationUriViolations: countUriViolations(relations, getRegexSetting(store, "RelationURIFormationRule")),
    instanceUriViolations: countUriViolations(instances, getRegexSetting(store, "InstanceURIFormationRule")),
    classCoverageViolations: countCoverageViolations(store, classes, classCoverage, languageTags),
    relationCoverageViolations: countCoverageViolations(store, relations, relationCoverage, languageTags),
    instanceCoverageViolations: countCoverageViolations(store, instances, instanceCoverage, languageTags),
  };
  const evaluationMs = performance.now() - evaluationStart;

  return {
    file: relativePath,
    sizeBytes,
    triples: countTriples(store),
    classes: classes.length,
    relations: relations.length,
    instances: instances.length,
    languageTags,
    classCoverage,
    relationCoverage,
    instanceCoverage,
    propertyConstraintCounts: countAnnotationPropertyConstraints(store),
    queryBehavior: runLabelReachabilityQueries(store),
    parseMs: Number(parseMs.toFixed(1)),
    evaluationMs: Number(evaluationMs.toFixed(1)),
    ...metrics,
  };
}

const results = INPUT_FILES.map(evaluateFile);
console.log(JSON.stringify(results, null, 2));
