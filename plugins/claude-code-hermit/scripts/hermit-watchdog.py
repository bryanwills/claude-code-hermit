#!/usr/bin/env python3
"""Single-shot watchdog for hermit autonomous sessions.

Runs once per scheduler tick (systemd/launchd/cron), decides, acts, exits.
Can't hang or leak — the OS scheduler drives recurrence.

Decision flow:
  1. Config gate    — exit if watchdog.enabled is false
  2. Shutdown gate  — exit if operator stopped the session intentionally
  3. Dead detection — restart when tmux session is gone
  4. Wedge detection — nudge-then-escalate when heartbeat is stale
  5. Re-arm fallback — re-arm when heartbeat-restart routine missed its window

Usage: python scripts/hermit-watchdog.py [run]
       (invoked by .claude-code-hermit/bin/hermit-watchdog run)
"""

import datetime
import fcntl
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

CONFIG_PATH = Path('.claude-code-hermit/config.json')
STATE_DIR = CONFIG_PATH.parent / 'state'
RUNTIME_JSON = STATE_DIR / 'runtime.json'
RUNTIME_TMP = STATE_DIR / '.runtime.json.tmp'
LIFECYCLE_LOCK = STATE_DIR / '.lifecycle.lock'
WATCHDOG_STATE_JSON = STATE_DIR / 'watchdog-state.json'
WATCHDOG_EVENTS_JSONL = STATE_DIR / 'watchdog-events.jsonl'
HEARTBEAT_FILE = STATE_DIR / '.heartbeat'
ROUTINE_METRICS_JSONL = STATE_DIR / 'routine-metrics.jsonl'
LAST_OPERATOR_ACTION = STATE_DIR / 'last-operator-action.json'


# --- Utilities ---

def parse_duration(s):
    """Parse a duration string ('15m', '2h', '26h') to seconds."""
    if isinstance(s, (int, float)):
        return int(s)
    m = re.fullmatch(r'(\d+(?:\.\d+)?)(s|m|h|d)?', str(s).strip())
    if not m:
        return 0
    val = float(m.group(1))
    return int(val * {'s': 1, 'm': 60, 'h': 3600, 'd': 86400}.get(m.group(2) or 's', 1))


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None


def write_json(path, data):
    """Atomic write via tmp + rename."""
    path = Path(path)
    tmp = Path(str(path) + '.tmp')
    try:
        tmp.write_text(json.dumps(data, indent=2) + '\n')
        tmp.rename(path)
    except OSError as e:
        sys.stderr.write(f'[watchdog] write {path.name}: {e}\n')


def append_event(action, reason):
    """Append one audit line to watchdog-events.jsonl."""
    ts = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    line = json.dumps({'ts': ts, 'action': action, 'reason': reason}) + '\n'
    try:
        with open(WATCHDOG_EVENTS_JSONL, 'a') as f:
            f.write(line)
    except OSError as e:
        sys.stderr.write(f'[watchdog] append_event: {e}\n')


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc)


def parse_iso(ts_str):
    """Parse an ISO-8601 timestamp string to a UTC-aware datetime."""
    return datetime.datetime.fromisoformat(ts_str.replace('Z', '+00:00')).astimezone(
        datetime.timezone.utc
    )


# --- Tmux helpers ---

def tmux_session_alive(session_name):
    return subprocess.run(
        ['tmux', 'has-session', '-t', session_name],
        capture_output=True,
    ).returncode == 0


def get_pane_hash(session_name):
    """Capture pane content and return its SHA-256 hash, or None on failure."""
    try:
        r = subprocess.run(
            ['tmux', 'capture-pane', '-p', '-t', session_name],
            capture_output=True, text=True, timeout=5,
        )
        if r.returncode != 0:
            return None
        return hashlib.sha256(r.stdout.encode()).hexdigest()
    except Exception:
        return None


def send_keys(session_name, text):
    """Send text then Enter as two separate calls (avoids bracketed-paste submit bug)."""
    subprocess.run(['tmux', 'send-keys', '-t', session_name, text], capture_output=True)
    time.sleep(0.5)
    subprocess.run(['tmux', 'send-keys', '-t', session_name, 'Enter'], capture_output=True)


# --- Lifecycle lock ---

def try_acquire_lock():
    """Non-blocking exclusive lock. Returns fd on success, None when held."""
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        fd = open(LIFECYCLE_LOCK, 'w')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return fd
    except (BlockingIOError, OSError):
        return None


def release_lock(fd):
    if fd:
        try:
            fcntl.flock(fd, fcntl.LOCK_UN)
            fd.close()
        except OSError:
            pass


# --- State readers ---

def get_file_age_secs(path):
    """Seconds since last modification, or None if absent."""
    try:
        return time.time() - Path(path).stat().st_mtime
    except (FileNotFoundError, OSError):
        return None


