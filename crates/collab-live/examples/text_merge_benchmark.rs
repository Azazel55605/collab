//! Synthetic core benchmark; not a native WebView/RSS or end-to-end save measurement.
use std::{hint::black_box, time::Instant};

use collab_live::try_auto_merge_text;

fn main() {
    println!("scenario,lines,input_bytes,iterations,p50_us,p95_us,result");
    for lines in [1_000, 10_000] {
        let base = (0..lines)
            .map(|i| format!("line {i}\n"))
            .collect::<String>();
        for unrelated in [false, true] {
            let (ours, theirs) = if unrelated {
                ("ours\n".repeat(lines), "theirs\n".repeat(lines))
            } else {
                (
                    base.replace("line 10\n", "our change\n"),
                    base.replace(&format!("line {}\n", lines - 10), "their change\n"),
                )
            };
            let expected = (!unrelated)
                .then(|| ours.replace(&format!("line {}\n", lines - 10), "their change\n"));
            let mut timings = Vec::new();
            for _ in 0..25 {
                let start = Instant::now();
                let merged =
                    try_auto_merge_text(black_box(&base), black_box(&ours), black_box(&theirs));
                timings.push(start.elapsed().as_micros());
                assert_eq!(merged, expected);
                black_box(merged);
            }
            timings.sort_unstable();
            println!(
                "{},{},{},25,{},{},{}",
                if unrelated { "unrelated" } else { "sparse" },
                lines,
                base.len() + ours.len() + theirs.len(),
                timings[12],
                timings[23],
                if unrelated { "conflict" } else { "merged" }
            );
        }
    }
}
