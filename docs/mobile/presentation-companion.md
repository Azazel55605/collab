# Presentation Companion (`.deck` on Android)

The Android companion opens Collab presentations to **view, read notes,
present, and remote-control a show**. It never composes slides and never writes
a `.deck`: the desktop editor stays the only place a deck changes. This is
Phase 8 of the [presentation plan](../plans/presentation-tool-plan.md).

Phase 10 shares the slide's bounded semantic companion with Android: TalkBack
receives one named entry per resolved object in the authored reading order,
while the visual SVG stays deterministic. It does not create accessibility
nodes for every table cell, chart point, or glyph.

## What it does

| Feature             | Behaviour                                                                                                                                                         |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open                | Tapping a `.deck` (by document type or extension) opens the presentation screen.                                                                                  |
| Offline             | Reads through the server and warms the replica cache; with no connection it opens the cached copy (shown by the offline icon).                                    |
| Images              | Each image the deck draws is found by its vault path and read through the normal asset path (network, then cached bytes).                                         |
| Missing images      | Drawn as placeholders, with a banner saying how many; a missing image never stops the deck opening.                                                               |
| Slide list          | Windowed thumbnails (only the rows near the screen mount), section names, hidden slides dimmed; 1–4 columns by width.                                             |
| Slide view          | The slide fitted to the screen; pinch zoom (100–500%) about the fingers, drag to pan when zoomed, double-tap to zoom in or back to fit.                           |
| Navigation          | Swipe at fit, or the toolbar buttons; every slide, including hidden ones, can be browsed.                                                                         |
| Speaker notes       | Under the slide in portrait, beside it in short landscape; formatting and list labels kept.                                                                       |
| Present             | Full-screen black show with the desktop's playback rules: hidden slides skipped, object builds and transitions played, tap/swipe navigation, end screen.          |
| Live                | On a connection the screen joins the deck's live room read-only: collaborators' edits appear as they are made.                                                    |
| Follow              | When someone presents the deck, **Follow** keeps this phone on the slide they show.                                                                               |
| Remote control      | With **Phone remote** on, the app discovers your computer from any screen, shows a floating bubble, and opens Previous/Next, blanking, notes, and a motion laser. |
| Direct control      | The phone prefers an encrypted WebRTC data channel on the same network and visibly falls back to the existing server relay when it cannot connect.                |
| Start on computer   | An opted-in computer already viewing the deck can be asked from the phone to begin its default presentation mode.                                                 |
| Process recreation  | The slide, view, notes panel, zoom, and pan are kept per file in `sessionStorage` and restored when Android recreates the activity.                               |
| Read-only and newer | Every role can view. A deck from a newer Collab opens with a notice; the live room is not joined for it.                                                          |

## Remote control

The presenter opts in per desktop view: the **Phone remote** button (phone icon)
in the slide show and presenter-view control bars. The protocol is
`src/lib/deck/remote.ts`, carried by the existing live awareness relay:

1. Sign in to the desktop and Android companion with the same account. The
   Android app can be on any screen; the deck does not need to be open there.
2. Start the desktop slide show or presenter view for a hosted deck, then turn on **Phone remote**
   in its controls. It is deliberately off for every new show.
3. The desktop refreshes a short-lived account-scoped advertisement. Android
   polls each connected account from the app shell and shows a floating remote
   bubble. Tapping it opens the exact server, vault, and deck, then enters the
   existing remote as soon as its live awareness snapshot arrives.
4. Ending the show, closing its live session, or turning **Phone remote** off
   removes the bubble on the next poll. A crashed presenter ages out after 20
   seconds.

Discovery and WebRTC signaling use server-relayed live presence; control data
uses an encrypted peer-to-peer WebRTC channel when the two devices can reach
one another, normally on the same LAN. The UI reports **Direct connection**,
**Connecting directly**, or **Server relay**. This is not Bluetooth, mDNS, or a
permanent pairing: a hosted live room is still required to discover and
authenticate the peer. A local-only desktop vault has no phone discovery path.

- the presenter publishes the running show — a fresh id per show, stable
  vault/file identity, the slide and position, and whether remote control is
  on — to an ephemeral same-account registry every five seconds;
