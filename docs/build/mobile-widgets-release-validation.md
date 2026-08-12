# Mobile Widgets Release Validation

## Scope

Eight Android launcher widgets: agenda, month, birthday, countdown, tasks,
quick capture, vault shortcuts, and sync status. All eight are opt-in — nothing
is placed without the user adding it — and all eight render through the shared
Glance primitives in `CollabAgendaWidget.kt` against snapshots built in Rust.

The launcher process makes no network request, starts no webview, and holds no
credential. A widget reads a published snapshot and prepares an allow-listed
destination; everything else happens in the app or the native coordinator.

This document is the Phase 8 gate. Automated coverage is listed first because
it is what CI enforces; the physical matrix below cannot be automated and must
be recorded before a Play release.

## What Automation Covers

| Suite | Command | Covers |
| --- | --- | --- |
| Rust widget tests | `cd src-tauri && cargo test widgets` | Snapshot builders, every privacy mode, source filtering, action validation, configuration migration, cleanup, sync rollup precedence, task completion idempotency |
| Rust workspace | `cargo test --workspace` | Shared calendar, replica, and document crates the snapshots are built from |
| Android unit tests | `./gradlew :app:testUniversalDebugUnitTest` | Snapshot parsing bounds, configuration mapping, destination validation, responsive layout selection, palette tokens, update coalescing, change-gated rendering |
| Mobile frontend | `pnpm test` (mobile suites) | Every destination, setup and management path, missing-target recovery |
| Types | `pnpm exec tsc --noEmit` | Shared widget/destination contracts |
| Android build | `./gradlew :app:assembleUniversalDebug` and the release variant | Manifest merge with eight registered providers, preview layout inflation |

Android builds here need a JDK the bundled Kotlin compiler can parse. JDK 26
fails during `:buildSrc` configuration with `IllegalArgumentException: 26.0.2`;
build with JDK 21:

```bash
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
export ANDROID_HOME="$HOME/Android/Sdk"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/$(ls "$ANDROID_HOME/ndk" | sort -V | tail -n 1)"
cd src-tauri/gen/android && ./gradlew :app:testUniversalDebugUnitTest
```

## Platform Limitations

- Launchers are not uniform. Not every launcher honours every size in
  `SizeMode.Responsive`, and some ignore dynamic colour entirely. Record what
  each tested launcher actually does rather than assuming the Pixel behaviour.
- `RemoteViews` inflates only annotated view classes. Picker previews under
  `res/layout/collab_*_widget_preview.xml` must use views `RemoteViews` can
  inflate — a bare `<View>` compiles and links but fails in the launcher,
  showing a broken picker entry.
- Widget updates are push-published, not polled. A change made while the app is
  stopped surfaces when the background coordinator completes; the 30-minute
  periodic refresh is a fallback for a profile nothing else reached, not the
  normal path.
- Launcher `Sync now` enqueues the same unique WorkManager chain the app uses.
  Under Doze or battery saver the run is deferred by the platform. The widget
  reports only that the request was accepted — it must never render optimistic
  state.

## Physical And Launcher Matrix

Record the device, Android version, and launcher for every row.

### Placement and lifecycle

- [X] Add, resize, reconfigure, duplicate, and remove each of the eight widgets.
- [X] Launcher restart, app process death, force-stop, reboot, and app update.
- [X] Restore from backup: no widget data reappears for a removed profile.
- [X] Profile removal cancels scheduled work and clears published snapshots.
- [X] Supported minimum Android version plus the current Android release.
- [X] Pixel Launcher plus at least one major OEM launcher.

### Data and state

- [ ] Offline-to-online transition; signed-out hosted source alongside a local
      source; the rollup stays honest while a profile is signed out.
- [X] Doze, battery saver, background restriction, and low storage.
- [X] Timezone and DST changes; locale and 12/24-hour changes.
- [X] Locked-device privacy behaviour at every privacy level.
- [X] Stale cached data still renders an honest last-updated or
      action-required state rather than silently showing old content as current.

### Update latency

- [ ] A calendar edit, a task completion, and a completed sync each reach a
      placed widget promptly with the app foregrounded. Record the times.
- [ ] The same three with the app stopped, via the background coordinator.
- [X] A refresh that changes nothing re-renders nothing (no visible repaint,
      no launcher churn).
- [X] Boot and a time change still repaint every placed widget, because state
      equality proves nothing after the launcher may have lost our views.
- [X] Repeated `Sync now` taps produce exactly one run.
- [ ] `Sync now` actually enqueues with charging and battery-not-low enabled in
      background settings. WorkManager rejects an expedited request carrying a
      power constraint, so this combination is the one that used to fail with
      "Expedited jobs only support network and storage constraints".
- [ ] The widget reports a rejected sync request as a failure, never as
      "Sync requested."
- [X] Crossing midnight with a month widget placed moves the today marker and
      leaves no marker behind on the previous day. A launcher reapplies views it
      already holds, so this cannot be confirmed from a fresh placement — leave
      the widget in place across the day boundary.
- [ ] Stepping through months with the arrows repaints without a perceptible
      wait, including on the first tap after the app process has been killed.

### Sync progress

- [X] While a real multi-file sync runs: the sync widget names what it is on and
      shows a moving bar; the in-app banner on Vaults and Servers shows the same;
      and an ongoing notification appears with a progress bar.
- [X] A sync that reconciles nothing posts no notification at all (the
      `SYNC_NOTIFICATION_DELAY` gate).
- [ ] The notification clears on success, on failure, and on cancellation — and
      when two runs overlap, whichever finishes last clears it.
- [ ] Opening the app mid-sync shows the banner immediately rather than after
      the next progress tick.
- [ ] A run that reports no total renders as indeterminate everywhere (widget,
      banner, notification) rather than as 0%.
- [ ] No file path, folder name, server URL, or account appears in the
      notification on a lock screen, or anywhere in the widget.

### Accessibility and presentation

- [ ] TalkBack labels on every row and control.
- [X] Minimum touch targets, font scaling, contrast.
- [X] Light and dark themes; truncation at every supported size.
- [ ] Picker previews match what the placed widget actually renders.
      - [ ] Tasks: glyphs carry their calendar colour, including for tasks the
            launcher cannot complete (Kanban assignments, recurring occurrences,
            read-only calendars). At reduced privacy levels Rust strips source
            colours, so a grey list there is correct, not a regression.
      - [ ] Sync: the preview shows the resting state with no progress track.
            Per-vault rows appear only for vaults with an offline copy, and only
            at 90dp or taller — confirm against a profile that has both.

### Measurement

- [X] Battery and wakeup measurements showing no per-widget polling.
- [X] No hidden webview startup during launcher rendering.

## Release Gates

- [ ] The background-running physical validation is complete enough to trust
      the coordinator outcomes the sync widget reports.
- [ ] No widget snapshot, log, backup, intent, or Android preview contains a
      token, a server URL, an unapproved private title, or a document body.
      Hosted accounts appear only as `account-{hash(serverUrl)}`.
- [ ] Widget data is removed on account or profile deletion and does not
      reappear after boot, app update, retry, or a stale WorkManager completion.
- [ ] Play release documentation covers widget declarations, backup and data
      handling, screenshots, privacy disclosures, and launcher-specific
      limitations.

## Related Documents

- [Mobile Widgets Plan](../plans/mobile-widgets-plan.md)
- [Background Running Release Validation](./background-running-release-validation.md)
- [Android Companion Build](../mobile/android-companion-build.md)
