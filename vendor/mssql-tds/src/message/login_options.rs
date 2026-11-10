// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

//! TDS LOGIN7 message options and flag types.

use crate::connection::client_context::ClientContext;

/// TDS protocol version negotiated during login.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum TdsVersion {
    V7_4,
    V8_0,
    Unknown(i32),
}

impl From<i32> for TdsVersion {
    fn from(value: i32) -> Self {
        match value {
            0x74000004 => TdsVersion::V7_4,
            0x08000000 => TdsVersion::V8_0,
            _ => {
                tracing::warn!(
                    "Unknown TDS version value: 0x{:08X}, defaulting to TDS 7.4",
                    value
                );
                TdsVersion::Unknown(value)
            }
        }
    }
}

impl TdsVersion {
    pub(crate) fn as_u32(&self) -> u32 {
        match self {
            TdsVersion::V7_4 => 0x74000004,
            TdsVersion::V8_0 => 0x08000000,
            TdsVersion::Unknown(value) => *value as u32,
        }
    }
}

#[allow(clippy::upper_case_acronyms)]
#[derive(PartialEq)]
pub(crate) enum OptionSqlType {
    Default,
    TSQL,
}

/// Requested application intent (read-write or read-only routing).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ApplicationIntent {
    /// Read-write (default).
    ReadWrite,
    /// Read-only routing.
    ReadOnly,
}

#[derive(PartialEq)]
pub(crate) enum OptionOleDb {
    Off,
    On,
}

/// LOGIN7 type-flags byte (SQL type, OLE DB, access intent).
pub(crate) struct TypeFlags {
    pub(crate) sql_type: OptionSqlType,
    pub(crate) ole_db: OptionOleDb,
    pub(crate) access_intent: ApplicationIntent,
}

impl TypeFlags {
    const OPTION_SQL_TYPE_BIT_INDEX: u8 = 0x08;
    const OPTION_OLE_DB_BIT_INDEX: u8 = 0x10;
    const OPTION_ACCESS_INTENT_BIT_INDEX: u8 = 0x20;

    fn set_sqltype_bit(&self, value: &mut u8) {
        if self.sql_type == OptionSqlType::TSQL {
            *value |= Self::OPTION_SQL_TYPE_BIT_INDEX;
        } else {
            *value &= u8::MAX - Self::OPTION_SQL_TYPE_BIT_INDEX;
        }
    }

    fn set_oledb_bit(&self, value: &mut u8) {
        if self.ole_db == OptionOleDb::On {
            *value |= Self::OPTION_OLE_DB_BIT_INDEX;
        } else {
            *value &= u8::MAX - Self::OPTION_OLE_DB_BIT_INDEX;
        }
    }

    fn set_accessintent_bit(&self, value: &mut u8) {
        if self.access_intent == ApplicationIntent::ReadOnly {
            *value |= Self::OPTION_ACCESS_INTENT_BIT_INDEX;
        } else {
            *value &= u8::MAX - Self::OPTION_ACCESS_INTENT_BIT_INDEX;
        }
    }
}

impl OptionsValue for TypeFlags {
    fn value(&self) -> u8 {
        let mut computed_value: u8 = 0;
        self.set_sqltype_bit(&mut computed_value);
        self.set_oledb_bit(&mut computed_value);
        self.set_accessintent_bit(&mut computed_value);
        computed_value
    }
}

impl From<&ClientContext> for TypeFlags {
    fn from(context: &ClientContext) -> Self {
        TypeFlags {
            sql_type: OptionSqlType::Default,
            ole_db: OptionOleDb::Off,
            access_intent: context.application_intent,
        }
    }
}

#[derive(PartialEq)]
enum OptionEndian {
    LittleEndian,
    #[allow(dead_code)]
    BigEndian,
}

#[derive(PartialEq)]
enum OptionCharset {
    Ascii,
    #[allow(dead_code)]
    Ebcdic,
}

#[allow(clippy::upper_case_acronyms)]
#[derive(PartialEq)]
enum OptionFloat {
    IEEE,
    #[allow(dead_code)]
    VAX,
    #[allow(dead_code)]
    ND5000,
}

#[derive(PartialEq)]
enum OptionBcpDumpload {
    On,
    #[allow(dead_code)]
    Off,
}

#[derive(PartialEq)]
enum OptionUseDb {
    #[allow(dead_code)]
    Off,
    On,
}

#[derive(PartialEq)]
enum OptionInitDb {
    #[allow(dead_code)]
    Warn,
    Fatal,
}

#[derive(PartialEq)]
enum OptionLangWarn {
    #[allow(dead_code)]
    Off,
    On,
}

pub(crate) trait OptionsValue {
    fn value(&self) -> u8;
}