- the phone publishes its last eight commands, numbered, for that show id;
- the presenter applies each command once, in order, and only while remote
  control is on — commands sent while it is off are consumed, never replayed;
- commands are accepted only from peers signed in as **the same account** as
  the presenter; the relay already limits the room to vault members, and this
  keeps another member from driving someone's show;
- commands name the show they are for, so nothing from an earlier show replays
  into a new one.
- WebRTC offers and answers are accepted only through the same-account live
  room, contain complete ICE candidates, and use host candidates only (no
  public STUN/TURN service); DTLS encrypts the direct data channel;
- the phone's **Motion laser** calibrates on activation, converts orientation
  changes to normalized slide coordinates at a bounded rate, and falls back to
  awareness updates if the direct channel is unavailable;
- **Present there** targets a particular awareness client. The desktop must
  have **Allow presentations to start from my phone** enabled and already have
  that deck open; requests are deduplicated and are not persisted.

Nothing in remote control writes to the deck.

## Implementation

| File                                                       | Role                                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/mobile-android/src/MobileApp.tsx`                    | App-wide discovery polling, floating remote bubble, and stable deck routing                     |
| `apps/mobile-android/src/screens/DeckScreen.tsx`           | The screen: load, live room, assets, list, slide view, present, follow, remote                  |
| `apps/mobile-android/src/components/DeckSlideFrame.tsx`    | Fitted slide with pinch, pan, double-tap, swipe, tap, transitions, and transient animation CSS  |
| `apps/mobile-android/src/components/DeckThumbnailGrid.tsx` | Windowed thumbnail grid                                                                         |
| `apps/mobile-android/src/lib/deck.ts`                      | File predicate, network-then-replica read, asset lookup, zoom/pan bounds, windowing, view state |
| `apps/mobile-android/src/lib/liveNote.ts`                  | `openMobileLiveDeckSession`: the read-only live room, decoded by the shared deck codec          |
| `src/lib/deck/remote.ts`                                   | Remote-control protocol shared by desktop and phone                                             |
| `src/lib/deck/directRemote.ts`                             | Bounded WebRTC messages, offer/answer creation, and ICE gathering                               |
| `src/lib/deck/activePresentation.ts`                       | Desktop heartbeat and cleanup for the account-scoped active-show advertisement                  |
| `crates/collab-server/src/presentations.rs`                | Bounded in-memory active-show registry with same-account filtering and automatic expiry         |

Rendering is the desktop's own: the shared resolver, `renderSlideSvg`, and
`DeckSlide` (inline, DOMPurify-sanitized SVG). Playback is `playback.ts`; build
steps and effect CSS are compiled by `animation.ts`. The phone has no copy of
the deck model.

## Release gate: physical devices

Unit and browser checks cover the logic, layout, and gestures (synthetic
pointers in Chromium at phone size). These need real hardware before release
and are not replaced by them:

- [ ] Memory: a 200-slide, image-heavy deck on a low-memory device (≤ 3 GB)
      scrolls the slide list and opens slides without being killed.
- [ ] Rotation: portrait ↔ landscape on the list, slide view (zoomed), notes,
      present, and remote screens keeps the slide and refits.
- [ ] Process recreation: with "Don't keep activities" on, leaving and
      returning restores the slide, notes panel, and zoom.
- [ ] Offline: with the vault available offline, airplane mode opens the deck
      and its images; an image not cached shows as a placeholder.
- [ ] Touch: pinch, pan, double-tap, and swipe feel right on at least one
      phone and one tablet; a stylus does not draw.
- [ ] Remote control: a desktop show driven from the phone over Wi-Fi and
      mobile data; latency acceptable; a second account's phone cannot drive it;
      turning Phone remote off stops it at once.
- [ ] Direct control: two devices on the same Wi-Fi report **Direct
      connection**; different subnets fall back to **Server relay** without
      losing commands.
- [ ] Motion laser: calibration, recentering, portrait/landscape orientation,
      sensor denial, jitter, and 10 minutes of continuous movement are usable
      on at least two Android vendors.
- [ ] Remote start: an opted-in desktop with the deck open starts exactly once;
      another account and an opted-out desktop ignore the request.
- [ ] Live: an edit made on the desktop appears on the phone during viewing.
