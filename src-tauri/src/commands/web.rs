use std::net::SocketAddr;
use tokio::net::lookup_host;

#[cfg(test)]
use collab_net_policy::is_blocked_ip;
use collab_net_policy::{
    normalize_http_input, resolve_redirect, sensitive_header_decision, validate_resolved_addresses,
    validate_target, OutboundPolicy, PolicyError, RequestLimits, ResponseBudget,
    SensitiveHeaderDecision, CALENDAR_FEED_POLICY, WEB_PREVIEW_POLICY,
};
use reqwest::header::{
    CONTENT_TYPE, ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED, LOCATION, USER_AGENT,
};
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

const MAX_HTML_PREVIEW_BYTES: usize = WEB_PREVIEW_POLICY.limits.max_response_bytes;

#[cfg(test)]
fn normalize_input_url(input: &str) -> Result<Url, String> {
    let url = normalize_http_input(input, true).map_err(preview_policy_error)?;
    validate_target(&url, WEB_PREVIEW_POLICY)
        .map(|target| target.url)
        .map_err(preview_policy_error)
}

#[cfg(test)]
fn validate_url_syntax_for_preview(url: &Url) -> Result<(), String> {
    validate_target(url, WEB_PREVIEW_POLICY)
        .map(|_| ())
        .map_err(preview_policy_error)
}

async fn resolve_and_validate_target(url: &Url) -> Result<Vec<SocketAddr>, String> {
    resolve_and_validate_target_with_policy(url, WEB_PREVIEW_POLICY)
        .await
        .map_err(preview_policy_error)
}

async fn resolve_and_validate_target_with_policy(
    url: &Url,
    policy: OutboundPolicy,
) -> Result<Vec<SocketAddr>, PolicyError> {
    let target = validate_target(url, policy)?;
    let addrs = lookup_host((target.host.as_str(), target.port))
        .await
        .map_err(|_| PolicyError::NoResolvedAddresses)?;
    validate_resolved_addresses(addrs, policy)
}

fn preview_policy_error(error: PolicyError) -> String {
    match error {
        PolicyError::EmptyUrl => "URL is required".into(),
        PolicyError::InvalidUrl => "Enter a valid HTTP or HTTPS URL".into(),
        PolicyError::SchemeNotAllowed => "Only HTTP and HTTPS links are supported".into(),
        PolicyError::CredentialsNotAllowed => {
            "URLs with embedded credentials are not allowed".into()
        }
        PolicyError::MissingHost => "URL must include a hostname".into(),
        PolicyError::LocalhostNotAllowed => {
            "Localhost addresses are not allowed for web previews".into()
        }
        PolicyError::BlockedAddress => {
            "Private or local network targets are not allowed for web previews".into()
        }
        PolicyError::NoResolvedAddresses => "Unable to resolve remote host".into(),
        PolicyError::MissingRedirectLocation => {
            "Redirect response did not include a valid Location header".into()
        }
        PolicyError::TooManyRedirects => "Too many redirects while fetching web preview".into(),
        PolicyError::ResponseTooLarge => "Remote page is too large to preview safely".into(),
    }
}

fn calendar_policy_error(error: PolicyError) -> String {
    match error {
        PolicyError::EmptyUrl | PolicyError::InvalidUrl => "Enter a valid HTTPS URL".into(),
        PolicyError::SchemeNotAllowed => "Calendar subscriptions require HTTPS".into(),
        PolicyError::CredentialsNotAllowed => {
            "Calendar feed URLs cannot contain embedded credentials".into()
        }
        PolicyError::MissingHost => "URL must include a hostname".into(),
        PolicyError::LocalhostNotAllowed | PolicyError::BlockedAddress => {
            "Private or local network targets are not allowed for calendar feeds".into()
        }
        PolicyError::NoResolvedAddresses => "Unable to resolve calendar feed host".into(),
        PolicyError::MissingRedirectLocation => "Calendar feed redirect is missing Location".into(),
        PolicyError::TooManyRedirects => "Calendar feed redirected too many times".into(),
        PolicyError::ResponseTooLarge => "Calendar feed exceeds the 5 MB response limit".into(),
    }
}

