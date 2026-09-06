-- LineScout initial schema.
-- Mirrors ml/linescout_ml/manifest.py; the manifest remains the source of truth
-- and this table is a queryable cache loaded at startup.

CREATE TABLE assets (
    asset_id            TEXT PRIMARY KEY,
    source_dataset      TEXT NOT NULL,
    source_item_id      TEXT NOT NULL,
    source_work_id      TEXT NOT NULL,
    source_url          TEXT,
    license_id          TEXT NOT NULL,
    original_path       TEXT NOT NULL,
    line_art_path       TEXT NOT NULL,
    thumbnail_path      TEXT NOT NULL,
    origin              TEXT NOT NULL CHECK (origin IN ('native_line_art', 'extracted_line_art')),
    extraction_model    TEXT,
    extraction_version  TEXT,
    primary_style       TEXT NOT NULL CHECK (primary_style IN
                            ('manga_anime', 'western_ink', 'realistic_academic', 'cartoon', 'gesture_sketch')),
    scopes_json         TEXT NOT NULL,            -- JSON array of scope labels
    person_count        INTEGER NOT NULL CHECK (person_count >= 0),
    sfw_safe            INTEGER NOT NULL CHECK (sfw_safe IN (0, 1)),
    sfw_confidence      REAL NOT NULL,
    sfw_method          TEXT NOT NULL,
    width               INTEGER NOT NULL CHECK (width > 0),
    height              INTEGER NOT NULL CHECK (height > 0),
    crop_json           TEXT,                     -- JSON {x,y,width,height} or NULL
    text_coverage       REAL NOT NULL,
    ink_coverage        REAL NOT NULL,
    phash               TEXT NOT NULL,
    quality_score       REAL NOT NULL,
    review_state        TEXT NOT NULL CHECK (review_state IN
                            ('unreviewed', 'accepted', 'rejected', 'quarantined')),
    review_quality      INTEGER CHECK (review_quality IN (1, 2, 3)),
    split               TEXT NOT NULL CHECK (split IN ('train', 'validation', 'test', 'gallery_only')),
    enabled             INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    pipeline_version    TEXT NOT NULL,
    checksum            TEXT NOT NULL,
    faiss_row           INTEGER UNIQUE,           -- assigned when an index is built; 1:1 with asset_id
    -- Enabled assets must be SFW-approved. Enforced in the manifest too; defence in depth here.
    CHECK (enabled = 0 OR sfw_safe = 1),
    CHECK (enabled = 0 OR review_state IN ('unreviewed', 'accepted'))
);

CREATE INDEX assets_enabled_style_idx ON assets (enabled, primary_style);
CREATE INDEX assets_source_work_idx ON assets (source_work_id);
CREATE INDEX assets_split_idx ON assets (split);

-- Scope labels denormalised for filtering (an asset may carry several).
CREATE TABLE asset_scopes (
    asset_id    TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE CASCADE,
    scope       TEXT NOT NULL CHECK (scope IN
                    ('eye', 'face_head', 'hair', 'hand', 'foot',
                     'upper_body_clothing', 'full_body', 'multi_character')),
    PRIMARY KEY (asset_id, scope)
);
CREATE INDEX asset_scopes_scope_idx ON asset_scopes (scope);

-- Which manifest/index version is currently loaded.
CREATE TABLE gallery_versions (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),   -- singleton row
    dataset_version     TEXT NOT NULL,
    manifest_hash       TEXT NOT NULL,
    manifest_path       TEXT NOT NULL,
    asset_count         INTEGER NOT NULL,
    enabled_count       INTEGER NOT NULL,
    loaded_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Interaction events (POST /api/v1/events). Feed preference learning and evaluation.
CREATE TABLE events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL,
    asset_id        TEXT NOT NULL,
    event           TEXT NOT NULL CHECK (event IN ('open', 'pin', 'unpin', 'trace')),
    style           TEXT NOT NULL,
    query_revision  INTEGER NOT NULL CHECK (query_revision >= 0),
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX events_session_idx ON events (session_id, created_at);
CREATE INDEX events_style_idx ON events (style, created_at);

-- Local, account-free preference state (GET/PUT /api/v1/preferences).
CREATE TABLE preferences (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),   -- singleton row
    selected_style      TEXT CHECK (selected_style IS NULL OR selected_style IN
                            ('manga_anime', 'western_ink', 'realistic_academic', 'cartoon', 'gesture_sketch')),
    learning_enabled    INTEGER NOT NULL DEFAULT 1 CHECK (learning_enabled IN (0, 1)),
    affinity_reset_at   TEXT,                     -- events before this instant are ignored
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
INSERT INTO preferences (id, selected_style, learning_enabled) VALUES (1, NULL, 1);

-- Human curation labels (Milestone 2 UI writes these; schema fixed now so the
-- manifest exporter has a stable target).
CREATE TABLE curation_labels (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id            TEXT NOT NULL,
    decision            TEXT NOT NULL CHECK (decision IN ('keep', 'reject')),
    primary_style       TEXT,
    scopes_json         TEXT,
    crop_json           TEXT,
    malformed_anatomy   INTEGER NOT NULL DEFAULT 0 CHECK (malformed_anatomy IN (0, 1)),
    poor_extraction     INTEGER NOT NULL DEFAULT 0 CHECK (poor_extraction IN (0, 1)),
    quality             INTEGER CHECK (quality IN (1, 2, 3)),
    note                TEXT,
    reviewer            TEXT NOT NULL DEFAULT 'local',
    snapshot_id         TEXT,                     -- set when exported to an immutable label snapshot
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX curation_labels_asset_idx ON curation_labels (asset_id, created_at);

-- Search request log (timings only; the image is never stored).
CREATE TABLE search_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id          TEXT NOT NULL,
    revision            INTEGER NOT NULL,
    mode                TEXT NOT NULL CHECK (mode IN ('insufficient', 'provisional', 'confident')),
    stroke_count        INTEGER NOT NULL,
    point_count         INTEGER NOT NULL,
    preprocessing_ms    REAL NOT NULL,
    embedding_ms        REAL NOT NULL,
    retrieval_ms        REAL NOT NULL,
    reranking_ms        REAL NOT NULL,
    total_ms            REAL NOT NULL,
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX search_log_session_idx ON search_log (session_id, created_at);
