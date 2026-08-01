import { describe, expect, it } from 'vitest';
import {
  createTauriBuildArgs,
  resolveNodeTool,
  withAndroidBuildDefaults,
} from './tauri-command.mjs';

describe('tauri command wrapper', () => {
  it('passes a strict JSON config for signed builds', () => {
    const args = createTauriBuildArgs(
      ['build', '--target', 'x86_64-pc-windows-msvc'],
      'signing-key',
    );
    const configIndex = args.indexOf('--config');

    expect(configIndex).toBeGreaterThan(0);
    expect(JSON.parse(args[configIndex + 1])).toEqual({
      build: { beforeBuildCommand: '' },
    });
  });

  it('disables updater artifacts for unsigned local builds', () => {
    const args = createTauriBuildArgs(['build'], '');
    const configIndex = args.indexOf('--config');

    expect(JSON.parse(args[configIndex + 1])).toEqual({
      build: { beforeBuildCommand: '' },
      bundle: { createUpdaterArtifacts: false },
    });
  });

  it('preserves an explicit config override', () => {
    const args = ['build', '--config', '{"build":{"beforeBuildCommand":null}}'];
    expect(createTauriBuildArgs(args, 'signing-key')).toBe(args);
  });

  it('launches local JavaScript CLIs directly without a shell', () => {
    const tool = resolveNodeTool('tauri');

    expect(tool.command).toBe(process.execPath);
    expect(tool.prefixArgs[0]).toMatch(/@tauri-apps[/\\]cli[/\\]tauri\.js$/);
    expect(tool.shell).toBe(false);
  });

  it('uses compact line-table debug info for Android dev builds', () => {
    expect(withAndroidBuildDefaults(['android', 'build', '--debug'], {}))
      .toMatchObject({ CARGO_PROFILE_DEV_DEBUG: '1' });
    expect(withAndroidBuildDefaults(['android', 'android-studio-script', '--target', 'x86_64'], {}))
      .toMatchObject({ CARGO_PROFILE_DEV_DEBUG: '1' });
  });

  it('preserves explicit Rust debug settings and release defaults', () => {
    expect(withAndroidBuildDefaults(['android', 'dev'], { CARGO_PROFILE_DEV_DEBUG: '2' }))
      .toMatchObject({ CARGO_PROFILE_DEV_DEBUG: '2' });
    expect(withAndroidBuildDefaults(['android', 'build'], {})).not
      .toHaveProperty('CARGO_PROFILE_DEV_DEBUG');
  });
});
