//! Inspect local ISO BMFF tracks. Compatibility playback replaces selected
//! track types with "free" without shifting any offsets.
use std::io::{self, Read, Seek, SeekFrom};

struct Atom {
    kind: [u8; 4],
    start: u64,
    data: u64,
    end: u64,
}

const MAX_HEADERS: usize = 16_384;

struct Scanner<'a, R> {
    file: &'a mut R,
    headers_left: usize,
}

impl<R: Read + Seek> Scanner<'_, R> {
    fn atom(&mut self, start: u64, end: u64) -> io::Result<Atom> {
        if self.headers_left == 0 || end - start < 8 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        self.headers_left -= 1;
        self.file.seek(SeekFrom::Start(start))?;
        let mut header = [0; 8];
        self.file.read_exact(&mut header)?;
        let mut data = start + 8;
        let length = match u32::from_be_bytes(header[..4].try_into().unwrap()) {
            0 => end - start,
            1 if end - start >= 16 => {
                let mut extended = [0; 8];
                self.file.read_exact(&mut extended)?;
                data += 8;
                u64::from_be_bytes(extended)
            }
            1 => return Err(io::ErrorKind::InvalidData.into()),
            length => u64::from(length),
        };
        let next = start
            .checked_add(length)
            .filter(|next| *next >= data && *next <= end)
            .ok_or(io::ErrorKind::InvalidData)?;
        Ok(Atom {
            kind: header[4..].try_into().unwrap(),
            start,
            data,
            end: next,
        })
    }

    fn find(&mut self, mut start: u64, end: u64, kind: &[u8; 4]) -> io::Result<Option<Atom>> {
        while start < end {
            let atom = self.atom(start, end)?;
            if &atom.kind == kind {
                return Ok(Some(atom));
            }
            start = atom.end;
        }
        Ok(None)
    }

    fn handler(&mut self, track: &Atom) -> io::Result<Option<(Atom, [u8; 4])>> {
        let Some(media) = self.find(track.data, track.end, b"mdia")? else {
            return Ok(None);
        };
        let Some(handler) = self.find(media.data, media.end, b"hdlr")? else {
            return Ok(None);
        };
        if handler.end - handler.data < 12 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        self.file.seek(SeekFrom::Start(handler.data + 8))?;
        let mut kind = [0; 4];
        self.file.read_exact(&mut kind)?;
        Ok(Some((media, kind)))
    }
}

pub(super) struct Track {
    pub header: u64,
    pub language: String,
    media: Atom,
    edits: Option<Atom>,
}
#[derive(Default)]
pub(super) struct Tracks {
    pub subtitles: Vec<Track>,
    pub audio: Vec<Track>,
}

pub(super) fn tracks(file: &mut (impl Read + Seek), len: u64) -> io::Result<Tracks> {
    let mut scanner = Scanner {
        file,
        headers_left: MAX_HEADERS,
    };
    let Some(movie) = scanner.find(0, len, b"moov")? else {
        return Ok(Tracks::default());
    };
    let mut start = movie.data;
    let mut result = Tracks::default();
    while let Some(track) = scanner.find(start, movie.end, b"trak")? {
        start = track.end;
        let Some((media, kind)) = scanner.handler(&track)? else {
            continue;
        };
        let list = match &kind {
            b"sbtl" | b"subt" | b"clcp" => &mut result.subtitles,
            b"soun" => &mut result.audio,
            _ => continue,
        };
        let language = scanner.language(&media).unwrap_or_default();
        list.push(Track {
            header: track.start + 4,
            language,
            media,
            edits: scanner.find(track.data, track.end, b"edts")?,
        });
    }
    Ok(result)
}

