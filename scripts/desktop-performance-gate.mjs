import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function percentile(values, p = 0.95) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;
}
export function checkReports(reports, budgets, platforms = budgets.platforms, version) {
  const errors = [];
  const finite = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  for (const report of reports) {
    if (version && report.appVersion !== version)
      errors.push(`Report version ${report.appVersion} does not match release ${version}`);
    if (
      report.schemaVersion !== 1 ||
      !budgets.platforms.includes(report.platform) ||
      !Array.isArray(report.scenarios)
    )
      errors.push('Invalid performance report schema/platform');
  }
  for (const platform of platforms) {
    const selected = reports.filter((r) => r.platform === platform && r.schemaVersion === 1);
    if (!selected.length) {
      errors.push(`${platform}: missing native report`);
      continue;
    }
    const scenarios = selected.flatMap((r) => r.scenarios ?? []);
    for (const name of ['cold-start', 'warm-start', 'idle', 'interaction', 'open-close-soak']) {
      const samples = scenarios.filter((s) => s.name === name);
      if (!samples.length) {
        errors.push(`${platform}: missing ${name}`);
        continue;
      }
      for (const sample of samples) {
        if (sample.droppedEvents > 0 || sample.nativeEnd?.droppedEvents > 0)
          errors.push(`${platform}/${name}: diagnostics buffer overflowed`);
        if (
          !finite(sample.durationMs) ||
          !sample.nativeEnd?.enabled ||
          !finite(sample.nativeEnd?.peakRssBytes) ||
          sample.nativeEnd.peakRssBytes <= 0 ||
          !Array.isArray(sample.events)
        ) {
          errors.push(`${platform}/${name}: incomplete native evidence`);
          continue;
        }
        if (sample.nativeEnd.peakRssBytes > budgets.maxPeakRssBytes)
          errors.push(`${platform}/${name}: native RSS budget exceeded`);
      }
      if (name.endsWith('-start')) {
        if (
          new Set(samples.map((s) => s.nativeEnd?.runId).filter(Boolean)).size <
          budgets.minStartupSamples
        )
          errors.push(`${platform}/${name}: need ${budgets.minStartupSamples} fresh launches`);
        if (percentile(samples.map((s) => s.durationMs)) > budgets.maxStartupP95Ms[name])
          errors.push(`${platform}/${name}: startup p95 exceeded`);
      }
      if (name === 'interaction') {
        const times = samples.flatMap((s) =>
          (s.events ?? []).filter((e) => e.kind === 'interaction').map((e) => e.millis),
        );
        if (times.length < budgets.minInteractionSamples || times.some((t) => !finite(t)))
          errors.push(`${platform}: insufficient interaction evidence`);
        if (percentile(times) > budgets.maxInteractionP95Ms)
          errors.push(`${platform}: interaction p95 exceeded`);
      }
      for (const sample of samples) {
        if (name === 'idle') {
          if (sample.durationMs < budgets.minIdleDurationMs)
            errors.push(`${platform}: idle capture is too short`);
          const rate = (kind) =>
            (sample.events ?? []).filter((e) => kind(e.kind)).length / (sample.durationMs / 60000);
          if (rate((k) => k.startsWith('ipc:')) > budgets.maxIdleIpcPerMinute)
            errors.push(`${platform}: idle IPC budget exceeded`);
          if (rate((k) => k === 'poll-wake') > budgets.maxIdlePollWakesPerMinute)
            errors.push(`${platform}: idle wake budget exceeded`);
        }
        if (name === 'open-close-soak') {
          if (
            sample.durationMs < budgets.minSoakDurationMs ||
            !finite(sample.nativeEnd?.rssBytes) ||
            sample.nativeEnd?.rssBytes <= 0 ||
            !finite(sample.nativeStart?.rssBytes) ||
            sample.nativeStart.rssBytes <= 0
          )
            errors.push(`${platform}: incomplete soak capture`);
          if (
            sample.nativeEnd?.rssBytes - sample.nativeStart?.rssBytes >
            budgets.maxSoakGrowthBytes
          )
            errors.push(`${platform}: native soak retention exceeded`);
        }
      }
    }
  }
  return errors;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const argv = process.argv.slice(2);
    let platforms;
    let releaseVersion;
    const releaseIndex = argv.indexOf('--release-tag');
    if (releaseIndex >= 0) {
      const tag = argv[releaseIndex + 1];
      if (!/^desktop-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag ?? ''))
        throw new Error('Invalid desktop release tag');
      releaseVersion = tag.slice('desktop-v'.length);
      argv.splice(releaseIndex, 2);
      const directory = path.join('docs/build/performance-evidence', tag);
      const paths = fs
        .readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => path.join(directory, name));
      if (!paths.length) throw new Error(`Missing native release evidence: ${directory}`);
      argv.push(...paths);
    }
    const platformIndex = argv.indexOf('--platform');
    if (platformIndex >= 0) {
      platforms = [argv[platformIndex + 1]];
      argv.splice(platformIndex, 2);
    }
    const budgets = JSON.parse(
      fs.readFileSync(new URL('./desktop-performance-budgets.json', import.meta.url), 'utf8'),
    );
    if (!argv.length)
      throw new Error(
        'Supply exported native JSON reports; use --platform for one platform. Missing evidence fails the release gate.',
      );
    if (platforms && !budgets.platforms.includes(platforms[0]))
      throw new Error('Unknown native platform');
    const reports = argv.flatMap((file) => {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'));
      return Array.isArray(value) ? value : [value];
    });
    const errors = checkReports(reports, budgets, platforms, releaseVersion);
    if (errors.length) throw new Error(errors.join('\n'));
    console.log(
      `Native performance evidence passes for ${(platforms ?? budgets.platforms).join(', ')}.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
