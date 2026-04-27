use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;
use tokio::net::lookup_host;

use reqwest::header::{CONTENT_TYPE, USER_AGENT};
use reqwest::{Client, Response};
use scraper::{Html, Selector};
use serde::Serialize;
use url::Url;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreviewData {
    pub resolved_url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub site_name: Option<String>,
    pub image_url: Option<String>,
    pub favicon_url: Option<String>,
    pub embeddable: bool,
    pub embed_block_reason: Option<String>,
}

const MAX_REDIRECTS: usize = 10;
const MAX_HTML_PREVIEW_BYTES: usize = 512 * 1024;

fn normalize_input_url(input: &str) -> Result<Url, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("URL is required".into());
    }

    Url::parse(trimmed)
        .or_else(|_| Url::parse(&format!("https://{trimmed}")))
        .map_err(|_| "Enter a valid HTTP or HTTPS URL".to_string())
        .and_then(|url| match url.scheme() {
            "http" | "https" => Ok(url),
            _ => Err("Only HTTP and HTTPS links are supported".into()),
        })
}

fn is_shared_cgnat_ipv4(ip: &Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 100 && (64..=127).contains(&b)
}

fn is_benchmarking_ipv4(ip: &Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    a == 198 && (18..=19).contains(&b)
}

fn is_reserved_future_use_ipv4(ip: &Ipv4Addr) -> bool {
    ip.octets()[0] >= 240
}

fn is_blocked_ipv4(ip: &Ipv4Addr) -> bool {
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_unspecified()
        || ip.is_documentation()
        || is_shared_cgnat_ipv4(ip)
        || is_benchmarking_ipv4(ip)
        || is_reserved_future_use_ipv4(ip)
}

fn is_blocked_ipv6(ip: &Ipv6Addr) -> bool {
    if let Some(mapped) = ip.to_ipv4_mapped() {
        return is_blocked_ipv4(&mapped);
    }

    ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
        || ip.is_multicast()
        || ip.segments()[0..2] == [0x2001, 0x0db8]
}

fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_blocked_ipv4(&ip),
        IpAddr::V6(ip) => is_blocked_ipv6(&ip),
    }
}

fn validate_url_syntax_for_preview(url: &Url) -> Result<(), String> {
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URLs with embedded credentials are not allowed".into());
    }

    let host = url
        .host_str()
        .ok_or_else(|| "URL must include a hostname".to_string())?;

    if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") {
        return Err("Localhost addresses are not allowed for web previews".into());
    }

    if let Ok(ip) = host.parse::<IpAddr>() {
        if is_blocked_ip(ip) {
            return Err("Private or local network addresses are not allowed for web previews".into());
        }
    }

    Ok(())
}

async fn resolve_and_validate_target(url: &Url) -> Result<Vec<SocketAddr>, String> {
    validate_url_syntax_for_preview(url)?;

    let host = url
        .host_str()
        .ok_or_else(|| "URL must include a hostname".to_string())?;
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs = lookup_host((host, port))
        .await
        .map_err(|_| "Unable to resolve remote host".to_string())?;

    let mut validated = Vec::new();
    for addr in addrs {
        if is_blocked_ip(addr.ip()) {
            return Err("Private or local network targets are not allowed for web previews".into());
        }
        validated.push(addr);
    }

    if validated.is_empty() {
        return Err("Unable to resolve remote host".into());
    }

    Ok(validated)
}