def in_active_hours(active_hours):
    """True if local time is within the active_hours window."""
    try:
        sh, sm = map(int, active_hours.get('start', '00:00').split(':'))
        eh, em = map(int, active_hours.get('end', '23:59').split(':'))
        now = time.localtime()
        now_mins = now.tm_hour * 60 + now.tm_min
        return (sh * 60 + sm) <= now_mins <= (eh * 60 + em)
    except Exception:
        return True  # fail-open


def get_operator_last_action_age_secs():
    """Seconds since last-operator-action.json was written, or None if absent."""
    data = read_json(LAST_OPERATOR_ACTION)
    if not data or not data.get('at'):
        return None
    try:
        return (now_utc() - parse_iso(data['at'])).total_seconds()
    except Exception:
        return None


def get_last_routine_fired_age_secs(routine_id):
    """Seconds since the last 'fired' event for routine_id in routine-metrics.jsonl.
    Returns None when the file is absent or no matching event exists.
    """
    last_ts = None
    try:
        with open(ROUTINE_METRICS_JSONL) as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    e = json.loads(line)
                    if e.get('routine_id') == routine_id and e.get('event') == 'fired':
                        last_ts = e.get('ts')
                except (json.JSONDecodeError, AttributeError):
                    pass
    except (FileNotFoundError, OSError):
        return None
    if not last_ts:
        return None
    try:
        return (now_utc() - parse_iso(last_ts)).total_seconds()
    except Exception:
        return None


def check_process_running(pattern):
    return subprocess.run(['pgrep', '-f', pattern], capture_output=True).returncode == 0


def read_watchdog_state():
    data = read_json(WATCHDOG_STATE_JSON)
    if not isinstance(data, dict):
        return {'consecutive_stale': 0, 'last_pane_hash': None, 'last_nudge_at': None}
    return data


