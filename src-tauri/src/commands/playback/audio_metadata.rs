use super::open_regular;
use axum::body::Bytes;
use cap_std::fs::Dir;
use image::{ImageFormat, ImageReader, Limits};
use lofty::{
    config::ParseOptions,
    file::{FileType, TaggedFileExt},
    id3::v2::{Frame, Id3v2Tag, SyncTextContentType, SynchronizedTextFrame, TimestampFormat},
    picture::PictureType,
    probe::Probe,
    tag::{ItemKey, Tag, TagType},
};
use serde::Serialize;
use std::{
    fs::File,
    io::{self, BufReader, Cursor, Read, Seek, SeekFrom},
    path::Path,
};

const TAG_READ_BUDGET: usize = 16 * 1024 * 1024;
const ARTWORK_BYTES: usize = 8 * 1024 * 1024;
const LYRICS_BYTES: usize = 128 * 1024;

#[derive(Default)]
pub(super) struct AudioMetadata {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    pub(super) artwork: Option<Bytes>,
    lyrics: Vec<Lyrics>,
}

#[derive(Clone, Serialize)]
struct Lyrics {
    label: &'static str,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct AudioDetails {
    title: Option<String>,
    artist: Option<String>,
    album: Option<String>,
    artwork_url: Option<String>,
    lyrics: Vec<Lyrics>,
}

impl AudioMetadata {
    pub(super) fn read(vault: &Dir, relative: &Path, file: &mut File, mime: &str) -> Option<Self> {
        let file_type = match mime {
            "audio/mpeg" => FileType::Mpeg,
            "audio/flac" => FileType::Flac,
            "audio/wav" => FileType::Wav,
            _ => return None,
        };
        let mut result = Self::default();
        if let Some(text) = bounded_text(
            read_limited(vault, &relative.with_extension("lrc"), LYRICS_BYTES)
                .and_then(decode_lyrics)
                .as_deref(),
            LYRICS_BYTES,
        ) {
            result.lyrics.push(Lyrics {
                label: "LRC file",
                text,
            });
        }
        if file.seek(SeekFrom::Start(0)).is_ok() {
            let reader = MetadataReader {
                file,
                remaining: TAG_READ_BUDGET,
            };
            if let Ok(tagged) = Probe::new(BufReader::new(reader))
                .set_file_type(file_type)
                .options(ParseOptions::new().read_properties(false))
                .read()
            {
                let tags = tagged.tags();
                let find_text = |key| {
                    tags.iter()
                        .find_map(|tag| bounded_text(tag.get_string(key), 2048))
                };
                result.title = find_text(ItemKey::TrackTitle);
                result.artist = find_text(ItemKey::TrackArtist);
                result.album = find_text(ItemKey::AlbumTitle);
                let mut pictures = tags.iter().flat_map(|tag| tag.pictures());
                if let Some(picture) = pictures
                    .clone()
                    .find(|p| p.pic_type() == PictureType::CoverFront)
                    .or_else(|| pictures.next())
                {
                    result.artwork = thumbnail(picture.data());
                }
                if let Some(text) = tagged.tag(TagType::Id3v2).and_then(synced_id3) {
                    result.lyrics.push(Lyrics {
                        label: "Embedded timed lyrics",
                        text,
                    });
                }
                if let Some(text) = tags.iter().find_map(|tag| {
                    [ItemKey::Lyrics, ItemKey::UnsyncLyrics]
                        .into_iter()
                        .find_map(|key| bounded_text(tag.get_string(key), LYRICS_BYTES))
                }) {
                    result.lyrics.push(Lyrics {
                        label: "Embedded lyrics",
                        text,
                    });
                }
            }
        }
        if result.artwork.is_none() {
            result.artwork = [
                "cover.jpg",
                "cover.jpeg",
                "cover.png",
                "folder.jpg",
                "folder.png",
            ]
            .into_iter()
            .find_map(|name| {
                thumbnail(&read_limited(
                    vault,
                    &relative.with_file_name(name),
                    ARTWORK_BYTES,
                )?)
            });
        }
        Some(result)
    }

    pub(super) fn details(&self, base: &str) -> AudioDetails {
        AudioDetails {
            title: self.title.clone(),
            artist: self.artist.clone(),
            album: self.album.clone(),
            artwork_url: self.artwork.as_ref().map(|_| format!("{base}/artwork")),
            lyrics: self.lyrics.clone(),
        }
    }
}

// Permit seeking past audio blocks, including WAV data, while bounding tag reads.
struct MetadataReader<'a> {
    file: &'a mut File,
    remaining: usize,
}

impl Read for MetadataReader<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 && !buffer.is_empty() {
            return Err(io::Error::other("Audio metadata read limit reached"));
        }
        let available = buffer.len().min(self.remaining);
        let count = self.file.read(&mut buffer[..available])?;
        self.remaining -= count;
        Ok(count)
    }
}

impl Seek for MetadataReader<'_> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        self.file.seek(position)
    }
}