fn first_meta_content(document: &Html, selectors: &[&str]) -> Option<String> {
    selectors
        .iter()
        .filter_map(|selector| Selector::parse(selector).ok())
        .find_map(|selector| {
            document
                .select(&selector)
                .find_map(|node| node.value().attr("content"))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
}

fn first_href(document: &Html, selectors: &[&str]) -> Option<String> {
    selectors
        .iter()
        .filter_map(|selector| Selector::parse(selector).ok())
        .find_map(|selector| {
            document
                .select(&selector)
                .find_map(|node| node.value().attr("href"))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToOwned::to_owned)
        })
}

fn document_title(document: &Html) -> Option<String> {
    let selector = Selector::parse("title").ok()?;
    document
        .select(&selector)
        .next()
        .map(|node| node.text().collect::<String>().trim().to_string())
        .filter(|value| !value.is_empty())
}

fn resolve_optional_url(base: &Url, value: Option<String>) -> Option<String> {
    value.and_then(|raw| {
        let url = Url::parse(&raw)
            .or_else(|_| base.join(&raw))
            .ok()?;
        if !matches!(url.scheme(), "http" | "https") {
            return None;
        }
        Some(url.to_string())
    })
}

fn classify_embed_policy(
    resolved_url: &Url,
    x_frame_options: Option<&str>,
    content_security_policy: Option<&str>,
) -> (bool, Option<String>) {
    if let Some(value) = x_frame_options {
        let normalized = value.trim().to_ascii_lowercase();
        if normalized.contains("deny") {
            return (false, Some("This site forbids framing with X-Frame-Options: DENY.".into()));
        }
        if normalized.contains("sameorigin") {
            return (false, Some("This site only allows embedding on its own domain.".into()));
        }
    }

    if let Some(csp) = content_security_policy {
        let normalized = csp.to_ascii_lowercase();
        if let Some(frame_ancestors) = normalized
            .split(';')
            .map(str::trim)
            .find(|directive| directive.starts_with("frame-ancestors"))
        {
            if frame_ancestors.contains("'none'") {
                return (false, Some("This site blocks all framing via Content Security Policy.".into()));
            }
            if frame_ancestors.contains("'self'") {
                return (false, Some("This site only allows embedding on its own origin.".into()));
            }

            let origin = resolved_url.origin().ascii_serialization();
            if !frame_ancestors.contains('*') && !frame_ancestors.contains(&origin) {
                return (false, Some("This site restricts which origins may embed it.".into()));
            }
        }
    }

    (true, None)
}

async fn read_limited_text_body(response: &mut Response, max_bytes: usize) -> Result<String, String> {
    if let Some(content_length) = response.content_length() {
        if content_length > max_bytes as u64 {
            return Err("Remote page is too large to preview safely".into());
        }
    }

    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > max_bytes {
            return Err("Remote page is too large to preview safely".into());
        }
        bytes.extend_from_slice(&chunk);
    }

    String::from_utf8(bytes).map_err(|e| e.to_string())
}

fn is_html_content_type(content_type: &str) -> bool {
    content_type.contains("text/html") || content_type.contains("application/xhtml+xml")
}

