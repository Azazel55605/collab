use reqwest::{
    header::{ACCEPT, ETAG, IF_MODIFIED_SINCE, IF_NONE_MATCH, LAST_MODIFIED, LOCATION, USER_AGENT},
    Client, Response,
};
use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::Duration,
};
use tokio::net::lookup_host;
use url::{Host, Url};

const MAX_REDIRECTS: usize = 5;
const MAX_BYTES: usize = 5 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct CalendarFeedResponse {
    pub resolved_url: String,
    pub not_modified: bool,
    pub content: Option<String>,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
}

fn is_blocked_ipv4(ip: &Ipv4Addr) -> bool {
    let [first, second, ..] = ip.octets();
    ip.is_private()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_unspecified()
        || ip.is_documentation()
        || (first == 100 && (64..=127).contains(&second))
        || (first == 198 && (18..=19).contains(&second))
        || first >= 240
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
        IpAddr::V4(value) => is_blocked_ipv4(&value),
        IpAddr::V6(value) => is_blocked_ipv6(&value),
    }
}

fn validate_url(url: &Url) -> Result<(), String> {
    if url.scheme() != "https" {
        return Err("Calendar subscriptions require HTTPS.".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Calendar feed URLs cannot contain credentials.".into());
    }
    match url.host() {
        Some(Host::Domain(host))
            if host.eq_ignore_ascii_case("localhost") || host.ends_with(".localhost") =>
        {
            return Err("Calendar feed URLs cannot target localhost.".into());
        }
        Some(Host::Ipv4(ip)) if is_blocked_ipv4(&ip) => {
            return Err("Calendar feed URLs cannot target private or reserved networks.".into());
        }
        Some(Host::Ipv6(ip)) if is_blocked_ipv6(&ip) => {
            return Err("Calendar feed URLs cannot target private or reserved networks.".into());
        }
        None => {
            return Err("Calendar feed URL must include a hostname.".into());
        }
        _ => {}
    }
    Ok(())
}

fn host_name(url: &Url) -> Result<String, String> {
    match url.host() {
        Some(Host::Domain(value)) => Ok(value.to_owned()),
        Some(Host::Ipv4(value)) => Ok(value.to_string()),
        Some(Host::Ipv6(value)) => Ok(value.to_string()),
        None => Err("Calendar feed URL must include a hostname.".to_string()),
    }
}

async fn resolve_target(url: &Url) -> Result<Vec<SocketAddr>, String> {
    validate_url(url)?;
    let host = host_name(url)?;
    let port = url.port_or_known_default().unwrap_or(443);
    let addresses = lookup_host((host, port))
        .await
        .map_err(|_| "Unable to resolve the calendar feed host.".to_string())?
        .collect::<Vec<_>>();
    if addresses.is_empty() || addresses.iter().any(|address| is_blocked_ip(address.ip())) {
        return Err("Calendar feed URLs cannot target private or reserved networks.".into());
    }
    Ok(addresses)
}

fn client_for(url: &Url, addresses: &[SocketAddr]) -> Result<Client, String> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(15))
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
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BYTES as u64)
    {
        return Err("Calendar feed exceeds the 5 MB response limit.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Could not read the calendar feed response.".to_string())?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
            return Err("Calendar feed exceeds the 5 MB response limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "Calendar feeds must use UTF-8.".into())
}

pub async fn fetch_calendar_feed(
    feed_url: &str,
    etag: Option<&str>,
    last_modified: Option<&str>,
) -> Result<CalendarFeedResponse, String> {
    let mut current = Url::parse(feed_url.trim())
        .map_err(|_| "Calendar feed URL must be a valid HTTPS URL.".to_string())?;
    validate_url(&current)?;
    let validator_origin = current.origin();
    for _ in 0..=MAX_REDIRECTS {
        let addresses = resolve_target(&current).await?;
        let client = client_for(&current, &addresses)?;
        let mut request = client
            .get(current.clone())
            .header(USER_AGENT, "Collab-Server/0.6 (+calendar-subscription)")
            .header(
                ACCEPT,
                "text/calendar, text/plain;q=0.9, application/octet-stream;q=0.5",
            );
        if current.origin() == validator_origin {
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
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| "Calendar feed redirect is missing a location.".to_string())?;
            current = current
                .join(location)
                .or_else(|_| Url::parse(location))
                .map_err(|_| "Calendar feed redirect is invalid.".to_string())?;
            validate_url(&current)?;
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
    Err("Calendar feed redirected too many times.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
