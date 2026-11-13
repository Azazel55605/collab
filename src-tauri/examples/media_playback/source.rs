use axum::{
    body::{Body, Bytes},
    extract::{Path, State},
    http::{header, HeaderMap, Method, Response, StatusCode},
    routing::{get, post},
    Router,
};
use futures_util::stream;
use parking_lot::Mutex;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path as FilePath,
    sync::{
        atomic::{AtomicU64, Ordering::Relaxed},
        Arc,
    },
};
use tokio::sync::Semaphore;

const CHUNK: usize = 64 * 1024;
const STREAMS: usize = 4;
const FIXTURES: &[(&str, &str)] = &[
    ("large.mp4", "video/mp4"),
    ("tracks.mp4", "video/mp4"),
    ("video.webm", "video/webm"),
    ("tone.mp3", "audio/mpeg"),
    ("tone.wav", "audio/wav"),
    ("tone.flac", "audio/flac"),
    ("sidecar.vtt", "text/vtt; charset=utf-8"),
];

pub(super) struct Probe {
    pub token: String,
    fixtures: HashMap<&'static str, Arc<Fixture>>,
    slots: Arc<Semaphore>,
}

struct Fixture {
    file: Mutex<File>,
    mime: &'static str,
    len: u64,
    read_bytes: AtomicU64,
    ranges: AtomicU64,
    last_range_start: AtomicU64,
}

impl Probe {
    pub fn open(directory: &FilePath) -> io::Result<Self> {
        let mut fixtures = HashMap::new();
        for &(name, mime) in FIXTURES {
            let path = directory.join(name);
            if !path.symlink_metadata()?.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("{name} must be a regular fixture file"),
                ));
            }
            let file = File::open(&path)?;
            let info = file.metadata()?;
            if !info.is_file() || info.len() == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("{name} must be a nonempty regular fixture file"),
                ));
            }
            fixtures.insert(
                name,
                Arc::new(Fixture {
                    file: Mutex::new(file),
                    mime,
                    len: info.len(),
                    read_bytes: AtomicU64::new(0),
                    ranges: AtomicU64::new(0),
                    last_range_start: AtomicU64::new(0),
                }),
            );
        }
        Ok(Self {
            token: uuid::Uuid::new_v4().simple().to_string(),
            fixtures,
            slots: Arc::new(Semaphore::new(STREAMS)),
        })
    }

    fn stats(&self) -> Value {
        let fixtures: HashMap<_, _> = self
            .fixtures
            .iter()
            .map(|(&name, fixture)| {
                (
                    name,
                    json!({
                        "fileBytes": fixture.len,
                        "bytesRead": fixture.read_bytes.load(Relaxed),
                        "rangeRequests": fixture.ranges.load(Relaxed),
                        "lastRangeStart": fixture.last_range_start.load(Relaxed),
                    }),
                )
            })
            .collect();
        json!({ "chunkBytes": CHUNK, "concurrentStreams": STREAMS, "fixtures": fixtures })
    }
}

type Reply = Response<Body>;

