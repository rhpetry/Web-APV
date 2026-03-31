import sys
from pathlib import Path
from typing import Any


APV_SUBMODULE_ROOT = Path(__file__).resolve().parent / "api" / "apv"


def build_validation_report_from_local_file(path: str, graph_format: str) -> dict[str, Any]:
    _ensure_apv_submodule_on_path()

    from apv.cli import _build_constraints, _build_results
    from apv.quality_criteria import (
        retrieve_annotation_regular_expression,
        retrieve_class_annotation_coverage,
        retrieve_class_uri_formation_rule,
        retrieve_instance_annotation_coverage,
        retrieve_instance_of_annotation_coverage,
        retrieve_instance_uri_formation_rule,
        retrieve_language_tags,
        retrieve_max_annotation_length,
        retrieve_min_annotation_length,
        retrieve_relation_annotation_coverage,
        retrieve_relation_uri_formation_rule,
    )
    from apv.sparql_client import SparqlClient

    client = SparqlClient.from_local_file(path, format=graph_format)
    return _build_report(
        client,
        _build_constraints,
        _build_results,
        retrieve_annotation_regular_expression,
        retrieve_class_annotation_coverage,
        retrieve_class_uri_formation_rule,
        retrieve_instance_annotation_coverage,
        retrieve_instance_of_annotation_coverage,
        retrieve_instance_uri_formation_rule,
        retrieve_language_tags,
        retrieve_max_annotation_length,
        retrieve_min_annotation_length,
        retrieve_relation_annotation_coverage,
        retrieve_relation_uri_formation_rule,
    )


def build_validation_report_from_remote_endpoint(
    endpoint: str,
    username: str,
    password: str,
) -> dict[str, Any]:
    _ensure_apv_submodule_on_path()

    from apv.cli import _build_constraints, _build_results
    from apv.quality_criteria import (
        retrieve_annotation_regular_expression,
        retrieve_class_annotation_coverage,
        retrieve_class_uri_formation_rule,
        retrieve_instance_annotation_coverage,
        retrieve_instance_of_annotation_coverage,
        retrieve_instance_uri_formation_rule,
        retrieve_language_tags,
        retrieve_max_annotation_length,
        retrieve_min_annotation_length,
        retrieve_relation_annotation_coverage,
        retrieve_relation_uri_formation_rule,
    )
    from apv.sparql_client import SparqlClient

    client = SparqlClient.from_remote_endpoint(endpoint, user=username, password=password)
    return _build_report(
        client,
        _build_constraints,
        _build_results,
        retrieve_annotation_regular_expression,
        retrieve_class_annotation_coverage,
        retrieve_class_uri_formation_rule,
        retrieve_instance_annotation_coverage,
        retrieve_instance_of_annotation_coverage,
        retrieve_instance_uri_formation_rule,
        retrieve_language_tags,
        retrieve_max_annotation_length,
        retrieve_min_annotation_length,
        retrieve_relation_annotation_coverage,
        retrieve_relation_uri_formation_rule,
    )


def _ensure_apv_submodule_on_path() -> None:
    apv_path = str(APV_SUBMODULE_ROOT)
    if apv_path not in sys.path:
        sys.path.insert(0, apv_path)


def _build_report(
    client: Any,
    build_constraints: Any,
    build_results: Any,
    retrieve_annotation_regular_expression: Any,
    retrieve_class_annotation_coverage: Any,
    retrieve_class_uri_formation_rule: Any,
    retrieve_instance_annotation_coverage: Any,
    retrieve_instance_of_annotation_coverage: Any,
    retrieve_instance_uri_formation_rule: Any,
    retrieve_language_tags: Any,
    retrieve_max_annotation_length: Any,
    retrieve_min_annotation_length: Any,
    retrieve_relation_annotation_coverage: Any,
    retrieve_relation_uri_formation_rule: Any,
) -> dict[str, Any]:
    class_uri_formation_rule = retrieve_class_uri_formation_rule(client)
    relation_uri_formation_rule = retrieve_relation_uri_formation_rule(client)
    instance_uri_formation_rule = retrieve_instance_uri_formation_rule(client)
    language_tags = retrieve_language_tags(client)
    class_annotation_cardinalities = retrieve_class_annotation_coverage(client)
    relation_annotation_cardinalities = retrieve_relation_annotation_coverage(client)
    instance_annotation_cardinalities = retrieve_instance_annotation_coverage(client)
    min_annotation_lengths = retrieve_min_annotation_length(client)
    max_annotation_lengths = retrieve_max_annotation_length(client)
    annotation_regex_expressions = retrieve_annotation_regular_expression(client)
    instance_coverage_requirements = retrieve_instance_of_annotation_coverage(client)

    return {
        "constraints": build_constraints(
            class_uri_formation_rule,
            relation_uri_formation_rule,
            instance_uri_formation_rule,
            language_tags,
            class_annotation_cardinalities,
            relation_annotation_cardinalities,
            instance_annotation_cardinalities,
            min_annotation_lengths,
            max_annotation_lengths,
            annotation_regex_expressions,
            instance_coverage_requirements,
        ),
        "violations": build_results(
            client,
            class_uri_formation_rule,
            relation_uri_formation_rule,
            instance_uri_formation_rule,
            language_tags,
            class_annotation_cardinalities,
            relation_annotation_cardinalities,
            instance_annotation_cardinalities,
            min_annotation_lengths,
            max_annotation_lengths,
            annotation_regex_expressions,
            instance_coverage_requirements,
        ),
    }
