# Benchmark data

`run-uniform-obo-benchmark.mjs` reads five OWL files from `scripts/data/`.
It creates that directory and downloads any missing ontology automatically.
The directory is gitignored because the release artifacts are large. The
benchmark inputs currently use these immutable upstream revisions:

| File | Repository | Commit | Upstream artifact |
| --- | --- | --- | --- |
| `apollo_sv.owl` | `ApolloDev/apollo-sv` | `a3f846176ab1ca29ba3e343fe769ca98f0fc94b8` | `apollo_sv.owl` |
| `disdriv.owl` | `DiseaseOntology/DiseaseDriversOntology` | `ef481df386a727852377f575dade775e30a4b4a4` | `src/ontology/disdriv.owl` |
| `doid.owl` | `DiseaseOntology/HumanDiseaseOntology` | `c55d39e50fdb27ad843abccd8461c61e0a1e7f24` | `src/ontology/doid.owl` |
| `maxo.owl` | `monarch-initiative/MAxO` | `1e3aa56cc6e4fb40836e57d0baccf7e3ee64e694` | `maxo.owl` |
| `mondo.owl` | `monarch-initiative/mondo` | `47cabf494839ec2c2e99f5af6436e841771d1590` (`v2026-07-06`) | GitHub release asset `mondo.owl` |

Run the benchmark from the repository root with:

```bash
npm run reproduce:obo
```

To append Markdown summary tables after the JSON output, pass `--tables`:

```bash
npm run reproduce:obo -- --tables
```
