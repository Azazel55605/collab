use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr},
    time::Duration,
};
use thiserror::Error;
use url::{Host, Url};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemePolicy {
    HttpAndHttps,
    HttpsOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RequestLimits {
    pub max_redirects: usize,
    pub max_response_bytes: usize,
    pub connect_timeout: Duration,
    pub request_timeout: Duration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutboundPolicy {
    pub schemes: SchemePolicy,
    pub allow_credentials: bool,
    pub allow_localhost: bool,
    pub allow_private_networks: bool,
    pub limits: RequestLimits,
}

pub const WEB_PREVIEW_POLICY: OutboundPolicy = OutboundPolicy {
    schemes: SchemePolicy::HttpAndHttps,
    allow_credentials: false,
    allow_localhost: false,
    allow_private_networks: false,
    limits: RequestLimits {
        max_redirects: 10,
        max_response_bytes: 512 * 1024,
        connect_timeout: Duration::from_secs(4),
        request_timeout: Duration::from_secs(8),
    },
};

pub const CALENDAR_FEED_POLICY: OutboundPolicy = OutboundPolicy {
    schemes: SchemePolicy::HttpsOnly,
    allow_credentials: false,
    allow_localhost: false,
    allow_private_networks: false,
    limits: RequestLimits {
        max_redirects: 5,
        max_response_bytes: 5 * 1024 * 1024,
        connect_timeout: Duration::from_secs(5),
        request_timeout: Duration::from_secs(15),
    },
};

pub const PUSH_GATEWAY_POLICY: OutboundPolicy = OutboundPolicy {
    schemes: SchemePolicy::HttpAndHttps,
    allow_credentials: false,
    allow_localhost: true,
    allow_private_networks: true,
    limits: RequestLimits {
        max_redirects: 0,
        max_response_bytes: 64 * 1024,
        connect_timeout: Duration::from_secs(10),
        request_timeout: Duration::from_secs(20),
    },
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedTarget {
    pub url: Url,
    pub host: String,
    pub port: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SensitiveHeaderDecision {
    Forward,
    Strip,
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum PolicyError {
    #[error("URL is required")]
    EmptyUrl,
    #[error("URL is invalid")]
    InvalidUrl,
    #[error("URL scheme is not allowed")]
    SchemeNotAllowed,
    #[error("embedded URL credentials are not allowed")]
    CredentialsNotAllowed,
    #[error("URL must include a hostname")]
    MissingHost,
    #[error("localhost targets are not allowed")]
    LocalhostNotAllowed,
    #[error("private or reserved network targets are not allowed")]
    BlockedAddress,
    #[error("remote host did not resolve to an address")]
    NoResolvedAddresses,
    #[error("redirect target is missing")]
    MissingRedirectLocation,
    #[error("redirect limit exceeded")]
    TooManyRedirects,
    #[error("response exceeds the configured byte limit")]
    ResponseTooLarge,
}

pub fn normalize_http_input(
    input: &str,
    infer_https_for_bare_input: bool,
) -> Result<Url, PolicyError> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(PolicyError::EmptyUrl);
    }
    Url::parse(trimmed)
        .or_else(|_| {
            if infer_https_for_bare_input {
                Url::parse(&format!("https://{trimmed}"))
            } else {
                Err(url::ParseError::RelativeUrlWithoutBase)
            }
        })
        .map_err(|_| PolicyError::InvalidUrl)
}

pub fn validate_target(url: &Url, policy: OutboundPolicy) -> Result<ValidatedTarget, PolicyError> {
    let scheme_allowed = match policy.schemes {
        SchemePolicy::HttpAndHttps => matches!(url.scheme(), "http" | "https"),
        SchemePolicy::HttpsOnly => url.scheme() == "https",
    };
    if !scheme_allowed {
        return Err(PolicyError::SchemeNotAllowed);
    }
    if !policy.allow_credentials && (!url.username().is_empty() || url.password().is_some()) {
        return Err(PolicyError::CredentialsNotAllowed);
    }

    let host = match url.host() {
        Some(Host::Domain(host)) => {
            if !policy.allow_localhost
                && (host.eq_ignore_ascii_case("localhost")
                    || host.to_ascii_lowercase().ends_with(".localhost"))
            {
                return Err(PolicyError::LocalhostNotAllowed);
            }
            host.to_owned()
        }
        Some(Host::Ipv4(address)) => {
            if !policy.allow_private_networks && is_blocked_ip(IpAddr::V4(address)) {
                return Err(PolicyError::BlockedAddress);
            }
            address.to_string()
        }
        Some(Host::Ipv6(address)) => {
            if !policy.allow_private_networks && is_blocked_ip(IpAddr::V6(address)) {
                return Err(PolicyError::BlockedAddress);
            }
            address.to_string()
        }
        None => return Err(PolicyError::MissingHost),
    };

    Ok(ValidatedTarget {
        url: url.clone(),
        host,
        port: url.port_or_known_default().unwrap_or(443),
    })
}

pub fn validate_resolved_addresses(
    addresses: impl IntoIterator<Item = SocketAddr>,
    policy: OutboundPolicy,
) -> Result<Vec<SocketAddr>, PolicyError> {
    let addresses = addresses.into_iter().collect::<Vec<_>>();
    if addresses.is_empty() {
        return Err(PolicyError::NoResolvedAddresses);
    }
    if !policy.allow_private_networks && addresses.iter().any(|address| is_blocked_ip(address.ip()))
    {
        return Err(PolicyError::BlockedAddress);
    }
    Ok(addresses)
}

pub fn resolve_redirect(
    current: &Url,
    location: Option<&str>,
    redirects_followed: usize,
    policy: OutboundPolicy,
) -> Result<ValidatedTarget, PolicyError> {
    if redirects_followed >= policy.limits.max_redirects {
        return Err(PolicyError::TooManyRedirects);
    }
    let location = location.ok_or(PolicyError::MissingRedirectLocation)?;
    let next = current
        .join(location)
        .or_else(|_| Url::parse(location))
        .map_err(|_| PolicyError::InvalidUrl)?;
    validate_target(&next, policy)
}

pub fn sensitive_header_decision(original: &Url, target: &Url) -> SensitiveHeaderDecision {
    if original.origin() == target.origin() {
        SensitiveHeaderDecision::Forward
    } else {
        SensitiveHeaderDecision::Strip
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResponseBudget {
    max_bytes: usize,
    consumed_bytes: usize,
}

impl ResponseBudget {
    pub fn new(max_bytes: usize, content_length: Option<u64>) -> Result<Self, PolicyError> {
        if content_length.is_some_and(|length| length > max_bytes as u64) {
            return Err(PolicyError::ResponseTooLarge);
        }
        Ok(Self {
            max_bytes,
            consumed_bytes: 0,
        })
    }

    pub fn consume(&mut self, bytes: usize) -> Result<(), PolicyError> {
        let next = self
            .consumed_bytes
            .checked_add(bytes)
            .ok_or(PolicyError::ResponseTooLarge)?;
        if next > self.max_bytes {
            return Err(PolicyError::ResponseTooLarge);
        }
        self.consumed_bytes = next;
        Ok(())
    }

    pub fn consumed_bytes(self) -> usize {
        self.consumed_bytes
    }

    pub fn remaining_bytes(self) -> usize {
        self.max_bytes.saturating_sub(self.consumed_bytes)
    }
}

pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(address) => is_blocked_ipv4(&address),
        IpAddr::V6(address) => is_blocked_ipv6(&address),
    }
}

fn is_blocked_ipv4(address: &Ipv4Addr) -> bool {
    let [first, second, ..] = address.octets();
    address.is_private()
        || address.is_loopback()
        || address.is_link_local()
        || address.is_broadcast()
        || address.is_multicast()
        || address.is_unspecified()
        || address.is_documentation()
        || (first == 100 && (64..=127).contains(&second))
        || (first == 198 && (18..=19).contains(&second))
        || first >= 240
}

fn is_blocked_ipv6(address: &Ipv6Addr) -> bool {
    if let Some(mapped) = address.to_ipv4_mapped() {
        return is_blocked_ipv4(&mapped);
    }
    address.is_loopback()
        || address.is_unspecified()
        || address.is_unique_local()
        || address.is_unicast_link_local()
        || address.is_multicast()
        || address.segments()[0..2] == [0x2001, 0x0db8]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_accept_only_their_declared_schemes_and_never_credentials() {
        let http = Url::parse("http://example.com/path").unwrap();
        let https = Url::parse("https://example.com/path").unwrap();
        let credentialed = Url::parse("https://user:secret@example.com/path").unwrap();

        assert!(validate_target(&http, WEB_PREVIEW_POLICY).is_ok());
        assert!(validate_target(&https, WEB_PREVIEW_POLICY).is_ok());
        assert_eq!(
            validate_target(&http, CALENDAR_FEED_POLICY),
            Err(PolicyError::SchemeNotAllowed)
        );
        assert_eq!(
            validate_target(&credentialed, CALENDAR_FEED_POLICY),
            Err(PolicyError::CredentialsNotAllowed)
        );
        assert!(validate_target(
            &Url::parse("http://push-gateway:8080/send").unwrap(),
            PUSH_GATEWAY_POLICY,
        )
        .is_ok());
        assert_eq!(
            validate_target(&credentialed, PUSH_GATEWAY_POLICY),
            Err(PolicyError::CredentialsNotAllowed)
        );
    }

    #[test]
    fn malformed_and_local_inputs_are_rejected_deterministically() {
        assert_eq!(
            normalize_http_input("  ", false),
            Err(PolicyError::EmptyUrl)
        );
        assert_eq!(
            normalize_http_input("not a URL", false),
            Err(PolicyError::InvalidUrl)
        );
        assert_eq!(
            validate_target(
                &Url::parse("file:///tmp/calendar.ics").unwrap(),
                CALENDAR_FEED_POLICY,
            ),
            Err(PolicyError::SchemeNotAllowed)
        );
        for value in [
            "https://localhost/feed.ics",
            "https://calendar.localhost/feed.ics",
            "https://127.0.0.1/feed.ics",
            "https://[::1]/feed.ics",
        ] {
            assert!(validate_target(&Url::parse(value).unwrap(), CALENDAR_FEED_POLICY).is_err());
        }
    }

    #[test]
    fn profiles_keep_bounded_redirect_response_and_timeout_limits() {
        assert_eq!(WEB_PREVIEW_POLICY.limits.max_redirects, 10);
        assert_eq!(WEB_PREVIEW_POLICY.limits.max_response_bytes, 512 * 1024);
        assert_eq!(
            WEB_PREVIEW_POLICY.limits.connect_timeout,
            Duration::from_secs(4)
        );
        assert_eq!(
            WEB_PREVIEW_POLICY.limits.request_timeout,
            Duration::from_secs(8)
        );

        assert_eq!(CALENDAR_FEED_POLICY.limits.max_redirects, 5);
        assert_eq!(
            CALENDAR_FEED_POLICY.limits.max_response_bytes,
            5 * 1024 * 1024
        );
        assert_eq!(
            CALENDAR_FEED_POLICY.limits.connect_timeout,
            Duration::from_secs(5)
        );
        assert_eq!(
            CALENDAR_FEED_POLICY.limits.request_timeout,
            Duration::from_secs(15)
        );

        assert_eq!(PUSH_GATEWAY_POLICY.limits.max_redirects, 0);
        assert_eq!(
            PUSH_GATEWAY_POLICY.limits.request_timeout,
            Duration::from_secs(20)
        );
    }

    #[test]
    fn blocks_reserved_ipv4_ipv6_and_ipv4_mapped_ranges() {
        for value in [
            "0.0.0.0",
            "10.0.0.1",
            "100.64.0.1",
            "127.0.0.1",
            "169.254.169.254",
            "192.0.2.1",
            "198.18.0.1",
            "224.0.0.1",
            "240.0.0.1",
            "::",
            "::1",
            "fc00::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
        ] {
            assert!(is_blocked_ip(value.parse().unwrap()), "{value}");
        }
        for value in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(!is_blocked_ip(value.parse().unwrap()), "{value}");
        }
    }

    #[test]
    fn resolved_targets_are_all_public_and_nonempty() {
        assert_eq!(
            validate_resolved_addresses([], WEB_PREVIEW_POLICY),
            Err(PolicyError::NoResolvedAddresses)
        );
        assert_eq!(
            validate_resolved_addresses(
                [
                    "93.184.216.34:443".parse().unwrap(),
                    "127.0.0.1:443".parse().unwrap(),
                ],
                WEB_PREVIEW_POLICY,
            ),
            Err(PolicyError::BlockedAddress)
        );
        assert_eq!(
            validate_resolved_addresses(
                ["93.184.216.34:443".parse().unwrap()],
                WEB_PREVIEW_POLICY,
            )
            .unwrap()
            .len(),
            1
        );
    }

    #[test]
    fn redirects_are_resolved_revalidated_and_bounded() {
        let current = Url::parse("https://example.com/a/start").unwrap();
        assert_eq!(
            resolve_redirect(&current, Some("../next"), 0, CALENDAR_FEED_POLICY)
                .unwrap()
                .url
                .as_str(),
            "https://example.com/next"
        );
        assert_eq!(
            resolve_redirect(
                &current,
                Some("http://example.com/insecure"),
                0,
                CALENDAR_FEED_POLICY,
            ),
            Err(PolicyError::SchemeNotAllowed)
        );
        assert_eq!(
            resolve_redirect(
                &current,
                Some("https://example.com/loop"),
                CALENDAR_FEED_POLICY.limits.max_redirects,
                CALENDAR_FEED_POLICY,
            ),
            Err(PolicyError::TooManyRedirects)
        );
    }

    #[test]
    fn cross_origin_redirects_strip_sensitive_headers() {
        let original = Url::parse("https://example.com/feed.ics").unwrap();
        let same_origin = Url::parse("https://example.com/other.ics").unwrap();
        let different_port = Url::parse("https://example.com:8443/other.ics").unwrap();
        let different_host = Url::parse("https://cdn.example.com/feed.ics").unwrap();

        assert_eq!(
            sensitive_header_decision(&original, &same_origin),
            SensitiveHeaderDecision::Forward
        );
        assert_eq!(
            sensitive_header_decision(&original, &different_port),
            SensitiveHeaderDecision::Strip
        );
        assert_eq!(
            sensitive_header_decision(&original, &different_host),
            SensitiveHeaderDecision::Strip
        );
    }

    #[test]
    fn response_budget_checks_advertised_streamed_and_overflow_sizes() {
        assert_eq!(
            ResponseBudget::new(10, Some(11)),
            Err(PolicyError::ResponseTooLarge)
        );
        let mut budget = ResponseBudget::new(10, None).unwrap();
        budget.consume(4).unwrap();
        budget.consume(6).unwrap();
        assert_eq!(budget.consumed_bytes(), 10);
        assert_eq!(budget.remaining_bytes(), 0);
        assert_eq!(budget.consume(1), Err(PolicyError::ResponseTooLarge));

        let mut overflow = ResponseBudget {
            max_bytes: usize::MAX,
            consumed_bytes: usize::MAX,
        };
        assert_eq!(overflow.consume(1), Err(PolicyError::ResponseTooLarge));
    }
}
