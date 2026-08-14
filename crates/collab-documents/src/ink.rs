//! Bounded structural validation for `.ink` documents.
//!
//! This is the shared trust boundary between the native client and the server:
//! both refuse to persist a drawing whose structure is malformed, exceeds the
//! documented limits, or carries geometry that cannot be drawn. It deliberately
//! does **not** generate outlines, resolve brushes, or render — that belongs to
//! the editor.
//!
//! Forward compatibility: a document declaring a `schemaVersion` newer than
//! [`CURRENT_SCHEMA_VERSION`] is checked only against the generic JSON bounds
//! applied to every structured document. A newer client may legitimately store
//! shapes this build does not know, and rejecting them would corrupt a vault
//! shared between versions. Unknown fields inside a known version are preserved
//! and ignored.
//!
//! Mirrors `INK_LIMITS` in `src/types/ink.ts`; keep the two in sync.

use serde_json::Value;

pub const INK_DOCUMENT_KIND: &str = "collab-ink";
pub const CURRENT_SCHEMA_VERSION: u64 = 1;

/// Half-extent of the drawable world, in ink units of 1/64 pt.
pub const WORLD_EXTENT: f64 = 16_777_216.0;

/// Structural limits. A document exceeding any of these is rejected outright
/// rather than truncated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InkLimits {
    pub pages_per_document: usize,
    pub layers_per_page: usize,
    pub objects_per_page: usize,
    pub objects_per_document: usize,
    pub samples_per_stroke: usize,
    pub samples_per_document: usize,
    pub text_length: usize,
    pub brushes_per_document: usize,
    pub swatches_per_document: usize,
    pub group_depth: usize,
}

