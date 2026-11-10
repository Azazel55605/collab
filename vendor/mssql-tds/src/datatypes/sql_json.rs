// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

use core::fmt;
use std::fmt::Debug;

/// SQL Server `json` column value stored as UTF-8 bytes.
#[derive(PartialEq, Clone)]
pub struct SqlJson {
    /// UTF-8 encoded bytes representing a JSON string.
    pub bytes: Vec<u8>,
}

impl SqlJson {
    /// Converts the underlying UTF-8 bytes to a Rust `String`.
    pub fn as_string(&self) -> String {
        String::from_utf8(self.bytes.clone()).unwrap()
    }

    /// Creates a `SqlJson` from raw UTF-8 bytes.
    pub fn new(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }
}

impl Debug for SqlJson {
    fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
        write!(f, "Json: {}", self.as_string())
    }
}

impl From<String> for SqlJson {
    fn from(value: String) -> Self {
        Self::new(value.into_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_sql_json_new() {
        let json_bytes = br#"{"key": "value"}"#.to_vec();
        let json = SqlJson::new(json_bytes.clone());
        assert_eq!(json.bytes, json_bytes);
    }

    #[test]
    fn test_sql_json_as_string() {
        let json_str = r#"{"name": "test", "value": 123}"#;
        let json = SqlJson::new(json_str.as_bytes().to_vec());
        assert_eq!(json.as_string(), json_str);
    }

    #[test]
    fn test_sql_json_from_string() {
        let json_str = r#"{"array": [1, 2, 3]}"#.to_string();
        let json = SqlJson::from(json_str.clone());
        assert_eq!(json.as_string(), json_str);
    }

    #[test]
    fn test_sql_json_debug_format() {
        let json_str = r#"{"test": true}"#;
        let json = SqlJson::new(json_str.as_bytes().to_vec());
        let debug_output = format!("{json:?}");
        assert!(debug_output.contains("Json:"));
        assert!(debug_output.contains(json_str));
    }

    #[test]
    fn test_sql_json_equality() {
        let json1 = SqlJson::new(br#"{"a": 1}"#.to_vec());
        let json2 = SqlJson::new(br#"{"a": 1}"#.to_vec());
        let json3 = SqlJson::new(br#"{"b": 2}"#.to_vec());

        assert_eq!(json1, json2);
        assert_ne!(json1, json3);
    }

    #[test]
    fn test_sql_json_clone() {
        let json = SqlJson::new(br#"{"cloned": "data"}"#.to_vec());
        let cloned = json.clone();
        assert_eq!(json, cloned);
        assert_eq!(json.as_string(), cloned.as_string());
    }

    #[test]
    fn test_sql_json_empty() {
        let json = SqlJson::new(Vec::new());
        assert_eq!(json.as_string(), "");
        assert_eq!(json.bytes.len(), 0);
    }

    #[test]
    fn test_sql_json_complex() {
        let complex_json =
            r#"{"nested": {"array": [{"id": 1}, {"id": 2}]}, "null": null, "bool": true}"#;
        let json = SqlJson::from(complex_json.to_string());
        assert_eq!(json.as_string(), complex_json);
    }
}