pub(super) fn router(probe: Arc<Probe>, host: String) -> Router {
    let prefix = format!("/{}", probe.token);
    let origin = format!("http://{host}");
    Router::new()
        .route(
            &format!("{prefix}/"),
            get(|| async {
                response(
                    StatusCode::OK,
                    "text/html; charset=utf-8",
                    Body::from(include_str!("index.html")),
                )
            }),
        )
        .route(
            &format!("{prefix}/probe.js"),
            get(|| async {
                response(
                    StatusCode::OK,
                    "text/javascript; charset=utf-8",
                    Body::from(include_str!("probe.js")),
                )
            }),
        )
        .route(
            &format!("{prefix}/stats"),
            get(|State(probe): State<Arc<Probe>>| async move {
                response(
                    StatusCode::OK,
                    "application/json",
                    Body::from(probe.stats().to_string()),
                )
            }),
        )
        .route(
            &format!("{prefix}/report"),
            post(move |headers: HeaderMap, bytes: Bytes| {
                let origin = origin.clone();
                async move {
                    if headers
                        .get(header::ORIGIN)
                        .and_then(|value| value.to_str().ok())
                        != Some(origin.as_str())
                    {
                        return StatusCode::FORBIDDEN;
                    }
                    let Ok(report) = serde_json::from_slice::<Value>(&bytes) else {
                        return StatusCode::BAD_REQUEST;
                    };
                    println!("MEDIA_PLAYBACK_REPORT {report}");
                    StatusCode::NO_CONTENT
                }
            }),
        )
        .route(&format!("{prefix}/fixtures/{{name}}"), get(serve_fixture))
        .layer(axum::extract::DefaultBodyLimit::max(16 * 1024))
        .with_state(probe)
        .layer(axum::middleware::from_fn(
            move |request: axum::extract::Request, next: axum::middleware::Next| {
                let host = host.clone();
                async move {
                    if request
                        .headers()
                        .get(header::HOST)
                        .and_then(|value| value.to_str().ok())
                        != Some(host.as_str())
                    {
                        return response(StatusCode::FORBIDDEN, "text/plain", Body::empty());
                    }
                    next.run(request).await
                }
            },
        ))
}

// A single HTTP byte range, with an inclusive end. The prototype rejects
// multi-range requests and never expands an unsatisfiable range into a full read.
fn byte_range(value: &str, len: u64) -> Option<(u64, u64)> {
    let (first, last) = value.strip_prefix("bytes=")?.split_once('-')?;
    let end = len.checked_sub(1)?;
    if first.is_empty() {
        let count = last.parse::<u64>().ok()?;
        return (count > 0).then_some((len.saturating_sub(count), end));
    }
    let start = first.parse::<u64>().ok()?;
    let end = if last.is_empty() {
        end
    } else {
        end.min(last.parse().ok()?)
    };
    (start <= end).then_some((start, end))
}

async fn serve_fixture(
    State(probe): State<Arc<Probe>>,
    Path(name): Path<String>,
    method: Method,
    headers: HeaderMap,
) -> Reply {
    let Some(fixture) = probe.fixtures.get(name.as_str()) else {
        return response(StatusCode::NOT_FOUND, "text/plain", Body::empty());
    };
    let (start, end, status) =
        if let Some(range) = headers.get(header::RANGE).filter(|_| method == Method::GET) {
            let Some((start, end)) = range
                .to_str()
                .ok()
                .and_then(|range| byte_range(range, fixture.len))
            else {
                let mut reply = response(
                    StatusCode::RANGE_NOT_SATISFIABLE,
                    fixture.mime,
                    Body::empty(),
                );
                reply.headers_mut().insert(
                    header::CONTENT_RANGE,
                    format!("bytes */{}", fixture.len).parse().unwrap(),
                );
                return reply;
            };
            (start, end, StatusCode::PARTIAL_CONTENT)
        } else {
            (0, fixture.len - 1, StatusCode::OK)
        };
    let len = end - start + 1;
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        let Ok(slot) = probe.slots.clone().try_acquire_owned() else {
            return response(StatusCode::SERVICE_UNAVAILABLE, "text/plain", Body::empty());
        };
        if status == StatusCode::PARTIAL_CONTENT {
            fixture.ranges.fetch_add(1, Relaxed);
            fixture.last_range_start.store(start, Relaxed);
        }
        Body::from_stream(stream::try_unfold(
            (fixture.clone(), Arc::new(slot), start),
            move |(fixture, slot, offset)| async move {
                if offset > end {
                    return Ok::<_, io::Error>(None);
                }
                let next = fixture.clone();
                let count = CHUNK.min(usize::try_from(end - offset + 1).unwrap_or(usize::MAX));
                let pending = slot.clone();
                let bytes = tokio::task::spawn_blocking(move || {
                    // A dropped response must still count its in-flight disk read.
                    let _slot = pending;
                    next.read(offset, count)
                })
                .await??;
                Ok(Some((bytes, (fixture, slot, offset + count as u64))))
            },
        ))
    };
    let mut reply = response(status, fixture.mime, body);
    reply
        .headers_mut()
        .insert(header::ACCEPT_RANGES, "bytes".parse().unwrap());
    reply
        .headers_mut()
        .insert(header::CONTENT_LENGTH, len.to_string().parse().unwrap());
    if status == StatusCode::PARTIAL_CONTENT {
        reply.headers_mut().insert(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{}", fixture.len)
                .parse()
                .unwrap(),
        );
    }
    reply
}

