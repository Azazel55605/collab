import { createWriteStream } from 'node:fs';
import https from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

const version = process.argv[2] ?? '10.33.0';
const outputPath = process.argv[3] ?? '/tmp/pnpm.tgz';
const maxAttempts = 5;
const requestTimeoutMs = 120_000;
const registryUrl = `https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz`;

function download(url, attempt, redirects = 0) {
  return new Promise((resolve, reject) => {
    console.log(`Downloading pnpm ${version} (${attempt}/${maxAttempts}) from ${url}`);
    const request = https.get(url, { timeout: requestTimeoutMs }, (response) => {
      const status = response.statusCode ?? 0;
      const redirect = response.headers.location;
      if (status >= 300 && status < 400 && redirect && redirects < 5) {
        response.resume();
        resolve(download(new URL(redirect, url).toString(), attempt, redirects + 1));
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Registry returned HTTP ${status}`));
        return;
      }

      const file = createWriteStream(outputPath);
      let bytes = 0;
      let lastProgressAt = Date.now();
      response.on('data', (chunk) => {
        bytes += chunk.length;
        const now = Date.now();
        if (now - lastProgressAt >= 5_000) {
          console.log(`Downloaded ${Math.round(bytes / 1024)} KiB...`);
          lastProgressAt = now;
        }
      });
      response.pipe(file);
      file.on('finish', () => {
        file.close(() => {
          console.log(`Downloaded pnpm tarball (${Math.round(bytes / 1024)} KiB).`);
          resolve();
        });
      });
      file.on('error', reject);
    });

    request.on('timeout', () => request.destroy(new Error('pnpm download timed out')));
    request.on('error', reject);
  });
}

let lastError;
for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  try {
    await download(registryUrl, attempt);
    process.exit(0);
  } catch (error) {
    lastError = error;
    console.error(`pnpm download attempt ${attempt} failed: ${error.message}`);
    if (attempt < maxAttempts) await delay(5_000 * attempt);
  }
}

console.error(`Failed to download pnpm ${version}: ${lastError?.message ?? 'unknown error'}`);
process.exit(1);