impl<R: Read + Seek> Scanner<'_, R> {
    fn language(&mut self, media: &Atom) -> io::Result<String> {
        let Some(mdhd) = self.find(media.data, media.end, b"mdhd")? else {
            return Ok(String::new());
        };
        let data = self.data(&mdhd, 64)?;
        let at = match data.first() {
            Some(0) => 20,
            Some(1) => 32,
            _ => return Ok(String::new()),
        };
        let packed = u16::from_be_bytes(
            data.get(at..at + 2)
                .ok_or(io::ErrorKind::InvalidData)?
                .try_into()
                .unwrap(),
        );
        let code = [10, 5, 0].map(|shift| ((packed >> shift) as u8 & 31) + b'a' - 1);
        Ok(code
            .iter()
            .all(u8::is_ascii_lowercase)
            .then(|| String::from_utf8_lossy(&code).into_owned())
            .unwrap_or_default())
    }

    fn data(&mut self, atom: &Atom, max: usize) -> io::Result<Vec<u8>> {
        let len = usize::try_from(atom.end - atom.data)
            .ok()
            .filter(|len| *len <= max)
            .ok_or(io::ErrorKind::InvalidData)?;
        self.file.seek(SeekFrom::Start(atom.data))?;
        let mut data = vec![0; len];
        self.file.read_exact(&mut data)?;
        Ok(data)
    }
}

#[cfg(test)]
fn subtitle_headers(file: &mut (impl Read + Seek), len: u64) -> io::Result<Vec<u64>> {
    Ok(tracks(file, len)?
        .subtitles
        .into_iter()
        .map(|track| track.header)
        .collect())
}

