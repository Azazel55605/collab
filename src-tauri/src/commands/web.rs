use std::time::Duration;

use reqwest::header::{CONTENT_TYPE, USER_AGENT};
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
        Url::parse(&raw)
            .or_else(|_| base.join(&raw))
            .ok()
            .map(|url| url.to_string())
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

#[tauri::command]
pub async fn fetch_link_preview(url: String) -> Result<LinkPreviewData, String> {
    let normalized = normalize_input_url(&url)?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    let response = client
        .get(normalized.clone())
        .header(USER_AGENT, "Collab/0.2 (+canvas-web-card)")
        .send()
        .await
        .map_err(|e| e.to_string())?;

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

    if !content_type.contains("text/html") {
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

    let html = response.text().await.map_err(|e| e.to_string())?;
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