impl Fixture {
    fn read(&self, offset: u64, count: usize) -> io::Result<Bytes> {
        let mut bytes = vec![0; count];
        let mut file = self.file.lock();
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(&mut bytes)?;
        self.read_bytes.fetch_add(count as u64, Relaxed);
        Ok(Bytes::from(bytes))
    }
}

fn response(status: StatusCode, mime: &'static str, body: Body) -> Reply {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, mime)
        .header(header::CACHE_CONTROL, "no-store")
        .header(header::CONTENT_SECURITY_POLICY, "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; media-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(header::REFERRER_POLICY, "no-referrer")
        .body(body)
        .expect("static HTTP headers")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_single_ranges_and_rejects_invalid_bounds() {
        assert_eq!(byte_range("bytes=2-4", 8), Some((2, 4)));
        assert_eq!(byte_range("bytes=2-", 8), Some((2, 7)));
        assert_eq!(byte_range("bytes=2-999", 8), Some((2, 7)));
        assert_eq!(byte_range("bytes=-3", 8), Some((5, 7)));
        assert_eq!(byte_range("bytes=-999", 8), Some((0, 7)));
        for header in [
            "bytes=-0",
            "bytes=8-",
            "bytes=4-2",
            "bytes=0-1,4-5",
            "items=0-1",
        ] {
            assert_eq!(byte_range(header, 8), None, "{header}");
        }
    }

    #[tokio::test]
    async fn serves_only_requested_fixture_bytes() {
        let dir = tempfile::tempdir().unwrap();
        for &(name, _) in FIXTURES {
            std::fs::write(dir.path().join(name), b"01234567").unwrap();
        }
        let probe = Arc::new(Probe::open(dir.path()).unwrap());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let host = listener.local_addr().unwrap();
        let app = router(probe.clone(), host.to_string());
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let base = format!("http://{host}/{}", probe.token);
        let url = format!("{base}/fixtures/large.mp4");

        let head = client.head(&url).send().await.unwrap();
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(head.headers()[header::CONTENT_LENGTH], "8");
        let range = client
            .get(&url)
            .header(header::RANGE, "bytes=2-4")
            .send()
            .await
            .unwrap();
        assert_eq!(range.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(range.headers()[header::CONTENT_RANGE], "bytes 2-4/8");
        assert_eq!(range.bytes().await.unwrap(), b"234".as_slice());
        let invalid = client
            .get(&url)
            .header(header::RANGE, "bytes=8-")
            .send()
            .await
            .unwrap();
        assert_eq!(invalid.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(invalid.headers()[header::CONTENT_RANGE], "bytes */8");
        assert_eq!(probe.fixtures["large.mp4"].read_bytes.load(Relaxed), 3);
        let wrong_host = client
            .get(&url)
            .header(header::HOST, "example.invalid")
            .send()
            .await
            .unwrap();
        assert_eq!(wrong_host.status(), StatusCode::FORBIDDEN);
        for path in [
            format!("http://{host}/fixtures/large.mp4"),
            format!("{base}/fixtures/unknown.mp4"),
        ] {
            assert_eq!(
                client.get(path).send().await.unwrap().status(),
                StatusCode::NOT_FOUND
            );
        }
        server.abort();
    }
}
