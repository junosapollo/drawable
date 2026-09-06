"""LineScout ML package: taxonomy, manifest schema, and validation.

Milestone 1 ships the shared vocabulary and the manifest contract. Ingestion,
training, index construction, and evaluation land in later milestones.
"""

from linescout_ml.taxonomy import LineArtOrigin, PrimaryStyle, ScopeLabel

__all__ = ["LineArtOrigin", "PrimaryStyle", "ScopeLabel"]
