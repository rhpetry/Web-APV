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

const DATA_DIRECTORY = path.resolve("scripts/data");

const ONTOLOGIES = [
  {
    file: "apollo_sv.owl",
    name: "Apollo-SV",
    url: "https://raw.githubusercontent.com/ApolloDev/apollo-sv/a3f846176ab1ca29ba3e343fe769ca98f0fc94b8/apollo_sv.owl",
  },
  {
    file: "disdriv.owl",
    name: "DISDRIV",
    url: "https://raw.githubusercontent.com/DiseaseOntology/DiseaseDriversOntology/ef481df386a727852377f575dade775e30a4b4a4/src/ontology/disdriv.owl",
  },
  {
    file: "doid.owl",
    name: "DOID",
    url: "https://raw.githubusercontent.com/DiseaseOntology/HumanDiseaseOntology/c55d39e50fdb27ad843abccd8461c61e0a1e7f24/src/ontology/doid.owl",
  },
  {
    file: "maxo.owl",
    name: "MAxO",
    url: "https://raw.githubusercontent.com/monarch-initiative/MAxO/1e3aa56cc6e4fb40836e57d0baccf7e3ee64e694/maxo.owl",
  },
  {
    file: "mondo.owl",
    name: "Mondo",
    url: "https://github.com/monarch-initiative/mondo/releases/download/v2026-07-06/mondo.owl",
  },
  {
    file: "omrse.owl",
    name: "OMRSE",
    url: "https://github.com/ufbmi/OMRSE/releases/download/v2026-07-08/omrse.owl",
  },
];

async function downloadOntology({ file, url }) {
  const destination = path.join(DATA_DIRECTORY, file);
  const temporaryDestination = `${destination}.download`;

  console.error(`Downloading missing ontology ${file}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${file}: HTTP ${response.status} ${response.statusText}`);
  }

  try {
    const content = Buffer.from(await response.arrayBuffer());
    if (content.length === 0) {
      throw new Error(`Downloaded ontology ${file} is empty`);
    }
    fs.writeFileSync(temporaryDestination, content);
    fs.renameSync(temporaryDestination, destination);
  } catch (error) {
    fs.rmSync(temporaryDestination, { force: true });
    throw error;
  }
}

async function ensureOntologies() {
  fs.mkdirSync(DATA_DIRECTORY, { recursive: true });

  for (const ontology of ONTOLOGIES) {
    const destination = path.join(DATA_DIRECTORY, ontology.file);
    if (!fs.existsSync(destination) || fs.statSync(destination).size === 0) {
      await downloadOntology(ontology);
    }
  }
}

const FILES = ONTOLOGIES.map(({ file }) => path.join(DATA_DIRECTORY, file));
const ONTOLOGY_NAMES = new Map(ONTOLOGIES.map(({ file, name }) => [file, name]));
const TABLES_ENABLED = process.argv.includes("--tables");

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
    file: path.relative(process.cwd(), absolutePath),
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

function formatMarkdownTable(headers, rows) {
  const stringRows = rows.map((row) => row.map(String));
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...stringRows.map((row) => row[index].length)),
  );
  const formatRow = (row) =>
    `| ${row.map((value, index) =>
      index === 0 ? value.padEnd(widths[index]) : value.padStart(widths[index])
    ).join(" | ")} |`;
  const header = formatRow(headers);
  const separator = `| ${widths.map((width, index) =>
    index === 0 ? "-".repeat(width) : `${"-".repeat(Math.max(1, width - 1))}:`
  ).join(" | ")} |`;
  const body = stringRows.map(formatRow).join("\n");
  return `${header}\n${separator}\n${body}`;
}

function ontologyName(result) {
  return ONTOLOGY_NAMES.get(path.basename(result.file)) ?? path.basename(result.file, ".owl");
}

function classPercentage(value, classes) {
  return classes === 0 ? "0.00%" : `${((value / classes) * 100).toFixed(2)}%`;
}

function buildTables(results) {
  const annotationHeaders = [
    "Ontology",
    "Missing Labels",
    "Missing @en Label",
    "Missing Def.",
    "Missing @en Def.",
  ];

  const absoluteAnnotations = formatMarkdownTable(
    annotationHeaders,
    results.map((result) => [
      ontologyName(result),
      result.labels.classesMissingLabel,
      result.labels.classesMissingEnglishLabel,
      result.definitions.classesMissingDefinition,
      result.definitions.classesMissingEnglishDefinition,
    ]),
  );

  const percentageAnnotations = formatMarkdownTable(
    annotationHeaders,
    results.map((result) => [
      ontologyName(result),
      classPercentage(result.labels.classesMissingLabel, result.classes),
      classPercentage(result.labels.classesMissingEnglishLabel, result.classes),
      classPercentage(result.definitions.classesMissingDefinition, result.classes),
      classPercentage(result.definitions.classesMissingEnglishDefinition, result.classes),
    ]),
  );

  const valueQuality = formatMarkdownTable(
    [
      "Ontology",
      "Label Min <5",
      "Label Max >500",
      "Label Regex",
      "Def. Min <5",
      "Def. Max >500",
      "Def. Regex",
    ],
    results.map((result) => [
      ontologyName(result),
      result.valueQuality.labelMinLengthViolations,
      result.valueQuality.labelMaxLengthViolations,
      result.valueQuality.labelRegexViolations,
      result.valueQuality.definitionMinLengthViolations,
      result.valueQuality.definitionMaxLengthViolations,
      result.valueQuality.definitionRegexViolations,
    ]),
  );

  const uriViolations = formatMarkdownTable(
    ["Ontology", "Class URI Violation", "Rel. URI Violation", "Instance URI Violation"],
    results.map((result) => [
      ontologyName(result),
      result.uriNamespaces.classUriViolations,
      result.uriNamespaces.relationUriViolations,
      result.uriNamespaces.instanceUriViolations,
    ]),
  );

  const timings = formatMarkdownTable(
    ["Ontology", "Parse Time (ms)", "Validation Time (ms)"],
    results.map((result) => [ontologyName(result), result.parseMs, result.evaluationMs]),
  );

  return [
    "## Missing annotations (absolute)",
    absoluteAnnotations,
    "## Missing annotations (% of classes)",
    percentageAnnotations,
    "## Lexical and length violations (absolute)",
    valueQuality,
    "## URI formation violations (absolute)",
    "*Note: Namespace-based URI violations use namespaces that are not declared by the ontology and occur fewer than 5 times for that entity type.*",
    uriViolations,
    "## Timings",
    timings,
  ].join("\n\n");
}

await ensureOntologies();
const results = FILES.map(evaluateFile);
console.log(JSON.stringify(results, null, 2));
if (TABLES_ENABLED) {
  console.log(`\n${buildTables(results)}`);
}