/// LOGIN7 option-flags-1 byte.
pub(crate) struct OptionFlags1 {
    endian: OptionEndian,
    charset: OptionCharset,
    float: OptionFloat,
    bcp_dumpload: OptionBcpDumpload,
    use_db: OptionUseDb,
    init_db: OptionInitDb,
    lang_warn: OptionLangWarn,
}

impl OptionFlags1 {
    const OPTION_ENDIAN_BIT_INDEX: u8 = 0x01;
    const OPTION_CHARSET_BIT_INDEX: u8 = 0x02;
    const OPTION_FLOAT_BIT_INDEX_VAX: u8 = 0x04;
    const OPTION_FLOAT_BIT_INDEX_ND5000: u8 = 0x08;
    const OPTION_BCP_DUMPLOAD_BIT_INDEX: u8 = 0x10;
    const OPTION_USE_DB_BIT_INDEX: u8 = 0x20;
    const OPTION_INIT_DB_INDEX_BIT: u8 = 0x40;
    const OPTION_LANG_WARN_BIT_INDEX: u8 = 0x80;

    pub(crate) fn default() -> OptionFlags1 {
        OptionFlags1 {
            endian: OptionEndian::LittleEndian,
            charset: OptionCharset::Ascii,
            float: OptionFloat::IEEE,
            bcp_dumpload: OptionBcpDumpload::On,
            use_db: OptionUseDb::On,
            init_db: OptionInitDb::Fatal,
            lang_warn: OptionLangWarn::On,
        }
    }

    fn set_endian_bit(&self, value: &mut u8) {
        set_options_bit(
            value,
            self.endian != OptionEndian::LittleEndian,
            Self::OPTION_ENDIAN_BIT_INDEX,
        );
    }

    fn set_charset_bit(&self, value: &mut u8) {
        set_options_bit(
            value,
            self.charset != OptionCharset::Ascii,
            Self::OPTION_CHARSET_BIT_INDEX,
        );
    }

    fn set_float_bits(&self, value: &mut u8) {
        match self.float {
            OptionFloat::IEEE => {
                *value &= u8::MAX - Self::OPTION_FLOAT_BIT_INDEX_VAX;
                *value &= u8::MAX - Self::OPTION_FLOAT_BIT_INDEX_ND5000;
            }
            OptionFloat::VAX => {
                *value |= Self::OPTION_FLOAT_BIT_INDEX_VAX;
                *value &= u8::MAX - Self::OPTION_FLOAT_BIT_INDEX_ND5000;
            }
            OptionFloat::ND5000 => {
                *value &= u8::MAX - Self::OPTION_FLOAT_BIT_INDEX_VAX;
                *value |= Self::OPTION_FLOAT_BIT_INDEX_ND5000;
            }
        }
    }

    fn set_bcp_dumpload_bit(&self, value: &mut u8) {
        set_options_bit(
            value,
            self.bcp_dumpload != OptionBcpDumpload::On,
            Self::OPTION_BCP_DUMPLOAD_BIT_INDEX,
        );
    }

    fn set_use_db_bit(&self, value: &mut u8) {
        set_options_bit(
            value,
            self.use_db == OptionUseDb::On,
            Self::OPTION_USE_DB_BIT_INDEX,
        );
    }

    fn set_init_db_bit(&self, value: &mut u8) {
        set_options_bit(
            value,
            self.init_db == OptionInitDb::Fatal,
            Self::OPTION_INIT_DB_INDEX_BIT,
        );
    }

    fn set_lang_warn_bit(&self, value: &mut u8) {
        set_options_bit(
            value,
            self.lang_warn == OptionLangWarn::On,
            Self::OPTION_LANG_WARN_BIT_INDEX,
        );
    }
}

impl OptionsValue for OptionFlags1 {
    fn value(&self) -> u8 {
        let mut computed_value: u8 = 0;

        self.set_endian_bit(&mut computed_value);
        self.set_charset_bit(&mut computed_value);
        self.set_float_bits(&mut computed_value);
        self.set_bcp_dumpload_bit(&mut computed_value);
        self.set_use_db_bit(&mut computed_value);
        self.set_init_db_bit(&mut computed_value);
        self.set_lang_warn_bit(&mut computed_value);
        computed_value
    }
}

#[derive(PartialEq)]
pub(crate) enum OptionInitLang {
    #[allow(dead_code)]
    Warn,
    Fatal,
}

#[derive(PartialEq)]
pub(crate) enum OptionOdbc {
    #[allow(dead_code)]
    Off,
    On,
}

#[derive(PartialEq)]
pub(crate) enum OptionUser {
    Normal,
    #[allow(dead_code)]
    Reserved,
    #[allow(dead_code)]
    RemUser,
    ReplicationLogin,
}

impl From<&ClientContext> for OptionUser {
    fn from(context: &ClientContext) -> Self {
        match context.replication {
            true => OptionUser::ReplicationLogin,
            false => OptionUser::Normal,
        }
    }
}