fn link_preview_from_response(
    mut response: Response,
) -> impl std::future::Future<Output = Result<LinkPreviewData, String>> {
    async move {
        let resolved_url = response.url().clone();
        let content_type = response
            .headers()
            .get(CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let x_frame_options = response
            .headers()
            .get("x-frame-options")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let content_security_policy = response
            .headers()
            .get("content-security-policy")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        let (embeddable, embed_block_reason) = classify_embed_policy(
            &resolved_url,
            x_frame_options.as_deref(),
            content_security_policy.as_deref(),
        );

        if !is_html_content_type(&content_type) {
            let favicon_url = resolved_url.join("/favicon.ico").ok().map(|url| url.to_string());
            let title = resolved_url
                .path_segments()
                .and_then(|segments| segments.filter(|segment| !segment.is_empty()).last())
                .map(|segment| segment.replace(['-', '_'], " "));
            return Ok(LinkPreviewData {
                resolved_url: resolved_url.to_string(),
                title,
                description: None,
                site_name: resolved_url.domain().map(|domain| domain.to_string()),
                image_url: None,
                favicon_url,
                embeddable,
                embed_block_reason,
            });
        }

        let html = read_limited_text_body(&mut response, MAX_HTML_PREVIEW_BYTES).await?;
        let document = Html::parse_document(&html);

        let title = first_meta_content(&document, &[
            r#"meta[property="og:title"]"#,
            r#"meta[name="twitter:title"]"#,
        ])
        .or_else(|| document_title(&document));

        let description = first_meta_content(&document, &[
            r#"meta[property="og:description"]"#,
            r#"meta[name="twitter:description"]"#,
            r#"meta[name="description"]"#,
        ]);

        let site_name = first_meta_content(&document, &[
            r#"meta[property="og:site_name"]"#,
            r#"meta[name="application-name"]"#,
        ])
        .or_else(|| resolved_url.domain().map(|domain| domain.to_string()));

        let image_url = resolve_optional_url(
            &resolved_url,
            first_meta_content(&document, &[
                r#"meta[property="og:image"]"#,
                r#"meta[name="twitter:image"]"#,
                r#"meta[name="twitter:image:src"]"#,
            ]),
        );

        let favicon_url = resolve_optional_url(
            &resolved_url,
            first_href(&document, &[
                r#"link[rel="icon"]"#,
                r#"link[rel="shortcut icon"]"#,
                r#"link[rel="apple-touch-icon"]"#,
            ])
            .or_else(|| resolved_url.join("/favicon.ico").ok().map(|url| url.to_string())),
        );

        Ok(LinkPreviewData {
            resolved_url: resolved_url.to_string(),
            title,
            description,
            site_name,
            image_url,
            favicon_url,
            embeddable,
            embed_block_reason,
        })
    }
}

async fn fetch_link_preview_with_client(
    client: &Client,
    url: String,
    allow_initial_local_target: bool,
    allow_redirect_local_targets: bool,
) -> Result<LinkPreviewData, String> {
    let normalized = normalize_input_url(&url)?;
    let mut current_url = normalized;
    for _ in 0..=MAX_REDIRECTS {
        let target_addrs = if allow_initial_local_target && current_url.as_str() == url {
            None
        } else if allow_initial_local_target && allow_redirect_local_targets {
            None
        } else {
            Some(resolve_and_validate_target(&current_url).await?)
        };

        let request_client = if let Some(addrs) = target_addrs.as_ref() {
            let host = current_url
                .host_str()
                .ok_or_else(|| "URL must include a hostname".to_string())?;
            build_pinned_preview_client(addrs, host)?
        } else {
            client.clone()
        };

        let response = request_client
            .get(current_url.clone())
            .header(USER_AGENT, "Collab/0.2 (+canvas-web-card)")
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "Redirect response did not include a valid Location header".to_string())?;
            let next_url = current_url
                .join(location)
                .or_else(|_| Url::parse(location))
                .map_err(|_| "Redirect target is not a valid HTTP or HTTPS URL".to_string())?;

            if !matches!(next_url.scheme(), "http" | "https") {
                return Err("Redirect target must use HTTP or HTTPS".into());
            }
            if !allow_redirect_local_targets {
                resolve_and_validate_target(&next_url).await?;
            }
            current_url = next_url;
            continue;
        }

        let response = response.error_for_status().map_err(|e| e.to_string())?;
        return link_preview_from_response(response).await;
    }

    Err("Too many redirects while fetching web preview".into())
}

fn build_preview_client() -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())
}

fn build_pinned_preview_client(addrs: &[SocketAddr], host: &str) -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(8))
        .resolve_to_addrs(host, addrs)
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn fetch_link_preview(url: String) -> Result<LinkPreviewData, String> {
    let client = build_preview_client()?;
    fetch_link_preview_with_client(&client, url, false, false).await
}

#[cfg(test)]
mod tests {
    use super::{
        classify_embed_policy, document_title, fetch_link_preview_with_client, first_href,
        first_meta_content, is_blocked_ip, normalize_input_url, read_limited_text_body,
        resolve_and_validate_target, resolve_optional_url, validate_url_syntax_for_preview,
        MAX_HTML_PREVIEW_BYTES,
    };
    use httpmock::prelude::*;
    use reqwest::Client;
    use scraper::Html;
    use std::net::IpAddr;
    use url::Url;

    #[test]
    fn normalize_input_url_accepts_http_and_upgrades_bare_domains() {
        let bare = normalize_input_url("example.com/path").expect("bare domain should normalize");
        let http = normalize_input_url("http://example.com").expect("http url should normalize");

        assert_eq!(bare.as_str(), "https://example.com/path");
        assert_eq!(http.as_str(), "http://example.com/");
    }

