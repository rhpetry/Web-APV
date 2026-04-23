import fs from "fs";
import path from "path";
import { performance } from "perf_hooks";

import * as oxigraph from "oxigraph";

const NS = {
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  owl: "http://www.w3.org/2002/07/owl#",
  obo: "http://purl.obolibrary.org/obo/",
  skos: "http://www.w3.org/2004/02/skos/core#",
  dcterms: "http://purl.org/dc/terms/",
  dc: "http://purl.org/dc/elements/1.1/",
};

const FILES = [
  "data/obo/apollo_sv.owl",
  "data/obo/disdriv.owl",
  "data/obo/doid.owl",
  "data/obo/maxo.owl",
  "data/obo/mondo.owl",
];

const SETTINGS = {
  requiredLanguage: "en",
  minLength: 5,
  maxLength: 500,
  lexicalRegex: /^[\p{L}\p{N}\s,;:.'"_/\-()[\]%+<>=&°]*$/u,
  namespaceSupportThreshold: 5,
};

const DEFINITION_CANDIDATES = [
  { label: "obo:IAO_0000115", iri: `${NS.obo}IAO_0000115` },
  { label: "skos:definition", iri: `${NS.skos}definition` },
  { label: "dcterms:description", iri: `${NS.dcterms}description` },
  { label: "dc:description", iri: `${NS.dc}description` },
  { label: "rdfs:comment", iri: `${NS.rdfs}comment` },
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

function ensureNamedNode(term) {
  return term?.termType === "NamedNode" ? term : null;
}

function ensureLiteral(term) {
  return term?.termType === "Literal" ? term : null;
}

function getObjects(store, subject, predicate) {
  return store.match(subject, predicate, null, null).map((quad) => quad.object);
}

function getNamespace(iri) {
  const hashIndex = iri.lastIndexOf("#");
  const slashIndex = iri.lastIndexOf("/");
  const cut = Math.max(hashIndex, slashIndex);
  return cut >= 0 ? iri.slice(0, cut + 1) : iri;
}

function dedupeNamedNodes(nodes) {
  return [...new Map(nodes.filter(Boolean).map((node) => [node.value, node])).values()];
}

function getOntologyNodes(store) {
  return dedupeNamedNodes(
    store.match(null, rdf("type"), owl("Ontology"), null).map((quad) => ensureNamedNode(quad.subject)),
  );
}

function getOntologyNamespaces(store) {
  const namespaces = new Set();
  for (const ontology of getOntologyNodes(store)) {
    namespaces.add(getNamespace(ontology.value));
    for (const versionIri of getObjects(store, ontology, owl("versionIRI"))) {
      const named = ensureNamedNode(versionIri);
      if (named) {
        namespaces.add(getNamespace(named.value));
      }
    }
    for (const imported of getObjects(store, ontology, owl("imports"))) {
      const named = ensureNamedNode(imported);
      if (named) {
        namespaces.add(getNamespace(named.value));
      }
    }
  }
  return [...namespaces].sort();
}

function isDeprecated(store, subject) {
  return getObjects(store, subject, owl("deprecated")).some((value) => {
    const literal = ensureLiteral(value);
    return literal?.value === "true";
  });
}

function getNamedNodesByType(store, types) {
  return dedupeNamedNodes(
    types.flatMap((type) =>
      store.match(null, rdf("type"), type, null).map((quad) => ensureNamedNode(quad.subject)),
    ),
  );
}

function getClassNodes(store) {
  return getNamedNodesByType(store, [owl("Class")]).filter((node) => !isDeprecated(store, node));
}

function getRelationNodes(store) {
  return getNamedNodesByType(store, [
    owl("ObjectProperty"),
    owl("DatatypeProperty"),
    owl("AnnotationProperty"),
  ]).filter((node) => !isDeprecated(store, node));
}

function getInstanceNodes(store) {
  const classSet = new Set(getClassNodes(store).map((node) => node.value));
  const candidates = store
    .match(null, rdf("type"), null, null)
    .filter((quad) => ensureNamedNode(quad.subject) && ensureNamedNode(quad.object))
    .filter((quad) => classSet.has(quad.object.value))
    .map((quad) => ensureNamedNode(quad.subject));
  return dedupeNamedNodes(candidates).filter((node) => !isDeprecated(store, node));
}

function pickDefinitionProperty(store, classNodes) {
  const ranking = DEFINITION_CANDIDATES.map((candidate) => {
    let coveredClasses = 0;
    let values = 0;
    for (const classNode of classNodes) {
      const count = getObjects(store, classNode, namedNode(candidate.iri)).length;
      if (count > 0) {
        coveredClasses += 1;
        values += count;
      }
    }
    return { ...candidate, coveredClasses, values };
  }).sort((left, right) =>
    right.coveredClasses - left.coveredClasses ||
    right.values - left.values ||
    left.label.localeCompare(right.label),
  );

  return ranking[0];
}

function countTriples(store) {
  let triples = 0;
  for (const _ of store.match(null, null, null, null)) {
    triples += 1;
  }
  return triples;
}

function getLabelLiterals(store, subject) {
  return getObjects(store, subject, rdfs("label")).map((value) => ensureLiteral(value)).filter(Boolean);
}

function getDefinitionLiterals(store, subject, definitionIri) {
  return getObjects(store, subject, namedNode(definitionIri))
    .map((value) => ensureLiteral(value))
    .filter(Boolean);
}

function countMissingProperty(nodes, literalGetter) {
  let missingAny = 0;
  let missingRequiredLanguage = 0;

  for (const node of nodes) {
    const values = literalGetter(node);
    if (values.length === 0) {
      missingAny += 1;
      missingRequiredLanguage += 1;
      continue;
    }
    const hasRequiredLanguage = values.some(
      (literal) => literal.language.toLowerCase() === SETTINGS.requiredLanguage,
    );
    if (!hasRequiredLanguage) {
      missingRequiredLanguage += 1;
    }
  }

  return { missingAny, missingRequiredLanguage };
}

function countValueViolations(nodes, literalGetter) {
  let minLengthViolations = 0;
  let maxLengthViolations = 0;
  let regexViolations = 0;

  for (const node of nodes) {
    for (const literal of literalGetter(node)) {
      const value = literal.value;
      if (value.length < SETTINGS.minLength) {
        minLengthViolations += 1;
      }
      if (value.length > SETTINGS.maxLength) {
        maxLengthViolations += 1;
      }
      if (!SETTINGS.lexicalRegex.test(value)) {
        regexViolations += 1;
      }
    }
  }

  return { minLengthViolations, maxLengthViolations, regexViolations };
}

function buildAllowedNamespaces(store, nodes) {
  const counts = new Map();
  for (const node of nodes) {
    const namespace = getNamespace(node.value);
    counts.set(namespace, (counts.get(namespace) ?? 0) + 1);
  }

  const namespaces = new Set(getOntologyNamespaces(store));
  for (const [namespace, count] of counts.entries()) {
    if (count >= SETTINGS.namespaceSupportThreshold) {
      namespaces.add(namespace);
    }
  }

  return {
    allowed: [...namespaces].sort(),
    observedCounts: [...counts.entries()].sort((left, right) => right[1] - left[1]),
  };
}

function countNamespaceViolations(nodes, allowedNamespaces) {
  let violations = 0;
  for (const node of nodes) {
    if (!allowedNamespaces.some((namespace) => node.value.startsWith(namespace))) {
      violations += 1;
    }
  }
  return violations;
}

function evaluateFile(relativePath) {
  const absolutePath = path.resolve(relativePath);
  const content = fs.readFileSync(absolutePath, "utf8");

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
  const definitionProperty = pickDefinitionProperty(store, classes);

  const classNamespaces = buildAllowedNamespaces(store, classes);
  const relationNamespaces = buildAllowedNamespaces(store, relations);
  const instanceNamespaces = buildAllowedNamespaces(store, instances);

  const evaluationStart = performance.now();
  const classLabel = countMissingProperty(classes, (node) => getLabelLiterals(store, node));
  const relationLabel = countMissingProperty(relations, (node) => getLabelLiterals(store, node));
  const instanceLabel = countMissingProperty(instances, (node) => getLabelLiterals(store, node));
  const classDefinition = countMissingProperty(
    classes,
    (node) => getDefinitionLiterals(store, node, definitionProperty.iri),
  );

  const labelValues = countValueViolations(
    [...classes, ...relations, ...instances],
    (node) => getLabelLiterals(store, node),
  );
  const definitionValues = countValueViolations(
    classes,
    (node) => getDefinitionLiterals(store, node, definitionProperty.iri),
  );

  const evaluationMs = performance.now() - evaluationStart;

  return {
    file: relativePath,
    triples: countTriples(store),
    classes: classes.length,
    relations: relations.length,
    instances: instances.length,
    parseMs: Number(parseMs.toFixed(1)),
    evaluationMs: Number(evaluationMs.toFixed(1)),
    requiredLanguage: SETTINGS.requiredLanguage,
    selectedDefinitionProperty: definitionProperty,
    criteria: {
      minLength: SETTINGS.minLength,
      maxLength: SETTINGS.maxLength,
      regex: SETTINGS.lexicalRegex.source,
      namespaceSupportThreshold: SETTINGS.namespaceSupportThreshold,
    },
    labels: {
      classesMissingLabel: classLabel.missingAny,
      classesMissingEnglishLabel: classLabel.missingRequiredLanguage,
      relationsMissingLabel: relationLabel.missingAny,
      relationsMissingEnglishLabel: relationLabel.missingRequiredLanguage,
      instancesMissingLabel: instanceLabel.missingAny,
      instancesMissingEnglishLabel: instanceLabel.missingRequiredLanguage,
    },
    definitions: {
      classesMissingDefinition: classDefinition.missingAny,
      classesMissingEnglishDefinition: classDefinition.missingRequiredLanguage,
    },
    valueQuality: {
      labelMinLengthViolations: labelValues.minLengthViolations,
      labelMaxLengthViolations: labelValues.maxLengthViolations,
      labelRegexViolations: labelValues.regexViolations,
      definitionMinLengthViolations: definitionValues.minLengthViolations,
      definitionMaxLengthViolations: definitionValues.maxLengthViolations,
      definitionRegexViolations: definitionValues.regexViolations,
    },
    uriNamespaces: {
      classesAllowedNamespaces: classNamespaces.allowed,
      classUriViolations: countNamespaceViolations(classes, classNamespaces.allowed),
      relationsAllowedNamespaces: relationNamespaces.allowed,
      relationUriViolations: countNamespaceViolations(relations, relationNamespaces.allowed),
      instancesAllowedNamespaces: instanceNamespaces.allowed,
      instanceUriViolations: countNamespaceViolations(instances, instanceNamespaces.allowed),
    },
  };
}

const results = FILES.map(evaluateFile);
console.log(JSON.stringify(results, null, 2));