#[derive(PartialEq)]
pub(crate) enum OptionIntegratedSecurity {
    Off,
    On,
}

impl From<&ClientContext> for OptionIntegratedSecurity {
    fn from(context: &ClientContext) -> Self {
        if context.integrated_security() {
            OptionIntegratedSecurity::On
        } else {
            OptionIntegratedSecurity::Off
        }
    }
}

/// LOGIN7 option-flags-2 byte.
pub(crate) struct OptionFlags2 {
    pub(crate) init_lang: OptionInitLang,
    pub(crate) odbc: OptionOdbc,
    pub(crate) user: OptionUser,
    pub(crate) integrated_security: OptionIntegratedSecurity,
}

impl From<&ClientContext> for OptionFlags2 {
    fn from(context: &ClientContext) -> Self {
        OptionFlags2 {
            init_lang: OptionInitLang::Fatal, // change to language needs to succeed for successful login
            odbc: OptionOdbc::On,
            user: context.into(),
            integrated_security: context.into(),
        }
    }
}

impl OptionFlags2 {
    const OPTION_INIT_LANG_BIT_INDEX: u8 = 0x01;
    const OPTION_ODBC_BIT_INDEX: u8 = 0x02;
    const OPTION_USER_BIT_INDEX_SERVER: u8 = 0x10;
    const OPTION_USER_BIT_INDEX_REM_USER: u8 = 0x20;
    const OPTION_USER_BIT_INDEX_SQL_REPL: u8 = 0x40;
    const OPTION_INTEGRATED_SECURITY_BIT_INDEX: u8 = 0x80;

    fn set_init_lang_bit(&self, value: &mut u8) {
        set_options_bit(
            value,
            self.init_lang == OptionInitLang::Fatal,
            Self::OPTION_INIT_LANG_BIT_INDEX,
        );
    }

    fn set_odbc_bit(&self, value: &mut u8) {
        set_options_bit(
            value,
            self.odbc == OptionOdbc::On,
            Self::OPTION_ODBC_BIT_INDEX,
        );
    }

    fn set_user_bit(&self, value: &mut u8) {
        if self.user == OptionUser::Normal {
            *value &= u8::MAX - Self::OPTION_USER_BIT_INDEX_SERVER;
            *value &= u8::MAX - Self::OPTION_USER_BIT_INDEX_REM_USER;
            *value &= u8::MAX - Self::OPTION_USER_BIT_INDEX_SQL_REPL;
        } else if self.user == OptionUser::Reserved {
            *value |= Self::OPTION_USER_BIT_INDEX_SERVER;
            *value &= u8::MAX - Self::OPTION_USER_BIT_INDEX_REM_USER;
            *value &= u8::MAX - Self::OPTION_USER_BIT_INDEX_SQL_REPL;
        } else if self.user == OptionUser::RemUser {
            *value &= u8::MAX - Self::OPTION_USER_BIT_INDEX_SERVER;
            *value |= Self::OPTION_USER_BIT_INDEX_REM_USER;
            *value &= u8::MAX - Self::OPTION_USER_BIT_INDEX_SQL_REPL;
        } else if self.user == OptionUser::ReplicationLogin {
            *value &= u8::MAX - Self::OPTION_USER_BIT_INDEX_SERVER;
            *value &= u8::MAX - Self::OPTION_USER_BIT_INDEX_REM_USER;
            *value |= Self::OPTION_USER_BIT_INDEX_SQL_REPL;
        }
    }

    fn set_integrated_security_bit(&self, value: &mut u8) {
        set_options_bit(
            value,
            self.integrated_security == OptionIntegratedSecurity::On,
            Self::OPTION_INTEGRATED_SECURITY_BIT_INDEX,
        );
    }
}

impl OptionsValue for OptionFlags2 {
    fn value(&self) -> u8 {
        let mut computed_value: u8 = 0;

        self.set_init_lang_bit(&mut computed_value);
        self.set_integrated_security_bit(&mut computed_value);
        self.set_odbc_bit(&mut computed_value);
        self.set_user_bit(&mut computed_value);
        computed_value
    }
}

#[derive(PartialEq)]
pub(crate) enum OptionChangePassword {
    No,
    Yes,
}

impl From<&ClientContext> for OptionChangePassword {
    fn from(context: &ClientContext) -> Self {
        match context.change_password.is_empty() {
            true => OptionChangePassword::No,
            false => OptionChangePassword::Yes,
        }
    }
}

/// LOGIN7 option-flags-3 byte.
pub(crate) struct OptionFlags3 {
    pub(crate) change_password: OptionChangePassword,
    pub(crate) binary_xml: bool,
    pub(crate) spawn_user_instance: bool,
    pub(crate) extension_used: bool,
    pub(crate) unknown_collation_handling: bool,
}