    #[test]
    fn normalize_input_url_rejects_empty_and_non_http_schemes() {
        let empty = normalize_input_url("   ").expect_err("empty input should fail");
        let file = normalize_input_url("file:///tmp/test.html").expect_err("file scheme should fail");

        assert!(empty.contains("URL is required"));
        assert!(file.contains("Only HTTP and HTTPS"));
    }

    #[test]
    fn validate_url_syntax_for_preview_rejects_credentials_and_local_hosts() {
        let credentials = Url::parse("https://user:pass@example.com").expect("url should parse");
        let localhost = Url::parse("https://localhost:3000").expect("url should parse");
        let private_ip = Url::parse("http://192.168.1.10/").expect("url should parse");

        assert!(validate_url_syntax_for_preview(&credentials)
            .unwrap_err()
            .contains("embedded credentials"));
        assert!(validate_url_syntax_for_preview(&localhost)
            .unwrap_err()
            .contains("Localhost"));
        assert!(validate_url_syntax_for_preview(&private_ip)
            .unwrap_err()
            .contains("Private or local network"));
    }

    #[test]
    fn blocked_ip_rules_cover_reserved_and_mapped_ranges() {
        let shared = "100.64.0.1".parse::<IpAddr>().expect("ip should parse");
        let benchmark = "198.18.0.10".parse::<IpAddr>().expect("ip should parse");
        let reserved = "240.0.0.1".parse::<IpAddr>().expect("ip should parse");
        let mapped_loopback = "::ffff:127.0.0.1".parse::<IpAddr>().expect("ip should parse");
        let mapped_private = "::ffff:10.0.0.1".parse::<IpAddr>().expect("ip should parse");
        let public = "93.184.216.34".parse::<IpAddr>().expect("ip should parse");

        assert!(is_blocked_ip(shared));
        assert!(is_blocked_ip(benchmark));
        assert!(is_blocked_ip(reserved));
        assert!(is_blocked_ip(mapped_loopback));
        assert!(is_blocked_ip(mapped_private));
        assert!(!is_blocked_ip(public));
    }

    #[test]
    fn classify_embed_policy_blocks_x_frame_options_and_csp_restrictions() {
        let url = Url::parse("https://example.com/page").expect("url should parse");

        let deny = classify_embed_policy(&url, Some("DENY"), None);
        let sameorigin = classify_embed_policy(&url, Some("SAMEORIGIN"), None);
        let csp_none = classify_embed_policy(&url, None, Some("default-src 'self'; frame-ancestors 'none'"));
        let csp_other = classify_embed_policy(&url, None, Some("frame-ancestors https://another.example"));

        assert_eq!(deny.0, false);
        assert!(deny.1.unwrap_or_default().contains("DENY"));
        assert_eq!(sameorigin.0, false);
        assert!(sameorigin.1.unwrap_or_default().contains("own domain"));
        assert_eq!(csp_none.0, false);
        assert!(csp_none.1.unwrap_or_default().contains("blocks all framing"));
        assert_eq!(csp_other.0, false);
        assert!(csp_other.1.unwrap_or_default().contains("restricts which origins"));
    }

    #[test]
    fn classify_embed_policy_allows_embeddable_pages() {
        let url = Url::parse("https://example.com/page").expect("url should parse");

        let unrestricted = classify_embed_policy(&url, None, None);
        let wildcard = classify_embed_policy(&url, None, Some("frame-ancestors *"));

        assert_eq!(unrestricted, (true, None));
        assert_eq!(wildcard, (true, None));
    }