fn policy_with_local_targets(mut policy: OutboundPolicy, allow: bool) -> OutboundPolicy {
    policy.allow_localhost = allow;
    policy.allow_private_networks = allow;
    policy
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
        let url = Url::parse(&raw).or_else(|_| base.join(&raw)).ok()?;
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
            return (
                false,
                Some("This site forbids framing with X-Frame-Options: DENY.".into()),
            );
        }
        if normalized.contains("sameorigin") {
            return (
                false,
                Some("This site only allows embedding on its own domain.".into()),
            );
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
                return (
                    false,
                    Some("This site blocks all framing via Content Security Policy.".into()),
                );
            }
            if frame_ancestors.contains("'self'") {
                return (
                    false,
                    Some("This site only allows embedding on its own origin.".into()),
                );
            }

            let origin = resolved_url.origin().ascii_serialization();
            if !frame_ancestors.contains('*') && !frame_ancestors.contains(&origin) {
                return (
                    false,
                    Some("This site restricts which origins may embed it.".into()),
                );
            }
        }
    }

    (true, None)
}

async fn read_limited_text_body(
    response: &mut Response,
    max_bytes: usize,
) -> Result<String, String> {
    let mut budget =
        ResponseBudget::new(max_bytes, response.content_length()).map_err(preview_policy_error)?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        budget.consume(chunk.len()).map_err(preview_policy_error)?;
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
            let favicon_url = resolved_url
                .join("/favicon.ico")
                .ok()
                .map(|url| url.to_string());
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

        let title = first_meta_content(
            &document,
            &[
                r#"meta[property="og:title"]"#,
                r#"meta[name="twitter:title"]"#,
            ],
        )
        .or_else(|| document_title(&document));

        let description = first_meta_content(
            &document,
            &[
                r#"meta[property="og:description"]"#,
                r#"meta[name="twitter:description"]"#,
                r#"meta[name="description"]"#,
            ],
        );

        let site_name = first_meta_content(
            &document,
            &[
                r#"meta[property="og:site_name"]"#,
                r#"meta[name="application-name"]"#,
            ],
        )
        .or_else(|| resolved_url.domain().map(|domain| domain.to_string()));

        let image_url = resolve_optional_url(
            &resolved_url,
            first_meta_content(
                &document,
                &[
                    r#"meta[property="og:image"]"#,
                    r#"meta[name="twitter:image"]"#,
                    r#"meta[name="twitter:image:src"]"#,
                ],
            ),
        );

        let favicon_url = resolve_optional_url(
            &resolved_url,
            first_href(
                &document,
                &[
                    r#"link[rel="icon"]"#,
                    r#"link[rel="shortcut icon"]"#,
                    r#"link[rel="apple-touch-icon"]"#,
                ],
            )
            .or_else(|| {
                resolved_url
                    .join("/favicon.ico")
                    .ok()
                    .map(|url| url.to_string())
            }),
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
    let initial_policy = policy_with_local_targets(WEB_PREVIEW_POLICY, allow_initial_local_target);
    let normalized = normalize_http_input(&url, true).map_err(preview_policy_error)?;
    let normalized = validate_target(&normalized, initial_policy)
        .map_err(preview_policy_error)?
        .url;
    let mut current_url = normalized;
    for redirects_followed in 0..=WEB_PREVIEW_POLICY.limits.max_redirects {
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
                .and_then(|value| value.to_str().ok());
            let redirect_policy =
                policy_with_local_targets(WEB_PREVIEW_POLICY, allow_redirect_local_targets);
            let next_url =
                resolve_redirect(&current_url, location, redirects_followed, redirect_policy)
                    .map_err(preview_policy_error)?
                    .url;
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
    build_policy_client(WEB_PREVIEW_POLICY.limits, None)
}

fn build_policy_client(
    limits: RequestLimits,
    pinned_target: Option<(&str, &[SocketAddr])>,
) -> Result<Client, String> {
    let mut builder = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(limits.connect_timeout)
        .timeout(limits.request_timeout);
    if let Some((host, addresses)) = pinned_target {
        builder = builder.resolve_to_addrs(host, addresses);
    }
    builder.build().map_err(|error| error.to_string())
}

fn build_pinned_preview_client(addrs: &[SocketAddr], host: &str) -> Result<Client, String> {
    build_policy_client(WEB_PREVIEW_POLICY.limits, Some((host, addrs)))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarFeedResponse {
    pub resolved_url: String,
    pub not_modified: bool,
    pub content: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

fn calendar_header(response: &Response, name: reqwest::header::HeaderName) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

async fn fetch_calendar_feed_with_policy(
    url: String,
    etag: Option<String>,
    last_modified: Option<String>,
    allow_local_targets: bool,
) -> Result<CalendarFeedResponse, String> {
    let policy = policy_with_local_targets(CALENDAR_FEED_POLICY, allow_local_targets);
    let mut current_url = normalize_http_input(&url, false).map_err(calendar_policy_error)?;
    validate_target(&current_url, policy).map_err(calendar_policy_error)?;
    let validator_url = current_url.clone();

    for redirects_followed in 0..=policy.limits.max_redirects {
        let addrs = if allow_local_targets {
            Vec::new()
        } else {
            resolve_and_validate_target_with_policy(&current_url, policy)
                .await
                .map_err(calendar_policy_error)?
        };
        let client = if allow_local_targets {
            build_policy_client(policy.limits, None)?
        } else {
            let target = validate_target(&current_url, policy).map_err(calendar_policy_error)?;
            build_policy_client(policy.limits, Some((&target.host, &addrs)))?
        };
        let mut request = client
            .get(current_url.clone())
            .header(USER_AGENT, "Collab/0.6 (+calendar-subscription)")
            .header(
                reqwest::header::ACCEPT,
                "text/calendar, text/plain;q=0.9, application/octet-stream;q=0.5",
            );
        if sensitive_header_decision(&validator_url, &current_url)
            == SensitiveHeaderDecision::Forward
        {
            if let Some(value) = etag.as_deref() {
                request = request.header(IF_NONE_MATCH, value);
            }
            if let Some(value) = last_modified.as_deref() {
                request = request.header(IF_MODIFIED_SINCE, value);
            }
        }
        let mut response = request.send().await.map_err(|error| error.to_string())?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok());
            let next_url = resolve_redirect(&current_url, location, redirects_followed, policy)
                .map_err(calendar_policy_error)?
                .url;
            if !allow_local_targets {
                resolve_and_validate_target_with_policy(&next_url, policy)
                    .await
                    .map_err(calendar_policy_error)?;
            }
            current_url = next_url;
            continue;
        }
        let response_etag = calendar_header(&response, ETAG);
        let response_last_modified = calendar_header(&response, LAST_MODIFIED);
        if response.status() == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(CalendarFeedResponse {
                resolved_url: current_url.to_string(),
                not_modified: true,
                content: None,
                etag: response_etag.or(etag),
                last_modified: response_last_modified.or(last_modified),
            });
        }
        response = response
            .error_for_status()
            .map_err(|error| error.to_string())?;
        let content = read_limited_text_body(&mut response, policy.limits.max_response_bytes)
            .await
            .map_err(|_| "Calendar feed exceeds the 5 MB response limit or is not UTF-8")?;
        if !content
            .trim_start_matches('\u{feff}')
            .trim_start()
            .to_ascii_uppercase()
            .starts_with("BEGIN:VCALENDAR")
        {
            return Err("The remote response is not an iCalendar feed".into());
        }
        return Ok(CalendarFeedResponse {
            resolved_url: current_url.to_string(),
            not_modified: false,
            content: Some(content),
            etag: response_etag,
            last_modified: response_last_modified,
        });
    }
    Err("Calendar feed redirected too many times".into())
}

#[tauri::command]
pub async fn fetch_calendar_feed(
    url: String,
    etag: Option<String>,
    last_modified: Option<String>,
) -> Result<CalendarFeedResponse, String> {
    fetch_calendar_feed_with_policy(url, etag, last_modified, false).await
}

#[tauri::command]
pub async fn fetch_link_preview(url: String) -> Result<LinkPreviewData, String> {
    let client = build_preview_client()?;
    fetch_link_preview_with_client(&client, url, false, false).await
}

#[cfg(test)]
mod tests {
    use super::{
        classify_embed_policy, document_title, fetch_calendar_feed_with_policy,
        fetch_link_preview_with_client, first_href, first_meta_content, is_blocked_ip,
        normalize_input_url, read_limited_text_body, resolve_and_validate_target,
        resolve_optional_url, validate_url_syntax_for_preview, MAX_HTML_PREVIEW_BYTES,
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
        let file =
            normalize_input_url("file:///tmp/test.html").expect_err("file scheme should fail");

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

    #[tokio::test]
    async fn calendar_feeds_require_public_credential_free_https_targets() {
        assert!(fetch_calendar_feed_with_policy(
            "http://example.com/calendar.ics".into(),
            None,
            None,
            false,
        )
        .await
        .unwrap_err()
        .contains("require HTTPS"));
        assert!(fetch_calendar_feed_with_policy(
            "https://user:secret@example.com/calendar.ics".into(),
            None,
            None,
            false,
        )
        .await
        .unwrap_err()
        .contains("embedded credentials"));
        assert!(fetch_calendar_feed_with_policy(
            "https://127.0.0.1/calendar.ics".into(),
            None,
            None,
            false,
        )
        .await
        .unwrap_err()
        .contains("Private or local"));
    }

    #[test]
    fn blocked_ip_rules_cover_reserved_and_mapped_ranges() {
        let shared = "100.64.0.1".parse::<IpAddr>().expect("ip should parse");
        let benchmark = "198.18.0.10".parse::<IpAddr>().expect("ip should parse");
        let reserved = "240.0.0.1".parse::<IpAddr>().expect("ip should parse");
        let mapped_loopback = "::ffff:127.0.0.1"
            .parse::<IpAddr>()
            .expect("ip should parse");
        let mapped_private = "::ffff:10.0.0.1"
            .parse::<IpAddr>()
            .expect("ip should parse");
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
        let csp_none = classify_embed_policy(
            &url,
            None,
            Some("default-src 'self'; frame-ancestors 'none'"),
        );
        let csp_other =
            classify_embed_policy(&url, None, Some("frame-ancestors https://another.example"));

        assert_eq!(deny.0, false);
        assert!(deny.1.unwrap_or_default().contains("DENY"));
        assert_eq!(sameorigin.0, false);
        assert!(sameorigin.1.unwrap_or_default().contains("own domain"));
        assert_eq!(csp_none.0, false);
        assert!(csp_none
            .1
            .unwrap_or_default()
            .contains("blocks all framing"));
        assert_eq!(csp_other.0, false);
        assert!(csp_other
            .1
            .unwrap_or_default()
            .contains("restricts which origins"));
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
        let absolute =
            resolve_optional_url(&base, Some("https://cdn.example.com/image.png".into()));
        let invalid = resolve_optional_url(&base, Some("::not a url::".into()));
        let file_scheme = resolve_optional_url(&base, Some("file:///tmp/secret.png".into()));
        let data_scheme = resolve_optional_url(&base, Some("data:image/png;base64,abcd".into()));

        assert_eq!(relative.as_deref(), Some("https://example.com/favicon.ico"));
        assert_eq!(
            absolute.as_deref(),
            Some("https://cdn.example.com/image.png")
        );
        assert_eq!(
            invalid.as_deref(),
            Some("https://example.com/path/::not%20a%20url::")
        );
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
        assert_eq!(
            preview.favicon_url.as_deref(),
            Some(expected_favicon.as_str())
        );
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
        let preview =
            fetch_link_preview_with_client(&client, server.url("/files/manual.pdf"), true, true)
                .await
                .expect("non-html preview should fetch");

        asset.assert();
        assert_eq!(preview.resolved_url, server.url("/files/manual.pdf"));
        assert_eq!(preview.title.as_deref(), Some("manual.pdf"));
        assert_eq!(preview.site_name, None);
        let expected_favicon = server.url("/favicon.ico");
        assert_eq!(
            preview.favicon_url.as_deref(),
            Some(expected_favicon.as_str())
        );
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
            then.status(200).header("content-type", "text/html").body(
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
        let preview =
            fetch_link_preview_with_client(&client, server.url("/article/read_me"), true, true)
                .await
                .expect("html preview should fetch");

        page.assert();
        let expected_image = server.url("/images/preview-card.jpg");
        let expected_favicon = server.url("/favicon.ico");
        assert_eq!(preview.title.as_deref(), Some("Readable Article"));
        assert_eq!(preview.description.as_deref(), Some("Simple summary"));
        assert_eq!(preview.image_url.as_deref(), Some(expected_image.as_str()));
        assert_eq!(
            preview.favicon_url.as_deref(),
            Some(expected_favicon.as_str())
        );
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
            then.status(302)
                .header("location", "http://127.0.0.1/internal");
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
