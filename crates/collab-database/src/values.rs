use std::fmt;

use serde::{Deserialize, Serialize};

use crate::ContractError;

/// Wire values preserve exact SQL numerics and temporal precision without JS Number.
/// Truncation is an explicit read-only value, never an editable full-value surrogate.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DbValue {
    Null,
    Boolean {
        value: bool,
    },
    Integer {
        decimal: String,
    },
    Decimal {
        decimal: String,
        precision: u16,
        scale: u16,
    },
    Float {
        round_trip_decimal: String,
        bits: u8,
    },
    Text {
        value: String,
    },
    Binary {
        base64: String,
    },
    Date {
        iso8601: String,
    },
    Time {
        iso8601: String,
        fractional_digits: u8,
    },
    DateTime {
        iso8601: String,
        fractional_digits: u8,
        offset_minutes: Option<i16>,
    },
    Uuid {
        value: String,
    },
    Opaque {
        engine_type: String,
        display: String,
    },
    Truncated {
        engine_type: String,
        preview: String,
        original_bytes: Option<u64>,
    },
}

impl fmt::Debug for DbValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Query parameters, original row values and result literals are sensitive.
        formatter.write_str("DbValue([redacted])")
    }
}

impl DbValue {
    pub fn validate_parameter(&self) -> Result<(), ContractError> {
        let valid = match self {
            Self::Integer { decimal } => {
                !decimal.starts_with('+')
                    && (decimal.parse::<i128>().is_ok() || decimal.parse::<u128>().is_ok())
            }
            Self::Decimal {
                decimal,
                precision,
                scale,
            } => {
                let digits = decimal.strip_prefix('-').unwrap_or(decimal);
                let mut parts = digits.split('.');
                let integer = parts.next().unwrap_or("");
                let fraction = parts.next().unwrap_or("");
                *precision > 0
                    && *precision <= 1000
                    && scale <= precision
                    && parts.next().is_none()
                    && !integer.is_empty()
                    && integer.bytes().all(|b| b.is_ascii_digit())
                    && fraction.bytes().all(|b| b.is_ascii_digit())
                    && fraction.len() == usize::from(*scale)
                    && integer.trim_start_matches('0').len() + fraction.len()
                        <= usize::from(*precision)
            }
            Self::Float {
                round_trip_decimal,
                bits: 32,
            } => round_trip_decimal.parse::<f32>().is_ok_and(f32::is_finite),
            Self::Float {
                round_trip_decimal,
                bits: 64,
            } => round_trip_decimal.parse::<f64>().is_ok_and(f64::is_finite),
            Self::Float { .. } => false,
            Self::Time {
                fractional_digits, ..
            }
            | Self::DateTime {
                fractional_digits, ..
            } => *fractional_digits <= 9,
            Self::Opaque { .. } | Self::Truncated { .. } => false,
            _ => true,
        };
        if valid {
            Ok(())
        } else {
            Err(ContractError::InvalidParameter)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_numeric_and_null_values_round_trip_without_number_coercion() {
        let values = vec![
            DbValue::Null,
            DbValue::Text {
                value: String::new(),
            },
            DbValue::Integer {
                decimal: "18446744073709551615".into(),
            },
            DbValue::Decimal {
                decimal: "123456789012345678901234567890.12345678".into(),
                precision: 38,
                scale: 8,
            },
            DbValue::DateTime {
                iso8601: "2026-11-10T12:34:56.1234567".into(),
                fractional_digits: 7,
                offset_minutes: Some(330),
            },
        ];
        for value in &values {
            value.validate_parameter().unwrap();
        }
        let json = serde_json::to_string(&values).unwrap();
        assert!(json.contains("\"18446744073709551615\""));
        assert_eq!(values, serde_json::from_str::<Vec<DbValue>>(&json).unwrap());
        assert_ne!(values[0], values[1]);
        assert!(!format!("{:?}", values).contains("123456789"));
    }

    #[test]
    fn a_truncated_result_can_never_be_sent_as_a_full_parameter() {
        assert_eq!(
            DbValue::Truncated {
                engine_type: "nvarchar(max)".into(),
                preview: "secret".into(),
                original_bytes: None
            }
            .validate_parameter(),
            Err(ContractError::InvalidParameter)
        );
        assert!(DbValue::Integer {
            decimal: "1; DROP TABLE t".into()
        }
        .validate_parameter()
        .is_err());
        assert!(DbValue::Decimal {
            decimal: "12.345".into(),
            precision: 4,
            scale: 3
        }
        .validate_parameter()
        .is_err());
    }
}
