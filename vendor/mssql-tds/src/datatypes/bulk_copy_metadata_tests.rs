// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! Additional unit tests for bulk copy metadata module
//! These tests focus on builder pattern and SQL type definitions.

#[cfg(test)]
mod tests {
    use crate::datatypes::bulk_copy_metadata::{
        BulkCopyColumnMetadata, EncodingType, SqlDbType, TypeLength,
    };
    use crate::token::tokens::SqlCollation;

    #[test]
    fn test_builder_pattern_with_nullable() {
        let meta = BulkCopyColumnMetadata::new("test", SqlDbType::Int, 0x26)
            .with_nullable(true)
            .with_length(4, TypeLength::Fixed(4));

        assert!(meta.is_nullable);
        assert_eq!(meta.length, 4);
    }

    #[test]
    fn test_builder_pattern_with_identity() {
        let meta = BulkCopyColumnMetadata::new("id", SqlDbType::Int, 0x26)
            .with_nullable(false)
            .with_identity(true)
            .with_length(4, TypeLength::Fixed(4));

        assert!(meta.is_identity);
        assert!(!meta.is_nullable);
    }

    #[test]
    fn test_builder_pattern_with_encoding() {
        let meta = BulkCopyColumnMetadata::new("text", SqlDbType::VarChar, 0xA7)
            .with_encoding(EncodingType::Utf8)
            .with_length(100, TypeLength::Variable(100))
            .with_collation(SqlCollation::default());

        assert_eq!(meta.encoding, Some(EncodingType::Utf8));
    }

    #[test]
    fn test_builder_pattern_with_all_options() {
        let collation = SqlCollation::default();
        let meta = BulkCopyColumnMetadata::new("fulltest", SqlDbType::NVarChar, 0xE7)
            .with_nullable(true)
            .with_identity(false)
            .with_length(255, TypeLength::Variable(255))
            .with_encoding(EncodingType::Utf16Le)
            .with_collation(collation);

        assert!(meta.is_nullable);
        assert!(!meta.is_identity);
        assert_eq!(meta.length, 255);
        assert_eq!(meta.encoding, Some(EncodingType::Utf16Le));
        assert!(meta.collation.is_some());
    }

    #[test]
    fn test_type_length_classification() {
        let meta_fixed = BulkCopyColumnMetadata::new("int", SqlDbType::Int, 0x26)
            .with_length(4, TypeLength::Fixed(4));
        assert!(meta_fixed.length_type.is_fixed());

        let meta_variable = BulkCopyColumnMetadata::new("varchar", SqlDbType::VarChar, 0xA7)
            .with_length(50, TypeLength::Variable(50));
        assert_eq!(meta_variable.length, 50);

        let meta_plp = BulkCopyColumnMetadata::new("nvarcharmax", SqlDbType::NVarChar, 0xE7)
            .with_length(-1, TypeLength::Plp);
        assert!(meta_plp.is_plp());
    }

    #[test]
    fn test_type_length_variants() {
        // Test that all TypeLength variants can be created
        let _fixed = TypeLength::Fixed(4);
        let _variable = TypeLength::Variable(100);
        let _plp = TypeLength::Plp;
        let _unknown = TypeLength::Unknown;

        // Test is_plp method
        assert!(!TypeLength::Fixed(4).is_plp());
        assert!(!TypeLength::Variable(100).is_plp());
        assert!(TypeLength::Plp.is_plp());
        assert!(!TypeLength::Unknown.is_plp());

        // Test is_fixed method
        assert!(TypeLength::Fixed(4).is_fixed());
        assert!(!TypeLength::Variable(100).is_fixed());
        assert!(!TypeLength::Plp.is_fixed());
        assert!(!TypeLength::Unknown.is_fixed());
    }

    #[test]
    fn test_decimal_precision_scale_boundaries() {
        // Test minimum precision/scale
        let meta_min =
            BulkCopyColumnMetadata::new("dec", SqlDbType::Decimal, 0x6A).with_precision_scale(1, 0);
        assert_eq!(meta_min.precision, 1);
        assert_eq!(meta_min.scale, 0);

        // Test maximum precision/scale
        let meta_max = BulkCopyColumnMetadata::new("dec", SqlDbType::Decimal, 0x6A)
            .with_precision_scale(38, 38);
        assert_eq!(meta_max.precision, 38);
        assert_eq!(meta_max.scale, 38);

        // Test common precision/scale
        let meta_common = BulkCopyColumnMetadata::new("dec", SqlDbType::Decimal, 0x6A)
            .with_precision_scale(18, 2);
        assert_eq!(meta_common.precision, 18);
        assert_eq!(meta_common.scale, 2);
    }

    #[test]
    fn test_datetime_scale_values() {
        // Test different scale values for datetime types
        for scale in 0..=7 {
            let meta = BulkCopyColumnMetadata::new("time", SqlDbType::Time, 0x29).with_scale(scale);
            assert_eq!(meta.scale, scale);

            let meta2 =
                BulkCopyColumnMetadata::new("dt2", SqlDbType::DateTime2, 0x2A).with_scale(scale);
            assert_eq!(meta2.scale, scale);

            let meta3 = BulkCopyColumnMetadata::new("dto", SqlDbType::DateTimeOffset, 0x2B)
                .with_scale(scale);
            assert_eq!(meta3.scale, scale);
        }
    }

    #[test]
    fn test_sql_db_type_equality() {
        assert_eq!(SqlDbType::Int, SqlDbType::Int);
        assert_ne!(SqlDbType::Int, SqlDbType::BigInt);
        assert_ne!(SqlDbType::VarChar, SqlDbType::NVarChar);
    }

    #[test]
    fn test_encoding_type_equality() {
        assert_eq!(EncodingType::Utf16Le, EncodingType::Utf16Le);
        assert_ne!(EncodingType::Utf16Le, EncodingType::Utf8);
    }

    #[test]
    fn test_type_length_equality() {
        assert_eq!(TypeLength::Plp, TypeLength::Plp);
        assert_eq!(TypeLength::Fixed(4), TypeLength::Fixed(4));
        assert_ne!(TypeLength::Fixed(4), TypeLength::Fixed(8));
        assert_ne!(TypeLength::Variable(100), TypeLength::Plp);
    }

    #[test]
    fn test_type_length_max_length() {
        // Test max_length method
        assert_eq!(TypeLength::Fixed(4).max_length(), Some(4));
        assert_eq!(TypeLength::Variable(100).max_length(), Some(100));
        assert_eq!(TypeLength::Plp.max_length(), None);
        assert_eq!(TypeLength::Unknown.max_length(), None);
    }
}