pub const DEFAULT_INK_LIMITS: InkLimits = InkLimits {
    pages_per_document: 500,
    layers_per_page: 50,
    objects_per_page: 50_000,
    objects_per_document: 500_000,
    samples_per_stroke: 4_096,
    samples_per_document: 20_000_000,
    text_length: 16_384,
    brushes_per_document: 200,
    swatches_per_document: 200,
    group_depth: 8,
};

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum InkValidationError {
    #[error("ink document must be a JSON object")]
    NotAnObject,
    #[error("ink document must declare kind \"{expected}\"")]
    WrongKind { expected: &'static str },
    #[error("ink document must declare a positive integer schemaVersion")]
    InvalidSchemaVersion,
    #[error("ink document field '{field}' has the wrong type")]
    WrongType { field: &'static str },
    #[error("ink document exceeds the {limit}-{unit} limit")]
    LimitExceeded { limit: usize, unit: &'static str },
    #[error("ink document has a duplicate {kind} identifier '{id}'")]
    DuplicateId { kind: &'static str, id: String },
    #[error("ink document has an empty or invalid {kind} identifier")]
    InvalidId { kind: &'static str },
    #[error("ink document references a {kind} '{id}' that does not exist")]
    DanglingReference { kind: &'static str, id: String },
    #[error("ink stroke '{id}' has malformed sample channels")]
    MalformedSamples { id: String },
    #[error("ink object '{id}' has geometry that cannot be drawn")]
    UndrawableGeometry { id: String },
    #[error("ink image '{id}' must reference a vault-relative path")]
    UnsafeAssetPath { id: String },
}

/// Reads the declared schema version, if the document declares one at all.
pub fn schema_version(value: &Value) -> Option<u64> {
    value.get("schemaVersion")?.as_u64()
}

/// True when this build understands the document's schema version well enough
/// to validate its structure.
pub fn is_known_version(value: &Value) -> bool {
    matches!(schema_version(value), Some(version) if version <= CURRENT_SCHEMA_VERSION)
}

fn valid_id(value: Option<&Value>) -> Option<&str> {
    let id = value?.as_str()?;
    if id.is_empty() || id.len() > 128 {
        return None;
    }
    Some(id)
}

/// A finite coordinate inside the world bounds.
fn drawable(value: f64) -> bool {
    value.is_finite() && value.abs() <= WORLD_EXTENT
}

/// Rejects absolute paths, parent traversal, and anything URL-shaped.
///
/// Mirrors `isVaultRelativePath` in `src/lib/ink/document.ts`. An image object
/// is the only place a `.ink` document names something outside itself, so it is
/// the only place a malicious document could try to drive a fetch or reach out
/// of the vault.
pub fn is_vault_relative_path(path: &str) -> bool {
    if path.is_empty() || path.len() > 1024 {
        return false;
    }
    if path.starts_with('/') || path.starts_with('\\') || path.contains('\0') {
        return false;
    }
    // A scheme prefix such as `http:` or `file:`.
    if let Some(colon) = path.find(':') {
        let scheme = &path[..colon];
        if !scheme.is_empty()
            && scheme.starts_with(|c: char| c.is_ascii_alphabetic())
            && scheme
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '.' | '-'))
        {
            return false;
        }
    }
    !path.split(['/', '\\']).any(|segment| segment == "..")
}

/// Validates a parsed `.ink` document.
///
/// Callers pass documents that already cleared the generic JSON size, entry, and
/// depth bounds. Documents from a newer schema version return `Ok` untouched.
pub fn validate_document(value: &Value, limits: InkLimits) -> Result<(), InkValidationError> {
    let object = value.as_object().ok_or(InkValidationError::NotAnObject)?;

    match schema_version(value) {
        Some(0) => return Err(InkValidationError::InvalidSchemaVersion),
        Some(version) if version > CURRENT_SCHEMA_VERSION => return Ok(()),
        Some(_) => {}
        None => return Err(InkValidationError::InvalidSchemaVersion),
    }

    if object.get("kind").and_then(Value::as_str) != Some(INK_DOCUMENT_KIND) {
        return Err(InkValidationError::WrongKind {
            expected: INK_DOCUMENT_KIND,
        });
    }

    let pages = object
        .get("pages")
        .and_then(Value::as_object)
        .ok_or(InkValidationError::WrongType { field: "pages" })?;
    let page_order = object
        .get("pageOrder")
        .and_then(Value::as_array)
        .ok_or(InkValidationError::WrongType { field: "pageOrder" })?;

    if page_order.len() > limits.pages_per_document {
        return Err(InkValidationError::LimitExceeded {
            limit: limits.pages_per_document,
            unit: "page",
        });
    }

    if let Some(brushes) = object.get("brushes").and_then(Value::as_object) {
        if brushes.len() > limits.brushes_per_document {
            return Err(InkValidationError::LimitExceeded {
                limit: limits.brushes_per_document,
                unit: "brush",
            });
        }
    }
    if let Some(swatches) = object.get("swatches").and_then(Value::as_array) {
        if swatches.len() > limits.swatches_per_document {
            return Err(InkValidationError::LimitExceeded {
                limit: limits.swatches_per_document,
                unit: "swatch",
            });
        }
    }

    let mut seen_pages = std::collections::HashSet::new();
    let mut total_objects = 0usize;
    let mut total_samples = 0usize;

    for entry in page_order {
        let page_id =
            valid_id(Some(entry)).ok_or(InkValidationError::InvalidId { kind: "page" })?;
        if !seen_pages.insert(page_id.to_string()) {
            return Err(InkValidationError::DuplicateId {
                kind: "page",
                id: page_id.to_string(),
            });
        }
        let page = pages
            .get(page_id)
            .ok_or_else(|| InkValidationError::DanglingReference {
                kind: "page",
                id: page_id.to_string(),
            })?;
        let counts = validate_page(page, limits)?;
        total_objects += counts.objects;
        total_samples += counts.samples;
    }

    if total_objects > limits.objects_per_document {
        return Err(InkValidationError::LimitExceeded {
            limit: limits.objects_per_document,
            unit: "object",
        });
    }
    if total_samples > limits.samples_per_document {
        return Err(InkValidationError::LimitExceeded {
            limit: limits.samples_per_document,
            unit: "sample",
        });
    }

    Ok(())
}

struct PageCounts {
    objects: usize,
    samples: usize,
}

fn validate_page(page: &Value, limits: InkLimits) -> Result<PageCounts, InkValidationError> {
    let object = page
        .as_object()
        .ok_or(InkValidationError::WrongType { field: "page" })?;

    for field in ["width", "height"] {
        let value = object
            .get(field)
            .and_then(Value::as_f64)
            .ok_or(InkValidationError::WrongType { field: "page size" })?;
        if !drawable(value) || value <= 0.0 {
            return Err(InkValidationError::WrongType { field: "page size" });
        }
    }

    let scene = object
        .get("scene")
        .and_then(Value::as_object)
        .ok_or(InkValidationError::WrongType { field: "scene" })?;

    let layers = scene
        .get("layers")
        .and_then(Value::as_object)
        .ok_or(InkValidationError::WrongType { field: "layers" })?;
    let layer_order =
        scene
            .get("layerOrder")
            .and_then(Value::as_array)
            .ok_or(InkValidationError::WrongType {
                field: "layerOrder",
            })?;

    if layer_order.len() > limits.layers_per_page {
        return Err(InkValidationError::LimitExceeded {
            limit: limits.layers_per_page,
            unit: "layer",
        });
    }

    let mut seen_layers = std::collections::HashSet::new();
    for entry in layer_order {
        let id = valid_id(Some(entry)).ok_or(InkValidationError::InvalidId { kind: "layer" })?;
        if !seen_layers.insert(id.to_string()) {
            return Err(InkValidationError::DuplicateId {
                kind: "layer",
                id: id.to_string(),
            });
        }
        if !layers.contains_key(id) {
            return Err(InkValidationError::DanglingReference {
                kind: "layer",
                id: id.to_string(),
            });
        }
    }

    let objects = scene
        .get("objects")
        .and_then(Value::as_object)
        .ok_or(InkValidationError::WrongType { field: "objects" })?;
    let object_order = scene.get("objectOrder").and_then(Value::as_array).ok_or(
        InkValidationError::WrongType {
            field: "objectOrder",
        },
    )?;

    if object_order.len() > limits.objects_per_page {
        return Err(InkValidationError::LimitExceeded {
            limit: limits.objects_per_page,
            unit: "object",
        });
    }

    let mut seen_objects = std::collections::HashSet::new();
    let mut samples = 0usize;

    for entry in object_order {
        let id = valid_id(Some(entry)).ok_or(InkValidationError::InvalidId { kind: "object" })?;
        if !seen_objects.insert(id.to_string()) {
            return Err(InkValidationError::DuplicateId {
                kind: "object",
                id: id.to_string(),
            });
        }
        let object = objects
            .get(id)
            .ok_or_else(|| InkValidationError::DanglingReference {
                kind: "object",
                id: id.to_string(),
            })?;
        samples += validate_object(id, object, &seen_layers, limits)?;
    }

    Ok(PageCounts {
        objects: object_order.len(),
        samples,
    })
}

/// Validates one object and returns its sample count.
fn validate_object(
    id: &str,
    object: &Value,
    layers: &std::collections::HashSet<String>,
    limits: InkLimits,
) -> Result<usize, InkValidationError> {
    let map = object
        .as_object()
        .ok_or(InkValidationError::WrongType { field: "object" })?;

    let layer_id = map
        .get("layerId")
        .and_then(Value::as_str)
        .ok_or(InkValidationError::WrongType { field: "layerId" })?;
    if !layers.contains(layer_id) {
        return Err(InkValidationError::DanglingReference {
            kind: "layer",
            id: layer_id.to_string(),
        });
    }

    if let Some(link) = map.get("link") {
        validate_object_link(link)?;
    }

    match map.get("type").and_then(Value::as_str) {
        Some("stroke") => validate_stroke(id, map, limits),
        Some("text") => {
            let text = map.get("text").and_then(Value::as_str).unwrap_or_default();
            if text.chars().count() > limits.text_length {
                return Err(InkValidationError::LimitExceeded {
                    limit: limits.text_length,
                    unit: "character",
                });
            }
            validate_point(id, map)?;
            Ok(0)
        }
        Some("image") => {
            let path = map
                .get("relativePath")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !is_vault_relative_path(path) {
                return Err(InkValidationError::UnsafeAssetPath { id: id.to_string() });
            }
            validate_point(id, map)?;
            Ok(0)
        }
        Some("group") => {
            let children = map
                .get("childIds")
                .and_then(Value::as_array)
                .ok_or(InkValidationError::WrongType { field: "childIds" })?;
            if children.len() > limits.objects_per_page {
                return Err(InkValidationError::LimitExceeded {
                    limit: limits.objects_per_page,
                    unit: "object",
                });
            }
            Ok(0)
        }
        Some("shape") => {
            let points = map
                .get("points")
                .and_then(Value::as_array)
                .ok_or(InkValidationError::WrongType { field: "points" })?;
            if points.len() < 4 || points.len() % 2 != 0 {
                return Err(InkValidationError::UndrawableGeometry { id: id.to_string() });
            }
            if points
                .iter()
                .any(|entry| entry.as_f64().is_none_or(|value| !drawable(value)))
            {
                return Err(InkValidationError::UndrawableGeometry { id: id.to_string() });
            }
            Ok(0)
        }
        Some("connector") => {
            validate_nested_point(id, map.get("from"))?;
            validate_nested_point(id, map.get("to"))?;
            Ok(0)
        }
        Some("stamp") => {
            validate_point(id, map)?;
            Ok(0)
        }
        _ => Err(InkValidationError::WrongType { field: "type" }),
    }
}

fn validate_object_link(value: &Value) -> Result<(), InkValidationError> {
    let map = value
        .as_object()
        .ok_or(InkValidationError::WrongType { field: "link" })?;
    let kind = map.get("kind").and_then(Value::as_str);
    let target = map
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let valid = match kind {
        Some("vault") => is_vault_relative_path(target),
        Some("url") => target.starts_with("https://") && target.len() <= 2048,
        _ => false,
    };
    if valid {
        Ok(())
    } else {
        Err(InkValidationError::WrongType { field: "link" })
    }
}

fn validate_nested_point(id: &str, value: Option<&Value>) -> Result<(), InkValidationError> {
    let map = value
        .and_then(Value::as_object)
        .ok_or_else(|| InkValidationError::UndrawableGeometry { id: id.to_string() })?;
    validate_point(id, map)
}

fn validate_point(
    id: &str,
    map: &serde_json::Map<String, Value>,
) -> Result<(), InkValidationError> {
    for field in ["x", "y"] {
        let value = map
            .get(field)
            .and_then(Value::as_f64)
            .ok_or_else(|| InkValidationError::UndrawableGeometry { id: id.to_string() })?;
        if !drawable(value) {
            return Err(InkValidationError::UndrawableGeometry { id: id.to_string() });
        }
    }
    Ok(())
}

/// Validates a stroke's delta-encoded sample channels.
///
/// The deltas are accumulated so a stroke whose individual steps look
/// reasonable but whose reconstructed position leaves the world is still
/// rejected — validating the deltas alone would let a document place ink at an
/// arbitrary coordinate.
fn validate_stroke(
    id: &str,
    map: &serde_json::Map<String, Value>,
    limits: InkLimits,
) -> Result<usize, InkValidationError> {
    let samples = map
        .get("samples")
        .and_then(Value::as_object)
        .ok_or_else(|| InkValidationError::MalformedSamples { id: id.to_string() })?;

    let xs = samples
        .get("x")
        .and_then(Value::as_array)
        .ok_or_else(|| InkValidationError::MalformedSamples { id: id.to_string() })?;
    let ys = samples
        .get("y")
        .and_then(Value::as_array)
        .ok_or_else(|| InkValidationError::MalformedSamples { id: id.to_string() })?;

    if xs.len() != ys.len() {
        return Err(InkValidationError::MalformedSamples { id: id.to_string() });
    }
    if xs.is_empty() {
        return Err(InkValidationError::MalformedSamples { id: id.to_string() });
    }
    if xs.len() > limits.samples_per_stroke {
        return Err(InkValidationError::LimitExceeded {
            limit: limits.samples_per_stroke,
            unit: "sample",
        });
    }

    let mut x = 0.0f64;
    let mut y = 0.0f64;
    for index in 0..xs.len() {
        let dx = xs[index]
            .as_f64()
            .ok_or_else(|| InkValidationError::MalformedSamples { id: id.to_string() })?;
        let dy = ys[index]
            .as_f64()
            .ok_or_else(|| InkValidationError::MalformedSamples { id: id.to_string() })?;
        x += dx;
        y += dy;
        if !drawable(x) || !drawable(y) {
            return Err(InkValidationError::UndrawableGeometry { id: id.to_string() });
        }
    }

    // Optional channels must be numeric and at least as long as x/y; a shorter
    // one is corruption, and half-applying it renders a plausible wrong stroke.
    for key in ["p", "tx", "ty", "tw", "t"] {
        let Some(channel) = samples.get(key) else {
            continue;
        };
        let array = channel
            .as_array()
            .ok_or_else(|| InkValidationError::MalformedSamples { id: id.to_string() })?;
        if array.len() < xs.len() {
            return Err(InkValidationError::MalformedSamples { id: id.to_string() });
        }
        if array.iter().any(|entry| entry.as_f64().is_none()) {
            return Err(InkValidationError::MalformedSamples { id: id.to_string() });
        }
    }

    Ok(xs.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn document(objects: Value, object_order: Value) -> Value {
        json!({
            "kind": INK_DOCUMENT_KIND,
            "schemaVersion": 1,
            "id": "doc",
            "name": "Drawing",
            "pages": {
                "page-1": {
                    "id": "page-1",
                    "mode": "fixed",
                    "width": 38098,
                    "height": 53881,
                    "background": { "pattern": "blank" },
                    "scene": {
                        "layers": { "layer-1": { "id": "layer-1", "name": "L", "visible": true, "locked": false, "opacity": 1 } },
                        "layerOrder": ["layer-1"],
                        "objects": objects,
                        "objectOrder": object_order,
                    }
                }
            },
            "pageOrder": ["page-1"],
        })
    }

    fn stroke(x: Value, y: Value) -> Value {
        json!({
            "id": "s1",
            "type": "stroke",
            "layerId": "layer-1",
            "brush": { "kind": "ballpoint", "color": "#000", "opacity": 1, "width": 96,
                       "thinning": 0.5, "smoothing": 0.5, "streamline": 0.4,
                       "taperStart": 0, "taperEnd": 0 },
            "samples": { "x": x, "y": y }
        })
    }

    #[test]
    fn validates_phase_five_shape_and_connector_geometry() {
        let valid = document(
            json!({
                "shape": {
                    "id": "shape", "type": "shape", "layerId": "layer-1",
                    "points": [0, 0, 100, 100]
                },
                "connector": {
                    "id": "connector", "type": "connector", "layerId": "layer-1",
                    "from": { "x": 0, "y": 0 }, "to": { "x": 100, "y": 100 }
                }
            }),
            json!(["shape", "connector"]),
        );
        assert_eq!(validate_document(&valid, DEFAULT_INK_LIMITS), Ok(()));

        let malformed = document(
            json!({
                "shape": {
                    "id": "shape", "type": "shape", "layerId": "layer-1",
                    "points": [0, 0, "outside", 100]
                }
            }),
            json!(["shape"]),
        );
        assert!(matches!(
            validate_document(&malformed, DEFAULT_INK_LIMITS),
            Err(InkValidationError::UndrawableGeometry { .. })
        ));
    }

    #[test]
    fn validates_phase_five_object_links() {
        let mut value = valid();
        value["pages"]["page-1"]["scene"]["objects"]["s1"]["link"] =
            json!({ "kind": "url", "target": "https://example.test/path" });
        assert!(validate_document(&value, DEFAULT_INK_LIMITS).is_ok());

        value["pages"]["page-1"]["scene"]["objects"]["s1"]["link"] =
            json!({ "kind": "url", "target": "javascript:alert(1)" });
        assert!(matches!(
            validate_document(&value, DEFAULT_INK_LIMITS),
            Err(InkValidationError::WrongType { field: "link" })
        ));
    }

    fn valid() -> Value {
        document(
            json!({ "s1": stroke(json!([100, 10, 10]), json!([200, 5, 5])) }),
            json!(["s1"]),
        )
    }

    #[test]
    fn accepts_a_well_formed_document() {
        assert!(validate_document(&valid(), DEFAULT_INK_LIMITS).is_ok());
    }

    #[test]
    fn rejects_a_wrong_kind() {
        let mut value = valid();
        value["kind"] = json!("collab-sheet");
        assert_eq!(
            validate_document(&value, DEFAULT_INK_LIMITS),
            Err(InkValidationError::WrongKind {
                expected: INK_DOCUMENT_KIND
            })
        );
    }

    #[test]
    fn rejects_a_missing_or_zero_schema_version() {
        let mut value = valid();
        value.as_object_mut().unwrap().remove("schemaVersion");
        assert_eq!(
            validate_document(&value, DEFAULT_INK_LIMITS),
            Err(InkValidationError::InvalidSchemaVersion)
        );

        let mut zero = valid();
        zero["schemaVersion"] = json!(0);
        assert_eq!(
            validate_document(&zero, DEFAULT_INK_LIMITS),
            Err(InkValidationError::InvalidSchemaVersion)
        );
    }

    #[test]
    fn passes_a_newer_document_through_untouched() {
        // A newer client may legitimately store shapes this build cannot parse.
        // Rejecting them would corrupt a vault shared between versions.
        let mut value = valid();
        value["schemaVersion"] = json!(99);
        value["pages"]["page-1"]["scene"]["objects"]["s1"]["samples"] = json!("something new");
        assert!(validate_document(&value, DEFAULT_INK_LIMITS).is_ok());
    }

    #[test]
    fn rejects_a_stroke_whose_deltas_leave_the_world() {
        // Each step is individually plausible; only the accumulated position is
        // out of bounds. Validating deltas alone would let this through.
        let value = document(
            json!({ "s1": stroke(json!([WORLD_EXTENT, WORLD_EXTENT]), json!([0, 0])) }),
            json!(["s1"]),
        );
        assert_eq!(
            validate_document(&value, DEFAULT_INK_LIMITS),
            Err(InkValidationError::UndrawableGeometry {
                id: "s1".to_string()
            })
        );
    }

    #[test]
    fn rejects_non_numeric_and_mismatched_sample_channels() {
        for (x, y) in [
            (json!(["a", 1]), json!([0, 1])),
            (json!([0, 1, 2]), json!([0, 1])),
            (json!([]), json!([])),
        ] {
            let value = document(json!({ "s1": stroke(x, y) }), json!(["s1"]));
            assert!(matches!(
                validate_document(&value, DEFAULT_INK_LIMITS),
                Err(InkValidationError::MalformedSamples { .. })
            ));
        }
    }

    #[test]
    fn rejects_a_truncated_optional_channel() {
        let mut value = valid();
        value["pages"]["page-1"]["scene"]["objects"]["s1"]["samples"]["p"] = json!([100]);
        assert!(matches!(
            validate_document(&value, DEFAULT_INK_LIMITS),
            Err(InkValidationError::MalformedSamples { .. })
        ));
    }

    #[test]
    fn rejects_a_stroke_over_the_sample_limit() {
        let deltas: Vec<Value> = (0..DEFAULT_INK_LIMITS.samples_per_stroke + 1)
            .map(|_| json!(1))
            .collect();
        let value = document(
            json!({ "s1": stroke(json!(deltas), json!(deltas)) }),
            json!(["s1"]),
        );
        assert_eq!(
            validate_document(&value, DEFAULT_INK_LIMITS),
            Err(InkValidationError::LimitExceeded {
                limit: DEFAULT_INK_LIMITS.samples_per_stroke,
                unit: "sample",
            })
        );
    }

    #[test]
    fn rejects_an_object_on_a_layer_that_does_not_exist() {
        let mut value = valid();
        value["pages"]["page-1"]["scene"]["objects"]["s1"]["layerId"] = json!("ghost");
        assert_eq!(
            validate_document(&value, DEFAULT_INK_LIMITS),
            Err(InkValidationError::DanglingReference {
                kind: "layer",
                id: "ghost".to_string(),
            })
        );
    }

    #[test]
    fn rejects_an_order_entry_with_no_object() {
        let value = document(json!({}), json!(["s1"]));
        assert_eq!(
            validate_document(&value, DEFAULT_INK_LIMITS),
            Err(InkValidationError::DanglingReference {
                kind: "object",
                id: "s1".to_string(),
            })
        );
    }

    #[test]
    fn rejects_duplicate_identifiers() {
        let value = document(
            json!({ "s1": stroke(json!([0]), json!([0])) }),
            json!(["s1", "s1"]),
        );
        assert_eq!(
            validate_document(&value, DEFAULT_INK_LIMITS),
            Err(InkValidationError::DuplicateId {
                kind: "object",
                id: "s1".to_string(),
            })
        );
    }

    #[test]
    fn rejects_an_image_that_reaches_outside_the_vault() {
        for path in [
            "/etc/passwd",
            "../../secret.png",
            "https://example.com/x.png",
            "file:///tmp/x.png",
            "",
        ] {
            let value = document(
                json!({ "i1": {
                    "id": "i1", "type": "image", "layerId": "layer-1",
                    "x": 0, "y": 0, "width": 10, "height": 10,
                    "relativePath": path
                }}),
                json!(["i1"]),
            );
            assert_eq!(
                validate_document(&value, DEFAULT_INK_LIMITS),
                Err(InkValidationError::UnsafeAssetPath {
                    id: "i1".to_string()
                }),
                "should reject {path}"
            );
        }
    }

    #[test]
    fn accepts_an_ordinary_vault_relative_image_path() {
        let value = document(
            json!({ "i1": {
                "id": "i1", "type": "image", "layerId": "layer-1",
                "x": 0, "y": 0, "width": 10, "height": 10,
                "relativePath": "Pictures/diagram.png"
            }}),
            json!(["i1"]),
        );
        assert!(validate_document(&value, DEFAULT_INK_LIMITS).is_ok());
    }

    #[test]
    fn rejects_non_finite_object_geometry() {
        let mut value = valid();
        value["pages"]["page-1"]["scene"]["objects"]["t1"] = json!({
            "id": "t1", "type": "text", "layerId": "layer-1",
            "x": 0, "y": 0, "width": 10, "height": 10, "text": "hi",
            "color": "#000", "fontSize": 12
        });
        value["pages"]["page-1"]["scene"]["objectOrder"] = json!(["s1", "t1"]);
        assert!(validate_document(&value, DEFAULT_INK_LIMITS).is_ok());

        // JSON has no NaN literal, so an out-of-world coordinate stands in for
        // the same class of undrawable geometry.
        value["pages"]["page-1"]["scene"]["objects"]["t1"]["x"] = json!(WORLD_EXTENT * 2.0);
        assert_eq!(
            validate_document(&value, DEFAULT_INK_LIMITS),
            Err(InkValidationError::UndrawableGeometry {
                id: "t1".to_string()
            })
        );
    }

    #[test]
    fn rejects_a_page_with_an_impossible_size() {
        let mut value = valid();
        value["pages"]["page-1"]["width"] = json!(0);
        assert_eq!(
            validate_document(&value, DEFAULT_INK_LIMITS),
            Err(InkValidationError::WrongType { field: "page size" })
        );
    }

    #[test]
    fn enforces_the_page_limit() {
        let mut value = valid();
        let order: Vec<Value> = (0..DEFAULT_INK_LIMITS.pages_per_document + 1)
            .map(|index| json!(format!("page-{index}")))
            .collect();
        value["pageOrder"] = json!(order);
        assert_eq!(
            validate_document(&value, DEFAULT_INK_LIMITS),
            Err(InkValidationError::LimitExceeded {
                limit: DEFAULT_INK_LIMITS.pages_per_document,
                unit: "page",
            })
        );
    }

    #[test]
    fn vault_relative_paths_accept_ordinary_names() {
        assert!(is_vault_relative_path("Pictures/a.png"));
        assert!(is_vault_relative_path("a b/c-d_e.svg"));
        // A colon that is not a scheme, such as a Windows-hostile but legal name.
        assert!(is_vault_relative_path("notes/2026-01-01 10:30.png"));
        assert!(!is_vault_relative_path("C:/Windows/x.png"));
    }
}

#[cfg(test)]
mod reference_tests {
    use crate::references::{collect_ink_references, rewrite_ink_references};
    use serde_json::{json, Value};

    fn drawing(paths: &[&str]) -> String {
        let mut objects = serde_json::Map::new();
        let mut order = Vec::new();
        for (index, path) in paths.iter().enumerate() {
            let id = format!("img-{index}");
            objects.insert(
                id.clone(),
                json!({
                    "id": id,
                    "type": "image",
                    "layerId": "layer-1",
                    "x": 0, "y": 0, "width": 100, "height": 100,
                    "relativePath": path,
                }),
            );
            order.push(Value::String(id));
        }
        // A stroke, to prove reference collection ignores everything that is
        // not an image rather than tripping over it.
        objects.insert(
            "s1".into(),
            json!({
                "id": "s1", "type": "stroke", "layerId": "layer-1",
                "brush": { "kind": "ballpoint", "color": "#000", "opacity": 1, "width": 96,
                           "thinning": 0.5, "smoothing": 0.5, "streamline": 0.4,
                           "taperStart": 0, "taperEnd": 0 },
                "samples": { "x": [0, 1], "y": [0, 1] }
            }),
        );
        order.push(Value::String("s1".into()));

        json!({
            "kind": "collab-ink",
            "schemaVersion": 1,
            "id": "doc", "name": "Drawing",
            "pages": { "page-1": {
                "id": "page-1", "mode": "fixed", "width": 38098, "height": 53881,
                "background": { "pattern": "blank" },
                "scene": {
                    "layers": { "layer-1": { "id": "layer-1", "name": "L", "visible": true, "locked": false, "opacity": 1 } },
                    "layerOrder": ["layer-1"],
                    "objects": objects,
                    "objectOrder": order,
                }
            }},
            "pageOrder": ["page-1"],
        })
        .to_string()
    }

    #[test]
    fn collects_image_references_and_ignores_strokes() {
        let content = drawing(&["Pictures/a.png", "Pictures/b.png"]);
        let found = collect_ink_references(&content, "Sketches/Idea.ink", "Pictures").unwrap();
        assert_eq!(found.len(), 2);
        assert!(found
            .iter()
            .all(|reference| reference.source_document_type == "ink"));
        assert!(found
            .iter()
            .all(|reference| reference.reference_kind == "ink-image"));
    }

    #[test]
    fn ignores_images_outside_the_queried_target() {
        let content = drawing(&["Pictures/a.png", "Elsewhere/b.png"]);
        let found =
            collect_ink_references(&content, "Sketches/Idea.ink", "Pictures/a.png").unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].referenced_relative_path, "Pictures/a.png");
    }

    #[test]
    fn rewrites_a_moved_image_path() {
        let content = drawing(&["Pictures/a.png"]);
        let rewritten =
            rewrite_ink_references(&content, "Pictures/a.png", Some("Media/a.png")).unwrap();
        let value: Value = serde_json::from_str(&rewritten).unwrap();
        assert_eq!(
            value["pages"]["page-1"]["scene"]["objects"]["img-0"]["relativePath"],
            json!("Media/a.png")
        );
    }

    #[test]
    fn rewrites_a_moved_folder_for_every_image_beneath_it() {
        let content = drawing(&["Pictures/a.png", "Pictures/nested/b.png"]);
        let rewritten = rewrite_ink_references(&content, "Pictures", Some("Media")).unwrap();
        let value: Value = serde_json::from_str(&rewritten).unwrap();
        let objects = &value["pages"]["page-1"]["scene"]["objects"];
        assert_eq!(objects["img-0"]["relativePath"], json!("Media/a.png"));
        assert_eq!(
            objects["img-1"]["relativePath"],
            json!("Media/nested/b.png")
        );
    }

    #[test]
    fn removes_a_deleted_image_from_objects_and_from_objectorder_together() {
        // Leaving the id in `objectOrder` with no object behind it is exactly
        // the corruption the normalizer then has to repair.
        let content = drawing(&["Pictures/a.png", "Pictures/b.png"]);
        let rewritten = rewrite_ink_references(&content, "Pictures/a.png", None).unwrap();
        let value: Value = serde_json::from_str(&rewritten).unwrap();
        let scene = &value["pages"]["page-1"]["scene"];

        assert!(scene["objects"].get("img-0").is_none());
        assert!(scene["objects"].get("img-1").is_some());
        let order: Vec<&str> = scene["objectOrder"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry.as_str().unwrap())
            .collect();
        assert!(!order.contains(&"img-0"));
        assert!(order.contains(&"img-1"));
        assert!(order.contains(&"s1"));
    }

    #[test]
    fn leaves_unrelated_images_alone() {
        let content = drawing(&["Elsewhere/b.png"]);
        let rewritten =
            rewrite_ink_references(&content, "Pictures/a.png", Some("Media/a.png")).unwrap();
        let value: Value = serde_json::from_str(&rewritten).unwrap();
        assert_eq!(
            value["pages"]["page-1"]["scene"]["objects"]["img-0"]["relativePath"],
            json!("Elsewhere/b.png")
        );
    }

    #[test]
    fn a_drawing_with_no_images_round_trips_unchanged() {
        let content = drawing(&[]);
        let rewritten = rewrite_ink_references(&content, "Pictures/a.png", None).unwrap();
        let before: Value = serde_json::from_str(&content).unwrap();
        let after: Value = serde_json::from_str(&rewritten).unwrap();
        assert_eq!(before, after);
    }
}
