const byId = (id) => document.getElementById(id);
const media = byId('media');
const captions = byId('captions');
const audio = byId('audio');
const report = byId('report');
const fixture = byId('fixture');
const fixtureNames = ['large.mp4', 'tracks.mp4', 'video.webm', 'tone.mp3', 'tone.wav', 'tone.flac'];
for (const name of fixtureNames) fixture.add(new Option(name));

function refreshTracks() {
  const textTracks = Array.from(media.textTracks);
  captions.replaceChildren(new Option('Off', '-1'));
  textTracks.forEach((track, index) =>
    captions.add(new Option(track.label || track.language || `Caption ${index + 1}`, index)),
  );
  captions.value = String(textTracks.findIndex((track) => track.mode === 'showing'));
  const audioTracks = Array.from(media.audioTracks ?? []);
  audio.replaceChildren();
  audioTracks.forEach((track, index) =>
    audio.add(new Option(track.label || track.language || `Track ${index + 1}`, index)),
  );
  audio.disabled = audioTracks.length < 2;
  audio.value = String(audioTracks.findIndex((track) => track.enabled));
}

function selectCaption(index) {
  Array.from(media.textTracks).forEach((track, i) => {
    track.mode = i === index ? 'showing' : 'disabled';
  });
  refreshTracks();
}

function selectAudio(index) {
  Array.from(media.audioTracks ?? []).forEach((track, i) => {
    track.enabled = i === index;
  });
  refreshTracks();
}

function showTab(player) {
  if (!player) media.pause();
  byId('player').hidden = !player;
  byId('other').hidden = player;
  byId('player-tab').setAttribute('aria-current', String(player));
  byId('other-tab').setAttribute('aria-current', String(!player));
}

function load(name) {
  showTab(true);
  media.pause();
  media.removeAttribute('src');
  media.replaceChildren();
  if (name === 'tracks.mp4') {
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = 'Sidecar (English)';
    track.srclang = 'en';
    track.src = 'fixtures/sidecar.vtt';
    media.append(track);
  }
  fixture.value = name;
  media.src = `fixtures/${name}`;
  media.load();
  refreshTracks();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label) {
  const deadline = performance.now() + 12000;
  while (performance.now() < deadline) {
    if (media.error) throw new Error(`Media error ${media.error.code}: ${media.error.message}`);
    if (predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function seek(time) {
  media.currentTime = time;
  await waitFor(() => !media.seeking && Math.abs(media.currentTime - time) < 0.25, 'seek');
}

async function stats() {
  const response = await fetch('stats');
  if (!response.ok) throw new Error('Source statistics unavailable');
  return response.json();
}

async function verify() {
  const buttons = ['verify', 'play', 'seek', 'player-tab', 'other-tab'].map(byId);
  [...buttons, fixture, captions, audio].forEach((element) => (element.disabled = true));
  report.textContent = 'Running verification…';
  try {
    await verifyFixtures();
  } finally {
    [...buttons, fixture, captions].forEach((element) => (element.disabled = false));
    refreshTracks();
  }
}

async function verifyFixtures() {
  const results = [];
  for (const name of fixtureNames) {
    const result = { fixture: name };
    results.push(result);
    try {
      load(name);
      await waitFor(() => Number.isFinite(media.duration) && media.duration > 0, 'metadata');
      result.duration = media.duration;
      if (name === 'tracks.mp4') {
        const sidecar = media.querySelector('track');
        const tracks = Array.from(media.textTracks);
        const sidecarIndex = tracks.indexOf(sidecar.track);
        selectCaption(sidecarIndex);
        await waitFor(
          () => sidecar.readyState === 2 && sidecar.track.cues?.length > 0,
          'sidecar cues',
        );
        result.sidecarCues = sidecar.track.cues.length;
      }
      await media.play();
      await waitFor(() => media.currentTime > 0.3, 'playback');
      result.played = true;
      if (name === 'large.mp4') {
        media.pause();
        const before = (await stats()).fixtures[name];
        await seek(media.duration * 0.75);
        const after = (await stats()).fixtures[name];
        result.source = { before, after };
        result.seek = true;
        result.newRangeBeforeFullRead =
          after.rangeRequests > before.rangeRequests &&
          after.lastRangeStart > 0 &&
          after.bytesRead < after.fileBytes;
        await media.play();
        showTab(false);
        const position = media.currentTime;
        await delay(350);
        showTab(true);
        result.tabRestored = media.paused && Math.abs(position - media.currentTime) < 0.05;
        await media.play();
        await waitFor(() => media.currentTime > position + 0.2, 'resume after tab switch');
        result.tabResumed = true;
      }
      if (name === 'tracks.mp4') {
        const tracks = Array.from(media.textTracks);
        const sidecar = media.querySelector('track').track;
        await seek(1.5);
        await waitFor(() => sidecar.activeCues?.length > 0, 'active sidecar caption');
        result.sidecarActive = true;
        const embedded = tracks.find((track) => track !== sidecar);
        result.embeddedTracks = tracks.filter((track) => track !== sidecar).length;
        if (embedded) {
          selectCaption(tracks.indexOf(embedded));
          try {
            await waitFor(() => embedded.activeCues?.length > 0, 'active embedded caption');
            result.embeddedActive = true;
          } catch {
            result.embeddedActive = false;
          }
        }
        const audioTracks = Array.from(media.audioTracks ?? []);
        result.audioTracks = audioTracks.length;
        if (audioTracks.length > 1) {
          selectAudio(1);
          await delay(300);
          result.alternateAudioSelected = audioTracks[1].enabled && !audioTracks[0].enabled;
        }
      }
    } catch (error) {
      result.error = String(error);
    } finally {
      media.pause();
    }
  }
  const evidence = { userAgent: navigator.userAgent, results, source: await stats() };
  report.textContent = JSON.stringify(evidence, null, 2);
  const submitted = await fetch('report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(evidence),
  });
  if (!submitted.ok) throw new Error('Could not submit the playback report');
}

fixture.onchange = () => load(fixture.value);
byId('player-tab').onclick = () => showTab(true);
byId('other-tab').onclick = () => showTab(false);
byId('play').onclick = async () => {
  if (!media.paused) media.pause();
  else await media.play().catch((error) => (report.textContent = String(error)));
};
byId('seek').onclick = () =>
  seek(media.duration * 0.75).catch((error) => (report.textContent = String(error)));
byId('verify').onclick = () => verify().catch((error) => (report.textContent = String(error)));
captions.onchange = () => selectCaption(Number(captions.value));
audio.onchange = () => selectAudio(Number(audio.value));
media.onloadedmetadata = refreshTracks;
media.textTracks.addEventListener('addtrack', refreshTracks);
media.audioTracks?.addEventListener('addtrack', refreshTracks);
media.ontimeupdate = () => {
  byId('position').textContent = `${media.currentTime.toFixed(2)} / ${media.duration.toFixed(2)} s`;
};
if (new URLSearchParams(location.search).has('verify')) byId('verify').click();
else load(fixtureNames[0]);