def write_watchdog_state(state):
    state['last_check_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    write_json(WATCHDOG_STATE_JSON, state)


def write_runtime_json(data):
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    data['updated_at'] = time.strftime('%Y-%m-%dT%H:%M:%S%z')
    RUNTIME_TMP.write_text(json.dumps(data, indent=2) + '\n')
    RUNTIME_TMP.rename(RUNTIME_JSON)


# --- Actions ---

def do_restart(session_name, reason, runtime):
    """Try-acquire lock, mark runtime, kill session, spawn hermit-start."""
    lock_fd = try_acquire_lock()
    if lock_fd is None:
        sys.stderr.write('[watchdog] lifecycle lock held — backing off restart\n')
        return

    try:
        # Mark runtime before killing so session-start recovery sees the reason
        runtime['last_error'] = 'unclean_shutdown'
        runtime['watchdog_restart_reason'] = reason
        write_runtime_json(runtime)

        subprocess.run(['tmux', 'kill-session', '-t', session_name], capture_output=True)

        # Release before spawning hermit-start (it re-acquires)
        release_lock(lock_fd)
        lock_fd = None

        subprocess.Popen(
            [str(Path('.claude-code-hermit/bin/hermit-start'))],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        append_event('restart', reason)
        sys.stderr.write(f'[watchdog] restarted "{session_name}", reason: {reason}\n')
    except Exception as e:
        sys.stderr.write(f'[watchdog] restart failed: {e}\n')
    finally:
        release_lock(lock_fd)


def do_nudge(session_name, watchdog_state, consecutive, pane_hash):
    """Send a heartbeat run nudge to a potentially wedged session."""
    send_keys(session_name, '/claude-code-hermit:heartbeat run')
    watchdog_state['consecutive_stale'] = consecutive
    watchdog_state['last_pane_hash'] = pane_hash
    watchdog_state['last_nudge_at'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    write_watchdog_state(watchdog_state)
    append_event('nudge', f'stale cycle {consecutive}')
    sys.stderr.write(f'[watchdog] nudged "{session_name}" (stale cycle {consecutive})\n')


def do_rearm(session_name):
    """Re-arm heartbeat when the in-session routine missed its window."""
    send_keys(session_name, '/claude-code-hermit:hermit-routines load')
    time.sleep(2)
    send_keys(session_name, '/claude-code-hermit:heartbeat start')
    append_event('re-arm-fallback', 'heartbeat-restart routine missed ~26h window')
    sys.stderr.write(f'[watchdog] re-armed "{session_name}"\n')


# --- Main decision loop ---

def main():
    if not CONFIG_PATH.exists():
        sys.exit(0)

    try:
        with open(CONFIG_PATH) as f:
            config = json.load(f)
    except (json.JSONDecodeError, OSError):
        sys.exit(0)

    # 1. Config gate
    watchdog_cfg = config.get('watchdog', {})
    if not isinstance(watchdog_cfg, dict) or not watchdog_cfg.get('enabled', False):
        sys.exit(0)

    stale_factor = watchdog_cfg.get('stale_factor', 2)
    escalate_after = watchdog_cfg.get('escalate_after', 3)
    operator_grace_secs = parse_duration(watchdog_cfg.get('operator_grace', '15m'))

    runtime = read_json(RUNTIME_JSON)
    if runtime is None:
        sys.exit(0)

    # 2. Shutdown-intent gate — never resurrect a deliberately-stopped hermit
    if runtime.get('session_state') == 'idle':
        sys.exit(0)
    if runtime.get('shutdown_requested_at') or runtime.get('shutdown_completed_at'):
        sys.exit(0)
    if runtime.get('runtime_mode') == 'interactive':
        sys.exit(0)

    session_name = runtime.get('tmux_session', '')
    if not session_name:
        sys.exit(0)

    session_state = runtime.get('session_state', '')

    # 3. Dead-session detection
    if session_state in ('in_progress', 'waiting', 'suspect_process'):
        if not tmux_session_alive(session_name):
            do_restart(session_name, 'dead-process', runtime)
            sys.exit(0)

    # 4. Wedge detection (only when heartbeat is enabled + within active hours)
    heartbeat_cfg = config.get('heartbeat', {})
    if isinstance(heartbeat_cfg, dict) and heartbeat_cfg.get('enabled', True):
        active_hours = heartbeat_cfg.get('active_hours')
        if not isinstance(active_hours, dict) or in_active_hours(active_hours):
            heartbeat_every_secs = parse_duration(heartbeat_cfg.get('every', '2h'))
            stale_threshold_secs = heartbeat_every_secs * stale_factor

            heartbeat_age = get_file_age_secs(HEARTBEAT_FILE)
            if heartbeat_age is not None:
                watchdog_state = read_watchdog_state()
                current_pane_hash = get_pane_hash(session_name)

                if heartbeat_age > stale_threshold_secs:
                    # Operator-recency guard: back off if operator was active recently
                    op_age = get_operator_last_action_age_secs()
                    if op_age is not None and op_age < operator_grace_secs:
                        watchdog_state['consecutive_stale'] = 0
                        watchdog_state['last_pane_hash'] = current_pane_hash
                        write_watchdog_state(watchdog_state)
                        sys.exit(0)

                    monitor_dead = not check_process_running('heartbeat-monitor.sh')

                    prev_hash = watchdog_state.get('last_pane_hash')
                    pane_frozen = (
                        current_pane_hash is not None
                        and prev_hash is not None
                        and current_pane_hash == prev_hash
                    )

                    consecutive = watchdog_state.get('consecutive_stale', 0) + 1

                    if consecutive >= escalate_after and pane_frozen and monitor_dead:
                        # Persist the bumped count so doctor's checkWatchdog reports it
                        # accurately even though do_restart doesn't touch watchdog-state.
                        watchdog_state['consecutive_stale'] = consecutive
                        watchdog_state['last_pane_hash'] = current_pane_hash
                        write_watchdog_state(watchdog_state)
                        do_restart(session_name, 'pane-frozen', runtime)
                    else:
                        do_nudge(session_name, watchdog_state, consecutive, current_pane_hash)
                else:
                    watchdog_state['consecutive_stale'] = 0
                    watchdog_state['last_pane_hash'] = current_pane_hash
                    write_watchdog_state(watchdog_state)

    # 5. Re-arm fallback: fire if heartbeat-restart routine hasn't fired in ~26h
    rearm_threshold_secs = 26 * 3600
    routine_age = get_last_routine_fired_age_secs('heartbeat-restart')
    if routine_age is not None and routine_age > rearm_threshold_secs:
        op_age = get_operator_last_action_age_secs()
        # Only re-arm when operator is silent (not in the middle of a conversation)
        if op_age is None or op_age >= operator_grace_secs:
            if tmux_session_alive(session_name):
                do_rearm(session_name)


def _get_session_name():
    """Read tmux session name from config for install commands."""
    if not CONFIG_PATH.exists():
        return 'hermit'
    try:
        with open(CONFIG_PATH) as f:
            cfg = json.load(f)
        name = cfg.get('tmux_session_name', 'hermit-{project_name}')
        return name.replace('{project_name}', Path.cwd().name)
    except Exception:
        return 'hermit'


def _find_templates_dir():
    """Locate state-templates/watchdog/ relative to this script's plugin root."""
    script_dir = Path(__file__).resolve().parent
    candidate = script_dir.parent / 'state-templates' / 'watchdog'
    if candidate.is_dir():
        return candidate
    return None


def cmd_install():
    """Platform-dispatching install: systemd (Linux/WSL), launchd (macOS), cron fallback."""
    import platform
    import subprocess as sp

    root = str(Path.cwd().resolve())
    name = _get_session_name()
    templates = _find_templates_dir()

    def render(template_text):
        return template_text.replace('{{NAME}}', name).replace('{{ROOT}}', root)

    system = platform.system()

    if system == 'Linux':
        systemd_dir = Path.home() / '.config' / 'systemd' / 'user'
        systemd_dir.mkdir(parents=True, exist_ok=True)
        service_name = f'hermit-watchdog@{name}'

        for tpl_name, out_name in [
            ('hermit-watchdog@.service', f'{service_name}.service'),
            ('hermit-watchdog@.timer', f'{service_name}.timer'),
        ]:
            if templates:
                tpl = (templates / tpl_name).read_text()
                (systemd_dir / out_name).write_text(render(tpl))
            else:
                sys.stderr.write(f'[watchdog] template {tpl_name} not found; skipping\n')

        sp.run(['systemctl', '--user', 'daemon-reload'], check=False)
        sp.run(['systemctl', '--user', 'enable', '--now', f'{service_name}.timer'], check=False)
        print(f'[watchdog] Installed systemd user timer: {service_name}.timer')
        print('[watchdog] To persist across reboots without a user session: loginctl enable-linger')

    elif system == 'Darwin':
        launch_agents = Path.home() / 'Library' / 'LaunchAgents'
        launch_agents.mkdir(parents=True, exist_ok=True)
        plist_name = f'com.hermit.watchdog.{name}.plist'
        plist_path = launch_agents / plist_name

        if templates:
            tpl = (templates / 'com.hermit.watchdog.plist').read_text()
            plist_path.write_text(render(tpl))
        else:
            sys.stderr.write('[watchdog] plist template not found; using inline fallback\n')
            plist_path.write_text(render(
                '<?xml version="1.0" encoding="UTF-8"?>\n'
                '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
                '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
                '<plist version="1.0"><dict>'
                '<key>Label</key><string>com.hermit.watchdog.{{NAME}}</string>'
                '<key>ProgramArguments</key><array>'
                '<string>{{ROOT}}/.claude-code-hermit/bin/hermit-watchdog</string>'
                '<string>run</string></array>'
                '<key>WorkingDirectory</key><string>{{ROOT}}</string>'
                '<key>StartInterval</key><integer>300</integer>'
                '<key>RunAtLoad</key><false/>'
                '</dict></plist>\n'
            ))
        sp.run(['launchctl', 'load', str(plist_path)], check=False)
        print(f'[watchdog] Installed LaunchAgent: {plist_name}')

    else:
        cron_line = f'*/5 * * * * cd {root} && .claude-code-hermit/bin/hermit-watchdog run 2>>.claude-code-hermit/state/watchdog.log'
        print('[watchdog] systemd and launchd not available on this platform.')
        print('[watchdog] Add the following line via `crontab -e`:')
        print(f'  {cron_line}')


def cmd_uninstall():
    """Remove the installed OS timer for this project."""
    import platform
    import subprocess as sp

    name = _get_session_name()
    system = platform.system()

    if system == 'Linux':
        service_name = f'hermit-watchdog@{name}'
        sp.run(['systemctl', '--user', 'disable', '--now', f'{service_name}.timer'], check=False)
        systemd_dir = Path.home() / '.config' / 'systemd' / 'user'
        for suffix in ('.service', '.timer'):
            f = systemd_dir / f'{service_name}{suffix}'
            try:
                f.unlink()
            except FileNotFoundError:
                pass
        sp.run(['systemctl', '--user', 'daemon-reload'], check=False)
        print(f'[watchdog] Removed systemd timer: {service_name}.timer')

    elif system == 'Darwin':
        plist_name = f'com.hermit.watchdog.{name}.plist'
        plist_path = Path.home() / 'Library' / 'LaunchAgents' / plist_name
        if plist_path.exists():
            sp.run(['launchctl', 'unload', str(plist_path)], check=False)
            plist_path.unlink()
        print(f'[watchdog] Removed LaunchAgent: {plist_name}')

    else:
        print('[watchdog] Cron entries must be removed manually with `crontab -e`.')


if __name__ == '__main__':
    subcommand = sys.argv[1] if len(sys.argv) > 1 else 'run'
    if subcommand in ('run', ''):
        try:
            main()
        except Exception as e:
            sys.stderr.write(f'[watchdog] fatal: {e}\n')
            sys.exit(0)  # fail-open: watchdog must never crash the calling shell
    elif subcommand == 'install':
        cmd_install()
    elif subcommand == 'uninstall':
        cmd_uninstall()
    else:
        sys.stderr.write(f'[watchdog] unknown subcommand: {subcommand}\n')
        sys.exit(1)
