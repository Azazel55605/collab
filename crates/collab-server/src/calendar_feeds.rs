use collab_net_policy::{
    normalize_http_input, resolve_redirect, sensitive_header_decision, validate_resolved_addresses,
    validate_target, PolicyError, ResponseBudget, SensitiveHeaderDecision, CALENDAR_FEED_POLICY,
};
use reqwest::{
    header::{ACCEPT, ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED, LOCATION, USER_AGENT},
    Client, Response,
};
use std::net::SocketAddr;
use tokio::net::lookup_host;
use url::Url;

#[derive(Debug, Clone)]
pub struct CalendarFeedResponse {
    pub resolved_url: String,
    pub not_modified: bool,
    pub content: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

fn validate_url(url: &Url) -> Result<(), String> {
    validate_target(url, CALENDAR_FEED_POLICY)
        .map(|_| ())
        .map_err(calendar_policy_error)
}

fn host_name(url: &Url) -> Result<String, String> {
    validate_target(url, CALENDAR_FEED_POLICY)
        .map(|target| target.host)
        .map_err(calendar_policy_error)
}

async fn resolve_target(url: &Url) -> Result<Vec<SocketAddr>, String> {
    let target = validate_target(url, CALENDAR_FEED_POLICY).map_err(calendar_policy_error)?;
    let addresses = lookup_host((target.host, target.port))
        .await
        .map_err(|_| calendar_policy_error(PolicyError::NoResolvedAddresses))?;
    validate_resolved_addresses(addresses, CALENDAR_FEED_POLICY).map_err(calendar_policy_error)
}

fn client_for(url: &Url, addresses: &[SocketAddr]) -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CALENDAR_FEED_POLICY.limits.connect_timeout)
        .timeout(CALENDAR_FEED_POLICY.limits.request_timeout)
        .resolve_to_addrs(&host_name(url)?, addresses)
        .build()
        .map_err(|_| "Could not initialize calendar feed networking.".into())
}

fn header(response: &Response, name: reqwest::header::HeaderName) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

async fn limited_text(response: &mut Response) -> Result<String, String> {
    let mut budget = ResponseBudget::new(
        CALENDAR_FEED_POLICY.limits.max_response_bytes,
        response.content_length(),
    )
    .map_err(calendar_policy_error)?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read the calendar feed response.".to_string())?
    {
        budget.consume(chunk.len()).map_err(calendar_policy_error)?;
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "Calendar feeds must use UTF-8.".into())
}

fn calendar_policy_error(error: PolicyError) -> String {
    match error {
        PolicyError::EmptyUrl | PolicyError::InvalidUrl => {
            "Calendar feed URL must be a valid HTTPS URL.".into()
        }
        PolicyError::SchemeNotAllowed => "Calendar subscriptions require HTTPS.".into(),
        PolicyError::CredentialsNotAllowed => {
            "Calendar feed URLs cannot contain credentials.".into()
        }
        PolicyError::MissingHost => "Calendar feed URL must include a hostname.".into(),
        PolicyError::LocalhostNotAllowed => "Calendar feed URLs cannot target localhost.".into(),
        PolicyError::BlockedAddress => {
            "Calendar feed URLs cannot target private or reserved networks.".into()
        }
        PolicyError::NoResolvedAddresses => "Unable to resolve the calendar feed host.".into(),
        PolicyError::MissingRedirectLocation => {
            "Calendar feed redirect is missing a location.".into()
        }
        PolicyError::TooManyRedirects => "Calendar feed redirected too many times.".into(),
        PolicyError::ResponseTooLarge => "Calendar feed exceeds the 5 MB response limit.".into(),
    }
}

