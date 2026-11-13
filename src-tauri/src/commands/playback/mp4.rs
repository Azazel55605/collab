//! Find subtitle track headers in a local ISO BMFF file. The compatibility
//! response replaces their types with "free" without shifting any offsets.
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

    fn is_subtitle(&mut self, track: &Atom) -> io::Result<bool> {
        let Some(media) = self.find(track.data, track.end, b"mdia")? else {
            return Ok(false);
        };
        let Some(handler) = self.find(media.data, media.end, b"hdlr")? else {
            return Ok(false);
        };
        if handler.end - handler.data < 12 {
            return Err(io::ErrorKind::InvalidData.into());
        }
        self.file.seek(SeekFrom::Start(handler.data + 8))?;
        let mut kind = [0; 4];
        self.file.read_exact(&mut kind)?;
        // Preserve the "text" handler used for QuickTime chapter tracks.
        Ok(matches!(&kind, b"sbtl" | b"subt" | b"clcp"))
    }
}

pub(super) fn subtitle_headers(file: &mut (impl Read + Seek), len: u64) -> io::Result<Vec<u64>> {
    let mut scanner = Scanner {
        file,
        headers_left: MAX_HEADERS,
    };
    let Some(movie) = scanner.find(0, len, b"moov")? else {
        return Ok(Vec::new());
    };
    let mut start = movie.data;
    let mut patches = Vec::new();
    while let Some(track) = scanner.find(start, movie.end, b"trak")? {
        if scanner.is_subtitle(&track)? {
            patches.push(track.start + 4);
        }
        start = track.end;
    }
    Ok(patches)
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