fn read_limited(vault: &Dir, path: &Path, limit: usize) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    open_regular(vault, path)
        .ok()?
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= limit).then_some(bytes)
}

fn decode_lyrics(bytes: Vec<u8>) -> Option<String> {
    if let Some(payload) = bytes
        .strip_prefix(&[0xff, 0xfe])
        .or_else(|| bytes.strip_prefix(&[0xfe, 0xff]))
    {
        let decode = if bytes[0] == 0xff {
            u16::from_le_bytes
        } else {
            u16::from_be_bytes
        };
        let (pairs, extra) = payload.as_chunks::<2>();
        if !extra.is_empty() {
            return None;
        }
        let units: Vec<_> = pairs.iter().copied().map(decode).collect();
        return String::from_utf16(&units).ok();
    }
    String::from_utf8(bytes).ok()
}

fn bounded_text(value: Option<&str>, limit: usize) -> Option<String> {
    let value = value?.trim_start_matches('\u{feff}').trim();
    (!value.is_empty() && value.len() <= limit && !value.contains('\0')).then(|| value.to_owned())
}

fn synced_id3(tag: &Tag) -> Option<String> {
    use std::fmt::Write;

    let id3 = Id3v2Tag::from(tag.clone());
    for frame in &id3 {
        let Frame::Binary(frame) = frame else {
            continue;
        };
        if frame.id().as_str() != "SYLT" || frame.data.len() > LYRICS_BYTES {
            continue;
        }
        let Ok(sync) = SynchronizedTextFrame::parse(&frame.data, frame.flags()) else {
            continue;
        };
        if sync.timestamp_format != TimestampFormat::MS
            || sync.content_type != SyncTextContentType::Lyrics
        {
            continue;
        }
        let mut lyrics = String::new();
        for (time, text) in sync.content {
            for line in text.lines().filter(|line| !line.trim().is_empty()) {
                let _ = writeln!(
                    lyrics,
                    "[{:02}:{:02}.{:03}]{line}",
                    time / 60_000,
                    time / 1000 % 60,
                    time % 1000
                );
            }
            if lyrics.len() > LYRICS_BYTES {
                break;
            }
        }
        if let Some(text) = bounded_text(Some(&lyrics), LYRICS_BYTES) {
            return Some(text);
        }
    }
    None
}

fn thumbnail(bytes: &[u8]) -> Option<Bytes> {
    if bytes.len() > ARTWORK_BYTES {
        return None;
    }
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    if !matches!(
        reader.format(),
        Some(ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP)
    ) {
        return None;
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().ok()?.thumbnail(640, 640);
    let mut encoded = Cursor::new(Vec::new());
    image.write_to(&mut encoded, ImageFormat::Png).ok()?;
    Some(Bytes::from(encoded.into_inner()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cap_std::ambient_authority;
    use lofty::{
        config::WriteOptions,
        id3::v2::{BinaryFrame, FrameId},
        tag::{Accessor, TagExt},
    };

    #[test]
    fn reads_wav_id3_lyrics_and_folder_art_alongside_lrc() {
        let root = tempfile::tempdir().unwrap();
        let mut tag = Id3v2Tag::new();
        tag.set_title("Test track".into());
        // UTF-8, English, millisecond timestamps, lyric content, empty description.
        let mut sync = b"\x03eng\x02\x01\0First line\0".to_vec();
        sync.extend_from_slice(&1750_u32.to_be_bytes());
        tag.insert(Frame::Binary(BinaryFrame::new(
            FrameId::Valid("SYLT".into()),
            sync,
        )));
        let mut id3 = Vec::new();
        tag.dump_to(&mut id3, WriteOptions::default()).unwrap();
        let mut wave = b"RIFF".to_vec();
        wave.extend_from_slice(&(12 + id3.len() as u32 + (id3.len() % 2) as u32).to_le_bytes());
        wave.extend_from_slice(b"WAVEid3 ");
        wave.extend_from_slice(&(id3.len() as u32).to_le_bytes());
        wave.extend_from_slice(&id3);
        if id3.len() % 2 != 0 {
            wave.push(0);
        }
        std::fs::write(root.path().join("track.wav"), wave).unwrap();
        std::fs::write(root.path().join("track.lrc"), b"[00:02.00]Sidecar line").unwrap();
        image::RgbImage::new(3, 2)
            .save(root.path().join("cover.png"))
            .unwrap();
        let vault = Dir::open_ambient_dir(root.path(), ambient_authority()).unwrap();
        let path = Path::new("track.wav");
        let mut file = open_regular(&vault, path).unwrap();
        let metadata = AudioMetadata::read(&vault, path, &mut file, "audio/wav").unwrap();
        assert_eq!(metadata.title.as_deref(), Some("Test track"));
        assert_eq!(metadata.lyrics[0].text, "[00:02.00]Sidecar line");
        assert_eq!(metadata.lyrics[1].text, "[00:01.750]First line");
        assert!(metadata.artwork.unwrap().starts_with(b"\x89PNG\r\n\x1a\n"));
    }
}