pub async fn fetch_calendar_feed(
    feed_url: &str,
    etag: Option<&str>,
    last_modified: Option<&str>,
) -> Result<CalendarFeedResponse, String> {
    let mut current = normalize_http_input(feed_url, false).map_err(calendar_policy_error)?;
    validate_url(&current)?;
    let validator_url = current.clone();
    for redirects_followed in 0..=CALENDAR_FEED_POLICY.limits.max_redirects {
        let addresses = resolve_target(&current).await?;
        let client = client_for(&current, &addresses)?;
        let mut request = client
            .get(current.clone())
            .header(USER_AGENT, "Collab-Server/0.6 (+calendar-subscription)")
            .header(
                ACCEPT,
                "text/calendar, text/plain;q=0.9, application/octet-stream;q=0.5",
            );
        if sensitive_header_decision(&validator_url, &current) == SensitiveHeaderDecision::Forward {
            if let Some(value) = etag {
                request = request.header(IF_NONE_MATCH, value);
            }
            if let Some(value) = last_modified {
                request = request.header(IF_MODIFIED_SINCE, value);
            }
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| "Could not fetch the calendar feed.".to_string())?;
        if response.status().is_redirection() {
            let location = response
                .headers()
                .get(LOCATION)
                .and_then(|value| value.to_str().ok());
            current =
                resolve_redirect(&current, location, redirects_followed, CALENDAR_FEED_POLICY)
                    .map_err(calendar_policy_error)?
                    .url;
            continue;
        }
        let response_etag = header(&response, ETAG);
        let response_last_modified = header(&response, LAST_MODIFIED);
        if response.status() == reqwest::StatusCode::NOT_MODIFIED {
            return Ok(CalendarFeedResponse {
                resolved_url: current.to_string(),
                not_modified: true,
                content: None,
                etag: response_etag.or_else(|| etag.map(str::to_owned)),
                last_modified: response_last_modified.or_else(|| last_modified.map(str::to_owned)),
            });
        }
        response = response.error_for_status().map_err(|error| {
            format!(
                "Calendar feed returned HTTP {}.",
                error.status().map_or(0, |value| value.as_u16())
            )
        })?;
        let content = limited_text(&mut response).await?;
        if !content
            .trim_start_matches('\u{feff}')
            .trim_start()
            .to_ascii_uppercase()
            .starts_with("BEGIN:VCALENDAR")
        {
            return Err("The remote response is not an iCalendar feed.".into());
        }
        return Ok(CalendarFeedResponse {
            resolved_url: current.to_string(),
            not_modified: false,
            content: Some(content),
            etag: response_etag,
            last_modified: response_last_modified,
        });
    }
    Err(calendar_policy_error(PolicyError::TooManyRedirects))
}

#[cfg(test)]
mod tests {
    use super::*;
    use collab_net_policy::is_blocked_ip;

    #[test]
    fn blocks_credentials_and_non_public_targets() {
        for value in [
            "http://calendar.example/feed.ics",
            "https://user:pass@calendar.example/feed.ics",
            "https://localhost/feed.ics",
            "https://127.0.0.1/feed.ics",
            "https://[::1]/feed.ics",
            "https://100.64.0.1/feed.ics",
            "https://169.254.169.254/latest/meta-data/",
            "https://192.0.2.1/feed.ics",
            "https://198.18.0.1/feed.ics",
            "https://224.0.0.1/feed.ics",
            "https://[fc00::1]/feed.ics",
            "https://[fe80::1]/feed.ics",
            "https://[2001:db8::1]/feed.ics",
        ] {
            assert!(
                validate_url(&Url::parse(value).unwrap()).is_err(),
                "{value}"
            );
        }
        assert!(validate_url(&Url::parse("https://calendar.example/feed.ics").unwrap()).is_ok());
    }

    #[test]
    fn shared_ip_policy_matches_server_feed_policy() {
        assert!(is_blocked_ip("224.0.0.1".parse().unwrap()));
        assert!(is_blocked_ip("::ffff:127.0.0.1".parse().unwrap()));
        assert!(!is_blocked_ip("93.184.216.34".parse().unwrap()));
    }
}
