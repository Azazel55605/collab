//! Shared constraints for hosted media playback.
pub const MAX_RANGE_BYTES: u64 = 1024 * 1024;

pub fn mime_for_extension(extension: &str) -> Option<&'static str> {
    match extension {
        "mp4" => Some("video/mp4"),
        "webm" => Some("video/webm"),
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "flac" => Some("audio/flac"),
        _ => None,
    }
}