    #[test]
    fn html_helpers_extract_metadata_title_and_links() {
        let document = Html::parse_document(
            r#"
            <html>
              <head>
                <title>Document Title</title>
                <meta property="og:title" content="OG Title" />
                <meta name="description" content="Summary text" />
                <link rel="icon" href="/favicon.ico" />
              </head>
            </html>
            "#,
        );

        let title = document_title(&document);
        let og_title = first_meta_content(&document, &[r#"meta[property="og:title"]"#]);
        let description = first_meta_content(&document, &[r#"meta[name="description"]"#]);
        let href = first_href(&document, &[r#"link[rel="icon"]"#]);

        assert_eq!(title.as_deref(), Some("Document Title"));
        assert_eq!(og_title.as_deref(), Some("OG Title"));
        assert_eq!(description.as_deref(), Some("Summary text"));
        assert_eq!(href.as_deref(), Some("/favicon.ico"));
    }

    #[test]
    fn resolve_optional_url_handles_absolute_and_relative_values() {
        let base = Url::parse("https://example.com/path/page").expect("url should parse");

        let relative = resolve_optional_url(&base, Some("/favicon.ico".into()));
        let absolute = resolve_optional_url(&base, Some("https://cdn.example.com/image.png".into()));
        let invalid = resolve_optional_url(&base, Some("::not a url::".into()));
        let file_scheme = resolve_optional_url(&base, Some("file:///tmp/secret.png".into()));
        let data_scheme = resolve_optional_url(&base, Some("data:image/png;base64,abcd".into()));

        assert_eq!(relative.as_deref(), Some("https://example.com/favicon.ico"));
        assert_eq!(absolute.as_deref(), Some("https://cdn.example.com/image.png"));
        assert_eq!(invalid.as_deref(), Some("https://example.com/path/::not%20a%20url::"));
        assert_eq!(file_scheme, None);
        assert_eq!(data_scheme, None);
    }

    #[tokio::test]
    async fn fetch_link_preview_follows_redirects_and_extracts_html_metadata() {
        let server = MockServer::start_async().await;
        let destination = server.mock(|when, then| {
            when.method(GET).path("/destination");
            then.status(200)
                .header("content-type", "text/html; charset=utf-8")
                .header("content-security-policy", "frame-ancestors *")
                .body(
                    r#"
                    <html>
                      <head>
                        <title>Destination Title</title>
                        <meta property="og:title" content="OG Destination" />
                        <meta name="description" content="Preview summary" />
                        <meta property="og:site_name" content="Mock Site" />
                        <meta property="og:image" content="/images/card.png" />
                        <link rel="icon" href="/favicon.ico" />
                      </head>
                    </html>
                    "#,
                );
        });
        let redirect = server.mock(|when, then| {
            when.method(GET).path("/start");
            then.status(302).header("location", "/destination");
        });

        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client should build");
        let preview = fetch_link_preview_with_client(&client, server.url("/start"), true, true)
            .await
            .expect("html preview should fetch");

        redirect.assert();
        destination.assert();
        assert_eq!(preview.resolved_url, server.url("/destination"));
        assert_eq!(preview.title.as_deref(), Some("OG Destination"));
        assert_eq!(preview.description.as_deref(), Some("Preview summary"));
        assert_eq!(preview.site_name.as_deref(), Some("Mock Site"));
        let expected_image = server.url("/images/card.png");
        let expected_favicon = server.url("/favicon.ico");
        assert_eq!(preview.image_url.as_deref(), Some(expected_image.as_str()));
        assert_eq!(preview.favicon_url.as_deref(), Some(expected_favicon.as_str()));
        assert!(preview.embeddable);
        assert!(preview.embed_block_reason.is_none());
    }

    #[tokio::test]
    async fn fetch_link_preview_handles_non_html_content_and_embed_policy_headers() {
        let server = MockServer::start_async().await;
        let asset = server.mock(|when, then| {
            when.method(GET).path("/files/manual.pdf");
            then.status(200)
                .header("content-type", "application/pdf")
                .header("x-frame-options", "DENY")
                .body("%PDF-1.4");
        });

        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client should build");
        let preview = fetch_link_preview_with_client(&client, server.url("/files/manual.pdf"), true, true)
            .await
            .expect("non-html preview should fetch");

        asset.assert();
        assert_eq!(preview.resolved_url, server.url("/files/manual.pdf"));
        assert_eq!(preview.title.as_deref(), Some("manual.pdf"));
        assert_eq!(preview.site_name, None);
        let expected_favicon = server.url("/favicon.ico");
        assert_eq!(preview.favicon_url.as_deref(), Some(expected_favicon.as_str()));
        assert_eq!(preview.image_url, None);
        assert!(!preview.embeddable);
        assert!(preview
            .embed_block_reason
            .as_deref()
            .unwrap_or_default()
            .contains("DENY"));
    }

    #[tokio::test]
    async fn fetch_link_preview_falls_back_to_document_title_and_default_favicon() {
        let server = MockServer::start_async().await;
        let page = server.mock(|when, then| {
            when.method(GET).path("/article/read_me");
            then.status(200)
                .header("content-type", "text/html")
                .body(
                    r#"
                    <html>
                      <head>
                        <title>Readable Article</title>
                        <meta name="description" content="Simple summary" />
                        <meta name="twitter:image" content="/images/preview-card.jpg" />
                      </head>
                    </html>
                    "#,
                );
        });

        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client should build");
        let preview = fetch_link_preview_with_client(&client, server.url("/article/read_me"), true, true)
            .await
            .expect("html preview should fetch");

        page.assert();
        let expected_image = server.url("/images/preview-card.jpg");
        let expected_favicon = server.url("/favicon.ico");
        assert_eq!(preview.title.as_deref(), Some("Readable Article"));
        assert_eq!(preview.description.as_deref(), Some("Simple summary"));
        assert_eq!(preview.image_url.as_deref(), Some(expected_image.as_str()));
        assert_eq!(preview.favicon_url.as_deref(), Some(expected_favicon.as_str()));
        assert_eq!(preview.site_name, None);
    }

    #[tokio::test]
    async fn fetch_link_preview_errors_on_non_success_status() {
        let server = MockServer::start_async().await;
        let missing = server.mock(|when, then| {
            when.method(GET).path("/missing");
            then.status(404)
                .header("content-type", "text/html")
                .body("<html><title>Missing</title></html>");
        });

        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client should build");
        let err = fetch_link_preview_with_client(&client, server.url("/missing"), true, true)
            .await
            .expect_err("404 responses should fail");

        missing.assert();
        assert!(err.contains("404"));
    }

    #[tokio::test]
    async fn fetch_link_preview_rejects_redirects_to_local_targets() {
        let server = MockServer::start_async().await;
        let redirect = server.mock(|when, then| {
            when.method(GET).path("/start");
            then.status(302).header("location", "http://127.0.0.1/internal");
        });

        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client should build");
        let err = fetch_link_preview_with_client(&client, server.url("/start"), true, false)
            .await
            .expect_err("redirect to a local target should fail");

        redirect.assert();
        assert!(err.contains("Private or local network"));
    }

    #[tokio::test]
    async fn resolve_and_validate_target_rejects_localhost_when_resolution_is_attempted() {
        let localhost = Url::parse("http://localhost:8080").expect("url should parse");
        let err = resolve_and_validate_target(&localhost)
            .await
            .expect_err("localhost should be rejected");

        assert!(err.contains("Localhost"));
    }

    #[tokio::test]
    async fn read_limited_text_body_rejects_oversized_html_payloads() {
        let server = MockServer::start_async().await;
        let oversized_body = "a".repeat(MAX_HTML_PREVIEW_BYTES + 1);
        let mock = server.mock(|when, then| {
            when.method(GET).path("/huge");
            then.status(200)
                .header("content-type", "text/html")
                .header("content-length", &(MAX_HTML_PREVIEW_BYTES + 1).to_string())
                .body(oversized_body);
        });

        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("client should build");
        let mut response = client
            .get(server.url("/huge"))
            .send()
            .await
            .expect("response should arrive");
        let err = read_limited_text_body(&mut response, MAX_HTML_PREVIEW_BYTES)
            .await
            .expect_err("oversized response should fail");

        mock.assert();
        assert!(err.contains("too large"));
    }
}
