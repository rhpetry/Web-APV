"""Reusable APV validation reporting helpers."""

from __future__ import annotations

from typing import Any

from .cli import _build_constraints, _build_results
from .quality_criteria import (
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
from .sparql_client import SparqlClient


def build_validation_report(client: SparqlClient) -> dict[str, Any]:
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
        "constraints": _build_constraints(
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
        "violations": _build_results(
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
