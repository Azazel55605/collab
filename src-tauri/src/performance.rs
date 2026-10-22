//! Explicit diagnostics only: bounded timing records, no payloads, paths or tokens.
use serde::Serialize;
use std::{
    collections::VecDeque,
    sync::{LazyLock, Mutex},
    time::Instant,
};
static ENABLED: LazyLock<bool> =
    LazyLock::new(|| std::env::var("COLLAB_PERFORMANCE_DIAGNOSTICS").is_ok_and(|v| v == "1"));
static RUN_ID: LazyLock<String> = LazyLock::new(|| uuid::Uuid::new_v4().to_string());
static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
pub(crate) fn initialize() {
    if *ENABLED {
        START.get_or_init(Instant::now);
    }
}
static DROPPED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static EVENTS: Mutex<VecDeque<Event>> = Mutex::new(VecDeque::new());
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    operation: &'static str,
    millis: f64,
}
pub(crate) struct Span(Option<(&'static str, Instant)>);
pub(crate) fn span(operation: &'static str) -> Span {
    Span(if *ENABLED {
        Some((operation, Instant::now()))
    } else {
        None
    })
}
impl Drop for Span {
    fn drop(&mut self) {
        if let Some((operation, start)) = self.0 {
            if let Ok(mut events) = EVENTS.lock() {
                if events.len() >= 2048 {
                    events.pop_front();
                    DROPPED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                }
                events.push_back(Event {
                    operation,
                    millis: start.elapsed().as_secs_f64() * 1000.,
                });
            }
        }
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    dropped_events: u64,
    app_version: &'static str,
    run_id: Option<String>,
    elapsed_millis: f64,
    enabled: bool,
    platform: &'static str,
    rss_bytes: Option<u64>,
    peak_rss_bytes: Option<u64>,
    events: Vec<Event>,
}
#[tauri::command]
pub fn performance_snapshot() -> Snapshot {
    let mut rss = None;
    let mut peak = None;
    #[cfg(target_os = "linux")]
    if *ENABLED {
        if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
            for line in status.lines() {
                let value = line
                    .split_whitespace()
                    .nth(1)
                    .and_then(|v| v.parse::<u64>().ok())
                    .map(|v| v * 1024);
                if line.starts_with("VmRSS:") {
                    rss = value
                } else if line.starts_with("VmHWM:") {
                    peak = value
                }
            }
        }
    }
    #[cfg(target_os = "windows")]
    if *ENABLED {
        unsafe {
            use windows_sys::Win32::System::{
                ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
                Threading::GetCurrentProcess,
            };
            let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
            counters.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            if K32GetProcessMemoryInfo(
                GetCurrentProcess(),
                &mut counters,
                std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32,
            ) != 0
            {
                rss = Some(counters.WorkingSetSize as u64);
                peak = Some(counters.PeakWorkingSetSize as u64);
            }
        }
    }
    #[cfg(target_os = "macos")]
    if *ENABLED {
        unsafe {
            let mut info: libc::mach_task_basic_info = std::mem::zeroed();
            let mut count = libc::MACH_TASK_BASIC_INFO_COUNT;
            if libc::task_info(
                libc::mach_task_self(),
                libc::MACH_TASK_BASIC_INFO,
                (&mut info as *mut libc::mach_task_basic_info).cast(),
                &mut count,
            ) == libc::KERN_SUCCESS
            {
                rss = Some(info.resident_size);
                peak = Some(info.resident_size_max);
            }
        }
    }

    Snapshot {
        dropped_events: DROPPED.swap(0, std::sync::atomic::Ordering::Relaxed),
        app_version: env!("CARGO_PKG_VERSION"),
        run_id: if *ENABLED { Some(RUN_ID.clone()) } else { None },
        elapsed_millis: START
            .get()
            .map(|s| s.elapsed().as_secs_f64() * 1000.)
            .unwrap_or(0.),
        enabled: *ENABLED,
        platform: std::env::consts::OS,
        rss_bytes: rss,
        peak_rss_bytes: peak,
        events: if *ENABLED {
            EVENTS
                .lock()
                .map(|mut e| e.drain(..).collect())
                .unwrap_or_default()
        } else {
            vec![]
        },
    }
}
#[cfg(test)]
mod tests {
    #[test]
    fn disabled_diagnostics_dont_collect_or_read_resources() {
        if !*super::ENABLED {
            let _span = super::span("test");
            let snapshot = super::performance_snapshot();
            assert!(!snapshot.enabled);
            assert!(snapshot.events.is_empty());
            assert!(snapshot.rss_bytes.is_none());
        }
    }
    #[test]
    fn enabled_native_capture_reports_process_resources_and_bounded_spans() {
        if *super::ENABLED {
            super::initialize();
            {
                let _trace = super::span("diagnostics.validation");
            }
            let snapshot = super::performance_snapshot();
            assert!(snapshot.enabled);
            assert!(snapshot.run_id.is_some());
            #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
            assert!(snapshot.rss_bytes.is_some_and(|v| v > 0));
            assert!(snapshot
                .events
                .iter()
                .any(|e| e.operation == "diagnostics.validation"));
            println!(
                "native diagnostic capture: {}",
                serde_json::to_string(&snapshot).unwrap()
            );
        }
    }
}
