//! Exercise the extraction API used by the Windows updater against the ZIP
//! advisories. Unix-only permission assertions still run on the Linux CI host.
use std::io::{Cursor, Write};

use zip::{write::SimpleFileOptions, ZipArchive, ZipWriter};

#[cfg(unix)]
#[test]
fn archive_extraction_rejects_external_symlinks_without_changing_target() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let outside = temp.path().join("outside.txt");
    std::fs::write(&outside, "preserve me").unwrap();
    std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o600)).unwrap();
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .add_symlink("link", "../outside.txt", SimpleFileOptions::default())
        .unwrap();
    let bytes = writer.finish().unwrap().into_inner();
    let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
    assert!(archive.extract(temp.path().join("extract")).is_err());
    assert_eq!(std::fs::read_to_string(&outside).unwrap(), "preserve me");
    assert_eq!(
        std::fs::metadata(outside).unwrap().permissions().mode() & 0o7777,
        0o600
    );
}

#[cfg(unix)]
#[test]
fn archive_extraction_strips_privileged_permission_bits() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer
        .start_file("payload", SimpleFileOptions::default())
        .unwrap();
    writer.write_all(b"ordinary file").unwrap();
    let mut bytes = writer.finish().unwrap().into_inner();
    // Set the attacker-controlled central-directory Unix mode directly: safe
    // writer APIs may strip these bits before a malicious ZIP can be produced.
    let header = bytes.windows(4).position(|b| b == b"PK\x01\x02").unwrap();
    bytes[header + 5] = 3; // Unix creator OS.
    bytes[header + 38..header + 42].copy_from_slice(&(0o106755_u32 << 16).to_le_bytes());
    let mut archive = ZipArchive::new(Cursor::new(bytes)).unwrap();
    archive.extract(temp.path().join("extract")).unwrap();
    let extracted = temp.path().join("extract/payload");
    assert_eq!(
        std::fs::read_to_string(&extracted).unwrap(),
        "ordinary file"
    );
    assert_eq!(
        std::fs::metadata(extracted).unwrap().permissions().mode() & 0o6000,
        0
    );
}
