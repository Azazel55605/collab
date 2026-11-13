#!/usr/bin/env python3
"""Run real-driver tests against owned, disposable SQL Server Developer containers.
Requires explicit license acknowledgement. Never uses a user's database endpoint.
"""
import argparse
import datetime
import json
import os
import platform
import re
from pathlib import Path
import secrets
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / 'tools/database-driver-spike/Cargo.toml'
BINARY = ROOT / 'tools/database-driver-spike/target/debug/collab-database-driver-spike'


def run(args, *, env=None, timeout=60, quiet_failure=False):
    try:
        return subprocess.run(args, env=env, check=True, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except subprocess.CalledProcessError:
        # Executable/subcommand names identify the stage without exposing arguments.
        stage = ' '.join(args[:2]) if args[0] == 'docker' else Path(args[0]).name
        if not quiet_failure:
            print(f'Fixture stage failed: {stage}', flush=True)
        raise


def certificates(directory):
    directory.mkdir(mode=0o755)
    common = ['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2']
    run(common + ['-subj', '/CN=Collab Phase 0 Fixture CA', '-keyout', str(directory/'ca.key'), '-out', str(directory/'ca.pem')])
    run(common + ['-subj', '/CN=Untrusted Fixture CA', '-keyout', str(directory/'wrong-ca.key'), '-out', str(directory/'wrong-ca.pem')])
    run(['openssl', 'req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', str(directory/'server.key'), '-out', str(directory/'server.csr')])
    (directory/'extensions.cnf').write_text('subjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n')
    run(['openssl', 'x509', '-req', '-in', str(directory/'server.csr'), '-CA', str(directory/'ca.pem'), '-CAkey', str(directory/'ca.key'), '-CAcreateserial', '-days', '2', '-extfile', str(directory/'extensions.cnf'), '-out', str(directory/'server.pem')])
    # The outer temporary directory is 0700. Only the server key and public leaf
    # are mounted into the container, where the unprivileged mssql user reads them.
    (directory/'server.key').chmod(0o644)


def fixture(version, image, work, record, native_adapter=False, native_only=False):
    name = f'collab-db-phase0-{version}-{uuid.uuid4().hex[:10]}'
    tls = work/'tls'
    certificates(tls)
    password = 'Collab0!' + secrets.token_urlsafe(24)
    password_file = work/'password'
    password_file.write_text(password)
    password_file.chmod(0o600)
    env_file = work/'container.env'
    env_file.write_text(f'MSSQL_SA_PASSWORD={password}\n')
    env_file.chmod(0o600)
    config = work/'mssql.conf'
    config.write_text('[network]\ntlscert=/var/opt/mssql/tls/server.pem\ntlskey=/var/opt/mssql/tls/server.key\nforceencryption=1\ntlsprotocols=1.2\n')
    try:
        run(['docker', 'image', 'inspect', image])
    except subprocess.CalledProcessError:
        run(['docker', 'pull', image], timeout=900)
    digest = run(['docker', 'image', 'inspect', image, '--format', '{{index .RepoDigests 0}}'])
    args = ['docker', 'run', '--detach', '--name', name, '--label', 'collab.database-phase0-fixture=true', '--memory', '4g', '--cpus', '2',
            '--publish', '127.0.0.1::1433', '--env', 'ACCEPT_EULA=Y', '--env', 'MSSQL_PID=Developer', '--env', 'MSSQL_MEMORY_LIMIT_MB=2048', '--env-file', str(env_file)]
    for source, target in [(tls/'server.pem', '/var/opt/mssql/tls/server.pem'), (tls/'server.key', '/var/opt/mssql/tls/server.key'), (config, '/var/opt/mssql/mssql.conf')]:
        args += ['--mount', f'type=bind,src={source},dst={target},readonly']
    args.append(digest)
    try:
        run(args)
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            log = run(['docker', 'logs', name])
            if 'SQL Server is now ready for client connections' in log:
                break
            if run(['docker', 'inspect', name, '--format', '{{.State.Running}}']) != 'true':
                raise RuntimeError('fixture container stopped before readiness')
            time.sleep(2)
        else:
            raise RuntimeError('fixture startup exceeded 180 seconds')
        # Bootstrap only, inside the newly created container. Application-driver
        # tests below verify TLS with the generated CA and reject invalid trust.
        bootstrap_env = dict(os.environ, SQLCMDPASSWORD=password)
        sqlcmd = ['docker', 'exec', '--env', 'SQLCMDPASSWORD', name, 'sh', '-c',
                  'tool=/opt/mssql-tools18/bin/sqlcmd; [ -x "$tool" ] || tool=/opt/mssql-tools/bin/sqlcmd; exec "$tool" -S localhost -U sa -C -b -l 5 -Q "$1"', 'fixture-bootstrap']
        # The log readiness marker can precede completion of startup upgrades / SA
        # initialization, especially in a fresh 2025 instance. Probe authenticated
        # readiness with read-only SQL; never retry an ambiguous CREATE DATABASE.
        deadline = time.monotonic() + 60
        while True:
            try:
                run(sqlcmd + ['SELECT 1'], env=bootstrap_env, timeout=15, quiet_failure=True)
                break
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                if time.monotonic() >= deadline:
                    raise RuntimeError('fixture SQL login was not ready within 60 seconds') from None
                time.sleep(2)
        run(sqlcmd + ['CREATE DATABASE collab_phase0'], env=bootstrap_env)
        if native_adapter:
            run(sqlcmd + ["USE collab_phase0; CREATE TABLE dbo.phase1_metadata (id int PRIMARY KEY, label nvarchar(100) NULL); CREATE INDEX phase1_label ON dbo.phase1_metadata(label); DECLARE @i int=0, @sql nvarchar(200); WHILE @i<105 BEGIN SET @sql=N'CREATE TABLE dbo.page_'+CAST(@i AS nvarchar(10))+N' (id int)'; EXEC(@sql); SET @i+=1; END"], env=bootstrap_env)
        port = run(['docker', 'port', name, '1433/tcp']).rsplit(':', 1)[1]
        base = dict(os.environ, COLLAB_DATABASE_DISPOSABLE_FIXTURE='yes', COLLAB_DB_SPIKE_PORT=port,
                    COLLAB_DB_SPIKE_PASSWORD_FILE=str(password_file), COLLAB_DB_SPIKE_CA=str(tls/'ca.pem'), SSL_CERT_FILE=str(tls/'ca.pem'))
        reports = []
        for driver in ([] if native_only else ['tiberius', 'microsoft']):
            for mode in ['verified', 'wrong_hostname', 'unknown_ca']:
                env = dict(base, COLLAB_DB_SPIKE_TLS_MODE=mode)
                if mode == 'unknown_ca':
                    env['COLLAB_DB_SPIKE_CA'] = str(tls/'wrong-ca.pem')
                    env['SSL_CERT_FILE'] = str(tls/'wrong-ca.pem')
                try:
                    report = json.loads(run([str(BINARY), driver], env=env, timeout=120))
                except subprocess.CalledProcessError as error:
                    # This executable deliberately emits only safe fixture-stage
                    # diagnostics, never underlying driver errors or SQL values.
                    print(f'{version} {driver} {mode}: {error.stderr.strip()}', flush=True)
                    raise
                report.update(fixture_version=version, image=digest, tls_case=mode)
                reports.append(report)
                record(report)
        if native_adapter:
            # Compilation should be completed before this isolated TLS environment;
            # offline mode prevents the fixture CA from affecting registry downloads.
            try:
                native_output = run(['cargo', 'test', '--offline', '-p', 'collab',
                     'database::tests::real_disposable_registry_connections_and_metadata',
                     '--', '--ignored', '--test-threads=1', '--nocapture'], env=base, timeout=180)
            except subprocess.CalledProcessError as error:
                # Report only source locations and fixed lifecycle labels. Never
                # copy raw native/driver diagnostics, SQL values or credentials.
                for location in re.findall(r'database/(?:tests|query|edit)\.rs:\d+:\d+', error.stdout+'\n'+error.stderr):
                    print('Native fixture assertion: ' + location, flush=True)
                diagnostics=error.stdout+'\n'+error.stderr
                for code in re.findall(r'error\[E[0-9]+\]',diagnostics):
                    print('Native fixture compiler: '+code,flush=True)
                for probe in re.findall(r'fixture scalar ((?:session-id|server-request|side-effect|phase3-rows|phase3-original)(?: code=(?:Some\(\d+\)|None) kind=[A-Za-z]+)?)', diagnostics):
                    print('Native fixture scalar: '+probe,flush=True)
                for failure in re.findall(r'Failure \{ code: [A-Za-z]+, server_code: (?:Some\(\d+\)|None), change_index: (?:Some\(\d+\)|None) \}', diagnostics):
                    print('Native edit fixture: '+failure, flush=True)
                if 'overflowed its stack' in diagnostics:
                    print('Native fixture failed: stack overflow',flush=True)
                for signal in re.findall(r'signal: [0-9]+',diagnostics):
                    print('Native fixture '+signal,flush=True)
                for state in re.findall(r'(?:left|right): "?(idle|running|finishing|retired|outcome_unknown|None|Open|Failed|Unknown)"?', error.stdout):
                    print('Native fixture state: ' + state, flush=True)
                raise
            if '1 passed; 0 failed' not in native_output:
                raise RuntimeError('native registry fixture did not execute its required test')
            metrics_match=re.search(r'COLLAB_DATABASE_PHASE2 (\{[^\n]+\})',native_output)
            metrics=json.loads(metrics_match.group(1)) if metrics_match else {}
            metrics={key:value for key,value in metrics.items() if re.fullmatch(r'[a-z0-9_]+',key) and (value is None or isinstance(value,(int,bool)))}
            record({'edit_fixture_passed': 'COLLAB_DATABASE_PHASE3 passed' in native_output, 'query_metrics':metrics,'kind': 'native_registry', 'fixture_version': version, 'image': digest,
                    'passed': True, 'checks': ['test-connect-closes-socket', 'independent-connections',
                    'pinned-tabs', 'forged-binding-rejected', 'paged-metadata', 'typed-cursor',
                    'columns-and-indexes', 'disconnect-isolation', 'connection-budget', 'profile-cleanup']})
            print(f'{version}: native registry fixture passed', flush=True)
        return reports
    finally:
        # Name and volumes belong only to this invocation. Never compose-down a
        # user's server or remove unrelated images, containers or volumes.
        subprocess.run(['docker', 'rm', '--force', '--volumes', name], capture_output=True, timeout=30)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--versions', nargs='+', choices=['2019', '2022', '2025'], default=['2022'])
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--skip-build', action='store_true')
    parser.add_argument('--native-only', action='store_true', help='Run only the native registry fixture; requires --native-adapter')
    parser.add_argument('--native-adapter', action='store_true', help='Also run the desktop native registry integration fixture (prebuild its tests first)')
    parser.add_argument('--image', help='Override image reference for a single explicitly selected version')
    args = parser.parse_args()
    if os.environ.get('COLLAB_DB_SPIKE_ACCEPT_EULA') != 'yes':
        parser.error('Set COLLAB_DB_SPIKE_ACCEPT_EULA=yes only after accepting the Microsoft SQL Server Developer license.')
    if args.native_only and not args.native_adapter:
        parser.error('--native-only requires --native-adapter')
    if args.image and len(args.versions) != 1:
        parser.error('--image requires exactly one version')
    if not args.skip_build and not args.native_only:
        subprocess.run(['cargo', 'build', '--locked', '--manifest-path', str(MANIFEST)], check=True)
    if args.native_adapter:
        # Compile outside the fixture's TLS environment and execution deadline.
        subprocess.run(['cargo', 'test', '--locked', '-p', 'collab', '--no-run'], check=True)
    reports = []
    def save(complete):
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_suffix(args.output.suffix + '.tmp')
        temporary.write_text(json.dumps({'run_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'host': platform.system().lower() + '-' + platform.machine(), 'complete': complete, 'reports': reports}, indent=2) + '\n')
        temporary.replace(args.output)
    def record(report):
        reports.append(report)
        save(False)
    for version in args.versions:
        with tempfile.TemporaryDirectory(prefix='collab-db-phase0-') as work:
            fixture(version, args.image or f'mcr.microsoft.com/mssql/server:{version}-latest', Path(work), record, args.native_adapter, args.native_only)
    save(True)
    print(f'Wrote {len(reports)} real-driver fixture reports to {args.output}')


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as error:
        # Only fixed harness-authored messages reach this branch.
        raise SystemExit(str(error)) from None
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        # Subprocess output can contain sensitive diagnostics. Do not echo it.
        raise SystemExit('Database fixture command failed; credentials and raw subprocess diagnostics withheld.')