pub(super) fn apply_overlays(bytes: &mut [u8], offset: u64, patches: &[u64]) {
    for &start in &patches[patches.partition_point(|p| p + 4 <= offset)..] {
        if start >= offset + bytes.len() as u64 {
            break;
        }
        for (i, &value) in b"free".iter().enumerate() {
            if let Some(index) = (start + i as u64).checked_sub(offset) {
                if let Some(byte) = bytes.get_mut(index as usize) {
                    *byte = value;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn atom(kind: &[u8; 4], data: &[u8]) -> Vec<u8> {
        [(data.len() as u32 + 8).to_be_bytes().as_slice(), kind, data].concat()
    }

    fn track(kind: &[u8; 4]) -> Vec<u8> {
        atom(
            b"trak",
            &atom(
                b"mdia",
                &atom(b"hdlr", &[&[0; 8], kind.as_slice()].concat()),
            ),
        )
    }

    #[cfg(unix)]
    #[test]
    fn finds_subtitle_after_a_64_bit_media_box() {
        use std::io::Write;
        let mut file = tempfile::tempfile().unwrap();
        let media_size = (1_u64 << 32) + 1024;
        file.write_all(&[0, 0, 0, 1, b'm', b'd', b'a', b't'])
            .unwrap();
        file.write_all(&media_size.to_be_bytes()).unwrap();
        file.seek(SeekFrom::Start(media_size)).unwrap();
        file.write_all(&atom(b"moov", &track(b"sbtl"))).unwrap();
        let len = file.metadata().unwrap().len();
        assert_eq!(subtitle_headers(&mut file, len).unwrap(), [media_size + 12]);
    }

    #[test]
    fn reads_a_timed_text_track_without_moving_media_bytes() {
        let mut bytes = atom(b"mdat", b"\0\x04<&hi");
        let table = |kind, words: &[u32]| {
            atom(
                kind,
                &words
                    .iter()
                    .flat_map(|n| n.to_be_bytes())
                    .collect::<Vec<_>>(),
            )
        };
        let description = atom(b"stsd", b"\0\0\0\0\0\0\0\x01\0\0\0\x08tx3g");
        let tables = [
            description,
            table(b"stsz", &[0, 0, 1, 6]),
            table(b"stsc", &[0, 1, 1, 1, 1]),
            table(b"stts", &[0, 1, 1, 1000]),
            table(b"stco", &[0, 1, 8]),
        ]
        .concat();
        let media = [
            table(b"mdhd", &[0, 0, 0, 1000, 1000, 0]),
            atom(b"hdlr", b"\0\0\0\0\0\0\0\0sbtl"),
            atom(b"minf", &atom(b"stbl", &tables)),
        ]
        .concat();
        bytes.extend(atom(b"moov", &atom(b"trak", &atom(b"mdia", &media))));
        let len = bytes.len() as u64;
        let mut file = Cursor::new(&bytes);
        let found = tracks(&mut file, len).unwrap();
        assert_eq!(
            text_track(&mut file, &found.subtitles[0], len).unwrap(),
            "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n&lt;&amp;hi\n\n"
        );
    }

    #[test]
    fn only_subtitle_tracks_are_hidden_across_ranges() {
        let mut bytes = atom(b"mdat", &[0; 16]);
        let movie = [
            track(b"soun"),
            track(b"sbtl"),
            track(b"text"),
            track(b"subt"),
        ]
        .concat();
        bytes.extend(atom(b"moov", &movie));
        let patches = subtitle_headers(&mut Cursor::new(&bytes), bytes.len() as u64).unwrap();
        assert_eq!(patches.len(), 2);
        let mut streamed = bytes.clone();
        for (i, chunk) in streamed.chunks_mut(3).enumerate() {
            apply_overlays(chunk, (i * 3) as u64, &patches);
        }
        assert_eq!(streamed.windows(4).filter(|w| *w == b"trak").count(), 2);
        for patch in patches {
            assert_eq!(&streamed[patch as usize..][..4], b"free");
        }
        let short = bytes.len() as u64 - 1;
        assert!(subtitle_headers(&mut Cursor::new(bytes), short).is_err());
    }
}

pub(super) fn supported_text_tracks(
    file: &mut (impl Read + Seek),
    tracks: Vec<Track>,
) -> Vec<Track> {
    let mut scan = Scanner {
        file,
        headers_left: MAX_HEADERS,
    };
    tracks
        .into_iter()
        .filter(|track| text_table(&mut scan, track).is_ok())
        .collect()
}

fn text_table<R: Read + Seek>(scan: &mut Scanner<'_, R>, track: &Track) -> io::Result<Atom> {
    let invalid = io::ErrorKind::InvalidData;
    let minf = scan
        .find(track.media.data, track.media.end, b"minf")?
        .ok_or(invalid)?;
    let stbl = scan.find(minf.data, minf.end, b"stbl")?.ok_or(invalid)?;
    if let Some(edits) = &track.edits {
        let list = scan.find(edits.data, edits.end, b"elst")?.ok_or(invalid)?;
        let entry = scan.data(&list, 32)?;
        let (start, rate) = match entry.first() {
            Some(0) => (12, 16),
            Some(1) => (16, 24),
            _ => return Err(invalid.into()),
        };
        if word(&entry, 4)? != 1
            || entry
                .get(start..rate)
                .ok_or(invalid)?
                .iter()
                .any(|&b| b != 0)
            || word(&entry, rate)? != 0x0001_0000
        {
            return Err(invalid.into());
        }
    }
    if scan.find(stbl.data, stbl.end, b"ctts")?.is_some() {
        return Err(invalid.into());
    }
    let desc = scan.find(stbl.data, stbl.end, b"stsd")?.ok_or(invalid)?;
    let desc = scan.data(&desc, 4096)?;
    if word(&desc, 4)? != 1 || desc.get(12..16) != Some(b"tx3g") {
        return Err(invalid.into());
    }
    Ok(stbl)
}

/// Extract one non-fragmented tx3g track for a plain WebVTT sidecar.
pub(super) fn text_track(
    file: &mut (impl Read + Seek),
    track: &Track,
    len: u64,
) -> io::Result<String> {
    let mut scan = Scanner {
        file,
        headers_left: MAX_HEADERS,
    };
    let invalid = io::ErrorKind::InvalidData;
    let stbl = text_table(&mut scan, track)?;
    let mdhd = scan
        .find(track.media.data, track.media.end, b"mdhd")?
        .ok_or(invalid)?;
    let info = scan.data(&mdhd, 64)?;
    let scale = u64::from(word(
        &info,
        match info.first() {
            Some(0) => 12,
            Some(1) => 20,
            _ => return Err(invalid.into()),
        },
    )?);
    if scale == 0 {
        return Err(invalid.into());
    }
    let mut read = |kind| {
        let atom = scan.find(stbl.data, stbl.end, kind)?.ok_or(invalid)?;
        scan.data(&atom, 512 * 1024)
    };
    let sizes = read(b"stsz")?;
    let count = word(&sizes, 8)? as usize;
    if count > 20_000 || word(&sizes, 4)? != 0 {
        return Err(invalid.into());
    }
    let mappings = read(b"stsc")?;
    let times = read(b"stts")?;
    let (offsets, width) = match read(b"co64") {
        Ok(offsets) => (offsets, 8),
        Err(_) => (read(b"stco")?, 4),
    };
    let chunk_count = word(&offsets, 4)? as usize;
    let map_count = word(&mappings, 4)? as usize;
    let time_count = word(&times, 4)? as usize;
    if chunk_count > count
        || map_count > chunk_count
        || time_count > count
        || map_count == 0
        || time_count == 0
    {
        return Err(invalid.into());
    }
    if word(&mappings, 8)? != 1 {
        return Err(invalid.into());
    }
    let mut map = 0;
    let mut timing = 0;
    let mut remaining = word(&times, 8)?;
    let mut clock = 0u64;
    let mut sample = 0;
    let mut text_bytes = 0;
    let mut result = String::from("WEBVTT\n\n");
    for chunk in 0..chunk_count {
        if map + 1 < map_count && word(&mappings, 8 + (map + 1) * 12)? as usize == chunk + 1 {
            map += 1;
        }
        let samples = word(&mappings, 12 + map * 12)? as usize;
        if samples > count - sample || word(&mappings, 16 + map * 12)? != 1 {
            return Err(invalid.into());
        }
        let at = 8 + chunk * width;
        let mut offset = u64::from(word(&offsets, at)?);
        if width == 8 {
            offset = (offset << 32) | u64::from(word(&offsets, at + 4)?);
        }
        for _ in 0..samples {
            if remaining == 0 {
                timing += 1;
                if timing == time_count {
                    return Err(invalid.into());
                }
                remaining = word(&times, 8 + timing * 8)?;
                if remaining == 0 {
                    return Err(invalid.into());
                }
            }
            remaining -= 1;
            let end = clock + u64::from(word(&times, 12 + timing * 8)?);
            let size = u64::from(word(&sizes, 12 + sample * 4)?);
            let next = offset
                .checked_add(size)
                .filter(|end| *end <= len)
                .ok_or(invalid)?;
            if size > 2 {
                scan.file.seek(SeekFrom::Start(offset))?;
                let mut size_bytes = [0; 2];
                scan.file.read_exact(&mut size_bytes)?;
                let text_len = usize::from(u16::from_be_bytes(size_bytes));
                text_bytes += text_len;
                if text_len as u64 + 2 > size
                    || text_bytes > 1024 * 1024
                    || result.len() + text_len * 5 > 1024 * 1024
                {
                    return Err(invalid.into());
                }
                let mut text = vec![0; text_len];
                scan.file.read_exact(&mut text)?;
                let text = std::str::from_utf8(&text).map_err(|_| invalid)?;
                if !text.trim().is_empty() {
                    use std::fmt::Write;
                    writeln!(result, "{} --> {}", stamp(clock, scale), stamp(end, scale)).unwrap();
                    for line in text.lines().filter(|line| !line.trim().is_empty()) {
                        writeln!(
                            result,
                            "{}",
                            line.replace('&', "&amp;").replace('<', "&lt;")
                        )
                        .unwrap();
                    }
                    result.push('\n');
                }
            }
            clock = end;
            offset = next;
            sample += 1;
        }
    }
    if sample != count
        || remaining != 0
        || timing + 1 != time_count
        || map + 1 != map_count
        || result.len() > 1024 * 1024
    {
        return Err(invalid.into());
    }
    Ok(result)
}

fn word(data: &[u8], at: usize) -> io::Result<u32> {
    Ok(u32::from_be_bytes(
        data.get(at..at + 4)
            .ok_or(io::ErrorKind::InvalidData)?
            .try_into()
            .unwrap(),
    ))
}

fn stamp(ticks: u64, scale: u64) -> String {
    let ms = (u128::from(ticks) * 1000 / u128::from(scale)) as u64;
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}