impl From<&ClientContext> for OptionFlags3 {
    fn from(context: &ClientContext) -> Self {
        OptionFlags3 {
            change_password: context.into(),
            binary_xml: false,
            spawn_user_instance: context.user_instance,
            unknown_collation_handling: false,
            extension_used: true,
        }
    }
}

impl OptionFlags3 {
    const OPTION_CHANGE_PASSWORD_BIT_INDEX: u8 = 0x01;
    const OPTION_BINARY_XML_BIT_INDEX: u8 = 0x02;
    const OPTION_SPAWN_USER_INSTANCE_BIT_INDEX: u8 = 0x04;
    const OPTION_UNKNOWN_COLLATION_HANDLING_BIT_INDEX: u8 = 0x08;
    const OPTION_EXTENSION_USED_BIT_INDEX: u8 = 0x10;

    fn set_change_password_bit(&self, value: &mut u8) {
        set_options_bit(
            value,
            self.change_password == OptionChangePassword::Yes,
            Self::OPTION_CHANGE_PASSWORD_BIT_INDEX,
        );
    }

    fn set_binary_xml_bit(&self, value: &mut u8) {
        set_options_bit(value, self.binary_xml, Self::OPTION_BINARY_XML_BIT_INDEX);
    }

    fn set_spawn_user_instance_bit(&self, value: &mut u8) {
        set_options_bit(
            value,
            self.spawn_user_instance,
            Self::OPTION_SPAWN_USER_INSTANCE_BIT_INDEX,
        );
    }

    fn set_extension_used_bit(&self, value: &mut u8) {
        set_options_bit(
            value,
            self.extension_used,
            Self::OPTION_EXTENSION_USED_BIT_INDEX,
        );
    }

    fn set_unknown_collation_handling_bit(&self, value: &mut u8) {
        set_options_bit(
            value,
            self.unknown_collation_handling,
            Self::OPTION_UNKNOWN_COLLATION_HANDLING_BIT_INDEX,
        );
    }
}

impl OptionsValue for OptionFlags3 {
    fn value(&self) -> u8 {
        let mut computed_value: u8 = 0;

        self.set_change_password_bit(&mut computed_value);
        self.set_binary_xml_bit(&mut computed_value);
        self.set_spawn_user_instance_bit(&mut computed_value);
        self.set_extension_used_bit(&mut computed_value);
        self.set_unknown_collation_handling_bit(&mut computed_value);
        computed_value
    }
}

fn set_options_bit(value: &mut u8, condition_or_bit_index: bool, bit_index: u8) {
    if condition_or_bit_index {
        *value |= bit_index;
    } else {
        *value &= u8::MAX - bit_index;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_option_flags1_custom_value() {
        let flags = OptionFlags1 {
            endian: OptionEndian::LittleEndian,
            charset: OptionCharset::Ascii,
            float: OptionFloat::IEEE,
            bcp_dumpload: OptionBcpDumpload::On,
            use_db: OptionUseDb::On,
            init_db: OptionInitDb::Fatal,
            lang_warn: OptionLangWarn::On,
        };
        assert_eq!(flags.value(), 224);
    }

    #[test]
    fn test_option_flags2_default_value() {
        let flags2 = OptionFlags2 {
            init_lang: OptionInitLang::Fatal, // change to language needs to succed for succesful login
            odbc: OptionOdbc::On,
            user: OptionUser::Normal,
            integrated_security: OptionIntegratedSecurity::Off,
        };
        // Assert.Equal(3, flags2.Value);
        assert_eq!(flags2.value(), 3);

        let flags2_1 = OptionFlags2 {
            init_lang: OptionInitLang::Fatal, // change to language needs to succed for succesful login
            odbc: OptionOdbc::On,
            user: OptionUser::ReplicationLogin,
            integrated_security: OptionIntegratedSecurity::Off,
        };
        assert_eq!(flags2_1.value(), 67);
    }

    #[test]
    fn test_option_flags3_default_value() {
        let flags = OptionFlags3 {
            change_password: OptionChangePassword::No,
            binary_xml: false,
            spawn_user_instance: false,
            extension_used: false,
            unknown_collation_handling: false,
        };
        assert_eq!(flags.value(), 0x00);
    }

    #[test]
    fn test_option_flags3_custom_value() {
        let flags = OptionFlags3 {
            change_password: OptionChangePassword::No,
            binary_xml: false,
            spawn_user_instance: false,
            extension_used: true,
            unknown_collation_handling: false,
        };
        assert_eq!(flags.value(), 16);
    }

    #[test]
    fn test_typeflags_custom_value() {
        let type_flags = TypeFlags {
            sql_type: OptionSqlType::Default,
            ole_db: OptionOleDb::Off,
            access_intent: ApplicationIntent::ReadWrite,
        };

        assert_eq!(type_flags.value(), 0);
    }
}
