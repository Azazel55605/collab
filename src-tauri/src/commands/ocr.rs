use super::media_jobs::MediaJob;
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::process::Stdio;
use std::sync::LazyLock;
use std::time::{Duration, Instant};
static OCR_SLOTS: LazyLock<tokio::sync::Semaphore> =
    LazyLock::new(|| tokio::sync::Semaphore::new(2));
static LANGUAGE_SLOTS: LazyLock<tokio::sync::Semaphore> =
    LazyLock::new(|| tokio::sync::Semaphore::new(1));
use std::path::PathBuf;
use std::process::Command;

use super::app_config_dir;

const MAX_LANGUAGE_PACK_BYTES: usize = 80 * 1024 * 1024;
const OFFICIAL_FAST_BASE_URL: &str = "https://github.com/tesseract-ocr/tessdata_fast/raw/main";

#[derive(Clone, Copy)]
struct OcrLanguageDefinition {
    code: &'static str,
    label: &'static str,
}

const OCR_LANGUAGES: &[OcrLanguageDefinition] = &[
    OcrLanguageDefinition {
        code: "eng",
        label: "English",
    },
    OcrLanguageDefinition {
        code: "deu",
        label: "German",
    },
    OcrLanguageDefinition {
        code: "fra",
        label: "French",
    },
    OcrLanguageDefinition {
        code: "spa",
        label: "Spanish",
    },
    OcrLanguageDefinition {
        code: "ita",
        label: "Italian",
    },
    OcrLanguageDefinition {
        code: "por",
        label: "Portuguese",
    },
    OcrLanguageDefinition {
        code: "nld",
        label: "Dutch",
    },
    OcrLanguageDefinition {
        code: "pol",
        label: "Polish",
    },
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrLanguagePack {
    code: String,
    label: String,
    bundled: bool,
    installed: bool,
    size_bytes: Option<u64>,
    sha256: Option<String>,
    installed_at: Option<String>,
    source_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrLanguagePackData {
    code: String,
    data_base64: String,
}

fn language_definition(code: &str) -> Option<OcrLanguageDefinition> {
    OCR_LANGUAGES
        .iter()
        .copied()
        .find(|language| language.code == code)
}

fn official_fast_url(code: &str) -> String {
    format!("{OFFICIAL_FAST_BASE_URL}/{code}.traineddata")
}

fn language_pack_dir() -> Result<PathBuf, String> {
    let dir = app_config_dir()?
        .join("ocr")
        .join("languages")
        .join("official-fast");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create OCR language directory: {e}"))?;
    Ok(dir)
}

fn language_pack_path(code: &str) -> Result<PathBuf, String> {
    Ok(language_pack_dir()?.join(format!("{code}.traineddata")))
}

fn metadata_path(code: &str) -> Result<PathBuf, String> {
    Ok(language_pack_dir()?.join(format!("{code}.json")))
}

fn file_sha256(path: &PathBuf) -> Result<String, String> {
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut chunk = [0; 65536];
    loop {
        let count = file.read(&mut chunk).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        hasher.update(&chunk[..count]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn installed_metadata(code: &str) -> (Option<u64>, Option<String>, Option<String>) {
    let Ok(path) = language_pack_path(code) else {
        return (None, None, None);
    };
    if !path.exists() {
        return (None, None, None);
    }
    let size_bytes = std::fs::metadata(&path).ok().map(|metadata| metadata.len());
    let sha256 = file_sha256(&path).ok();
    let installed_at = metadata_path(code)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|value| {
            value
                .get("installedAt")
                .and_then(|value| value.as_str())
                .map(str::to_string)
        });
    (size_bytes, sha256, installed_at)
}

fn pack_info(language: OcrLanguageDefinition) -> OcrLanguagePack {
    let bundled = language.code == "eng";
    let path_exists = language_pack_path(language.code)
        .map(|path| path.exists())
        .unwrap_or(false);
    let installed = bundled || path_exists;
    let (size_bytes, sha256, installed_at) = if path_exists {
        installed_metadata(language.code)
    } else {
        (None, None, None)
    };

    OcrLanguagePack {
        code: language.code.to_string(),
        label: language.label.to_string(),
        bundled,
        installed,
        size_bytes,
        sha256,
        installed_at,
        source_url: official_fast_url(language.code),
    }
}

#[tauri::command]
pub fn list_ocr_language_packs() -> Result<Vec<OcrLanguagePack>, String> {
    Ok(OCR_LANGUAGES.iter().copied().map(pack_info).collect())
}

async fn stream_language(
    mut response: reqwest::Response,
    staged: &tempfile::NamedTempFile,
    job: &MediaJob,
    limit: usize,
    minimum: usize,
) -> Result<(usize, String), String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("OCR language pack is too large".into());
    }
    let mut output = tokio::fs::File::from_std(staged.reopen().map_err(|e| e.to_string())?);
    use tokio::io::AsyncWriteExt;
    let mut size = 0usize;
    let mut hasher = Sha256::new();
    while let Some(chunk) = job
        .wait(response.chunk())
        .await?
        .map_err(|e| format!("Failed to read OCR language download: {e}"))?
    {
        if chunk.len() > limit.saturating_sub(size) {
            return Err("OCR language pack is too large".into());
        }
        size += chunk.len();
        hasher.update(&chunk);
        output.write_all(&chunk).await.map_err(|e| e.to_string())?;
    }
    if size < minimum {
        return Err("Downloaded OCR language pack was unexpectedly small".into());
    }
    output.sync_all().await.map_err(|e| e.to_string())?;
    drop(output);
    Ok((size, hex::encode(hasher.finalize())))
}

#[tauri::command]
pub async fn install_ocr_language_pack(
    code: String,
    request_id: Option<String>,
) -> Result<OcrLanguagePack, String> {
    let language =
        language_definition(&code).ok_or_else(|| "Unsupported OCR language pack".to_string())?;
    if language.code == "eng" {
        return Ok(pack_info(language));
    }

    let job = MediaJob::start(request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()))?;
    let _slot = LANGUAGE_SLOTS
        .try_acquire()
        .map_err(|_| "Another language download is running")?;
    let source_url = official_fast_url(language.code);
    let response = job
        .wait(
            reqwest::Client::builder()
                .timeout(Duration::from_secs(180))
                .build()
                .map_err(|e| e.to_string())?
                .get(&source_url)
                .header(reqwest::header::USER_AGENT, "collab-ocr-language-manager")
                .send(),
        )
        .await?
        .map_err(|e| format!("Failed to download OCR language pack: {e}"))?;

    if !response.status().is_success() {
        return Err(format!(
            "Failed to download OCR language pack: HTTP {}",
            response.status()
        ));
    }

    if let Some(length) = response.content_length() {
        if length > MAX_LANGUAGE_PACK_BYTES as u64 {
            return Err("OCR language pack is too large".to_string());
        }
    }

    let pack_path = language_pack_path(language.code)?;
    let staged =
        tempfile::NamedTempFile::new_in(language_pack_dir()?).map_err(|e| e.to_string())?;
    let (size, sha256) =
        stream_language(response, &staged, &job, MAX_LANGUAGE_PACK_BYTES, 1024).await?;
    job.check()?;
    staged
        .persist(&pack_path)
        .map_err(|e| format!("Failed to publish OCR language pack: {e}"))?;
    let metadata = serde_json::json!({
        "code": language.code,
        "source": "official-fast",
        "sourceUrl": source_url,
        "sizeBytes": size,
        "sha256": sha256,
        "installedAt": Utc::now().to_rfc3339(),
    });
    std::fs::write(
        metadata_path(language.code)?,
        serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write OCR language metadata: {e}"))?;

    Ok(pack_info(language))
}

#[tauri::command]
pub fn remove_ocr_language_pack(code: String) -> Result<OcrLanguagePack, String> {
    let language =
        language_definition(&code).ok_or_else(|| "Unsupported OCR language pack".to_string())?;
    if language.code == "eng" {
        return Err("The bundled English OCR language pack cannot be removed".to_string());
    }

    let pack_path = language_pack_path(language.code)?;
    if pack_path.exists() {
        std::fs::remove_file(&pack_path)
            .map_err(|e| format!("Failed to remove OCR language pack: {e}"))?;
    }
    let metadata = metadata_path(language.code)?;
    if metadata.exists() {
        std::fs::remove_file(metadata)
            .map_err(|e| format!("Failed to remove OCR language metadata: {e}"))?;
    }

    Ok(pack_info(language))
}

#[tauri::command]
pub fn read_ocr_language_pack_data(code: String) -> Result<OcrLanguagePackData, String> {
    let language =
        language_definition(&code).ok_or_else(|| "Unsupported OCR language pack".to_string())?;
    if language.code == "eng" {
        return Err("Bundled OCR language packs are loaded from application assets".to_string());
    }

    let pack_path = language_pack_path(language.code)?;
    if !pack_path.exists() {
        return Err("OCR language pack is not installed".to_string());
    }

    let bytes =
        std::fs::read(&pack_path).map_err(|e| format!("Failed to read OCR language pack: {e}"))?;
    if bytes.len() > MAX_LANGUAGE_PACK_BYTES {
        return Err("OCR language pack is too large".to_string());
    }

    Ok(OcrLanguagePackData {
        code: language.code.to_string(),
        data_base64: STANDARD.encode(bytes),
    })
}

fn decode_image_data_url(data_url: &str) -> Result<(Vec<u8>, &'static str), String> {
    if data_url.len() > 64 * 1024 * 1024 {
        return Err("OCR image exceeds its 48 MiB byte limit".into());
    }
    let (header, encoded) = data_url
        .split_once(',')
        .ok_or_else(|| "OCR input is not a valid data URL.".to_string())?;
    if !header.starts_with("data:image/") || !header.ends_with(";base64") {
        return Err("OCR input must be a base64 image data URL.".to_string());
    }

    let extension = if header.starts_with("data:image/png") {
        "png"
    } else if header.starts_with("data:image/jpeg") || header.starts_with("data:image/jpg") {
        "jpg"
    } else if header.starts_with("data:image/webp") {
        "webp"
    } else {
        return Err("OCR supports PNG, JPEG, and WebP images.".to_string());
    };

    let bytes = STANDARD
        .decode(encoded.as_bytes())
        .map_err(|_| "OCR input image is not valid base64.".to_string())?;
    if bytes.is_empty() {
        return Err("OCR input image is empty.".to_string());
    }
    Ok((bytes, extension))
}

fn normalize_ocr_language(language: Option<String>) -> Result<String, String> {
    let language = language.unwrap_or_else(|| "eng".to_string());
    let codes: Vec<&str> = language.split('+').collect();
    if codes.is_empty() || codes.iter().any(|code| language_definition(code).is_none()) {
        return Err("Unsupported OCR language".to_string());
    }
    Ok(codes.join("+"))
}

struct ChildGuard(std::process::Child);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn bounded_text(path: &std::path::Path, limit: u64) -> Result<String, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    if file.metadata().map_err(|e| e.to_string())?.len() > limit {
        return Err("OCR output exceeds its byte limit".into());
    }
    let mut value = String::new();
    file.take(limit + 1)
        .read_to_string(&mut value)
        .map_err(|e| e.to_string())?;
    if value.len() as u64 > limit {
        return Err("OCR output exceeds its byte limit".into());
    }
    Ok(value)
}
fn run_command(
    mut command: Command,
    job: &MediaJob,
    outputs: &[PathBuf],
    timeout: Duration,
) -> Result<String, String> {
    let stdout = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    let stderr = tempfile::NamedTempFile::new().map_err(|e| e.to_string())?;
    command
        .stdin(Stdio::null())
        .stdout(stdout.reopen().map_err(|e| e.to_string())?)
        .stderr(stderr.reopen().map_err(|e| e.to_string())?);
    let mut child = ChildGuard(
        command
            .spawn()
            .map_err(|e| format!("Could not start tesseract (is it installed?): {e}"))?,
    );
    let started = Instant::now();
    loop {
        job.check()?;
        if started.elapsed() > timeout {
            return Err("OCR process timed out".into());
        }
        for path in outputs
            .iter()
            .map(|path| path.as_path())
            .chain([stdout.path(), stderr.path()])
        {
            let limit = if path == stderr.path() {
                256 * 1024
            } else {
                16 * 1024 * 1024
            };
            if std::fs::metadata(path).is_ok_and(|metadata| metadata.len() > limit) {
                return Err("OCR output exceeds its byte limit".into());
            }
        }
        if let Some(status) = child.0.try_wait().map_err(|e| e.to_string())? {
            if !status.success() {
                return Err(format!(
                    "OCR failed: {}",
                    bounded_text(stderr.path(), 256 * 1024)?.trim()
                ));
            }
            return bounded_text(stdout.path(), 4 * 1024 * 1024);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}
fn prepare_input(data_url: &str) -> Result<tempfile::NamedTempFile, String> {
    let (bytes, extension) = decode_image_data_url(data_url)?;
    use image::ImageDecoder;
    let reader = image::ImageReader::new(std::io::Cursor::new(&bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let (width, height) = decoder.dimensions();
    if u64::from(width) * u64::from(height) > 48_000_000 {
        return Err("OCR image exceeds its 48 megapixel limit".into());
    }
    let mut input = tempfile::Builder::new()
        .prefix("collab-ocr-")
        .suffix(&format!(".{extension}"))
        .tempfile()
        .map_err(|e| e.to_string())?;
    input.write_all(&bytes).map_err(|e| e.to_string())?;
    input.flush().map_err(|e| e.to_string())?;
    Ok(input)
}
#[tauri::command]
pub async fn recognize_image_data_url(
    data_url: String,
    language: Option<String>,
    request_id: Option<String>,
) -> Result<String, String> {
    let _permit = OCR_SLOTS.try_acquire().map_err(|_| "Native OCR is busy")?;
    let job = MediaJob::start(request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()))?;
    tauri::async_runtime::spawn_blocking(move || {
        job.check()?;
        let input = prepare_input(&data_url)?;
        let language = normalize_ocr_language(language)?;
        let mut command = Command::new("tesseract");
        command
            .arg(input.path())
            .arg("stdout")
            .arg("-l")
            .arg(&language);
        if !language.split('+').any(|code| code == "eng") {
            command.env("TESSDATA_PREFIX", language_pack_dir()?);
        }
        run_command(command, &job, &[], Duration::from_secs(60)).map(|text| text.trim().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOcrWord {
    text: String,
    confidence: f32,
    x0: f32,
    y0: f32,
    x1: f32,
    y1: f32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeOcrResult {
    text: String,
    words: Vec<NativeOcrWord>,
}

// Parse Tesseract TSV output into word boxes. Columns are:
// level page block par line word left top width height conf text
// level 5 is a recognized word.
fn parse_tesseract_tsv(tsv: &str) -> Vec<NativeOcrWord> {
    let mut words = Vec::new();
    for line in tsv.lines() {
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 12 || cols[0] != "5" {
            continue;
        }
        let text = cols[11..].join("\t").trim().to_string();
        if text.is_empty() {
            continue;
        }
        let (Ok(left), Ok(top), Ok(width), Ok(height)) = (
            cols[6].parse::<f32>(),
            cols[7].parse::<f32>(),
            cols[8].parse::<f32>(),
            cols[9].parse::<f32>(),
        ) else {
            continue;
        };
        let confidence = cols[10].parse::<f32>().unwrap_or(0.0);
        words.push(NativeOcrWord {
            text,
            confidence,
            x0: left,
            y0: top,
            x1: left + width,
            y1: top + height,
        });
    }
    words
}

/// Native OCR that also returns per-word bounding boxes (in source-image pixel
/// coordinates) so the selectable/visible OCR overlay can render when the
/// bundled WASM engine is unavailable.
#[tauri::command]
pub async fn recognize_image_data_url_words(
    data_url: String,
    language: Option<String>,
    request_id: Option<String>,
) -> Result<NativeOcrResult, String> {
    let _permit = OCR_SLOTS.try_acquire().map_err(|_| "Native OCR is busy")?;
    let job = MediaJob::start(request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()))?;
    tauri::async_runtime::spawn_blocking(move || {
        job.check()?;
        let input = prepare_input(&data_url)?;
        let language = normalize_ocr_language(language)?;
        let directory = tempfile::Builder::new()
            .prefix("collab-ocr-out-")
            .tempdir()
            .map_err(|e| e.to_string())?;
        let base = directory.path().join("result");
        let mut command = Command::new("tesseract");
        command
            .arg(input.path())
            .arg(&base)
            .arg("-l")
            .arg(&language)
            .arg("txt")
            .arg("tsv");
        if !language.split('+').any(|code| code == "eng") {
            command.env("TESSDATA_PREFIX", language_pack_dir()?);
        }
        run_command(
            command,
            &job,
            &[base.with_extension("txt"), base.with_extension("tsv")],
            Duration::from_secs(60),
        )?;
        job.check()?;
        let text = bounded_text(&base.with_extension("txt"), 4 * 1024 * 1024)?;
        let words = parse_tesseract_tsv(&bounded_text(
            &base.with_extension("tsv"),
            16 * 1024 * 1024,
        )?);
        Ok(NativeOcrResult {
            text: text.trim().to_string(),
            words,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn kills_hung_and_noisy_processes_and_preserves_cleanup() {
        let job = MediaJob::start(uuid::Uuid::new_v4().to_string()).unwrap();
        let mut command = Command::new("/bin/sleep");
        command.arg("5");
        let start = Instant::now();
        assert!(run_command(command, &job, &[], Duration::from_millis(50))
            .unwrap_err()
            .contains("timed out"));
        assert!(start.elapsed() < Duration::from_secs(2));
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(
            "while :; do printf 'abcdefghijklmnopqrstuvxyzabcdefghijklmnopqrstuvxyz' >&2; done",
        );
        assert!(run_command(command, &job, &[], Duration::from_secs(2))
            .unwrap_err()
            .contains("byte limit"));
    }
    #[tokio::test]
    async fn streamed_pack_checks_actual_bytes_without_a_content_length() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).await;
            socket.write_all(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nA\r\n0123456789\r\n0\r\n\r\n").await.unwrap();
        });
        let response = reqwest::get(format!("http://{address}/pack"))
            .await
            .unwrap();
        let stage = tempfile::NamedTempFile::new().unwrap();
        let job = MediaJob::start(uuid::Uuid::new_v4().to_string()).unwrap();
        assert!(stream_language(response, &stage, &job, 8, 1)
            .await
            .unwrap_err()
            .contains("too large"));
        assert_eq!(std::fs::metadata(stage.path()).unwrap().len(), 0);
        server.await.unwrap();
    }

    #[test]
    fn parses_word_rows_and_skips_non_words() {
        let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n\
1\t1\t0\t0\t0\t0\t0\t0\t640\t480\t-1\t\n\
5\t1\t1\t1\t1\t1\t10\t20\t30\t12\t96\tHello\n\
5\t1\t1\t1\t1\t2\t50\t20\t40\t12\t95\tworld\n\
5\t1\t1\t1\t1\t3\t0\t0\t0\t0\t-1\t   ";
        let words = parse_tesseract_tsv(tsv);
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "Hello");
        assert_eq!(words[0].x0, 10.0);
        assert_eq!(words[0].y0, 20.0);
        assert_eq!(words[0].x1, 40.0);
        assert_eq!(words[0].y1, 32.0);
        assert_eq!(words[1].text, "world");
        assert_eq!(words[1].x1, 90.0);
    }

    #[test]
    fn tolerates_text_containing_tabs_and_short_rows() {
        let tsv = "5\t1\t1\t1\t1\t1\t5\t5\t20\t10\t90\ta\tb\n\
garbage\trow";
        let words = parse_tesseract_tsv(tsv);
        assert_eq!(words.len(), 1);
        assert_eq!(words[0].text, "a\tb");
    }
}
