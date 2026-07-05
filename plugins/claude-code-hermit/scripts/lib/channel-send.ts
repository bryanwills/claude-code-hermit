// channel-send.ts — the first script-owned (non-model) channel send.
//
// Resolves the eligible outbound channel (resolve-outbound-channel.ts's
// {id, chat_id}), reads the bot token from that channel's state_dir/.env
// (nothing else in core reads these tokens today — the MCP channel plugins
// consume them directly from the process env), and POSTs directly to the
// platform API. Plain text only (no parse_mode/markdown — unescaped markdown
// 400s on Telegram). On a confirmed 2xx, appends an outbound row to the
// episodic channel log via lib/channel-log.ts so this new send path doesn't
// open a hole in episodic memory the way model-only outbound logging would.
//
// Never throws — every path returns a SendResult so callers (a fail-open
// hook, a single-shot watchdog tick, a fire-and-forget budget alert) can
// decide what "failed to notify the operator" means for them.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { resolve as resolveOutboundChannel } from '../resolve-outbound-channel';
import { logMessage, isLoggingEnabled } from './channel-log';

type Json = any;

export interface SendResult {
  ok: boolean;
  status?: number;
  error?: string;
}

const REQUEST_TIMEOUT_MS = 10_000;
const TELEGRAM_MAX_LEN = 4096;
const DISCORD_MAX_LEN = 2000;

const TOKEN_ENV_VAR: Record<string, string> = {
  telegram: 'TELEGRAM_BOT_TOKEN',
  discord: 'DISCORD_BOT_TOKEN',
};

function readConfig(hermitDir: string): Json | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(hermitDir, 'config.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Mirrors hermit-start.ts's resolveStateDir: absolute pass-through, relative against the project root (hermitDir's parent). */
function resolveStateDir(hermitDir: string, stateDir: string): string {
  if (path.isAbsolute(stateDir)) return stateDir;
  const projectRoot = path.dirname(path.resolve(hermitDir));
  return path.join(projectRoot, stateDir);
}

/** Parse `KEY=value` lines from a channel's .env file; returns null if the file or key is absent. */
function readTokenFromEnvFile(envPath: string, varName: string): string | null {
  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    return null;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (key !== varName) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value || null;
  }
  return null;
}

interface HttpResult {
  status: number;
  json: Json;
}

/** POST JSON over http: or https: (protocol picked from the URL) with an explicit timeout. */
function postJson(urlStr: string, body: Json, extraHeaders: Record<string, string> = {}): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch (e) {
      reject(e);
      return;
    }
    const mod = url.protocol === 'http:' ? http : https;
    const data = JSON.stringify(body);
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...extraHeaders,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json: Json;
          try {
            json = JSON.parse(raw);
          } catch {
            json = { raw };
          }
          resolve({ status: res.statusCode || 0, json });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('request timeout'));
    });
    req.write(data);
    req.end();
  });
}

interface PlatformSendResult extends SendResult {
  sentText?: string;
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<PlatformSendResult> {
  const base = process.env.HERMIT_TELEGRAM_API_URL || 'https://api.telegram.org';
  const sentText = text.slice(0, TELEGRAM_MAX_LEN);
  try {
    const { status, json } = await postJson(`${base}/bot${token}/sendMessage`, { chat_id: chatId, text: sentText });
    if (status >= 200 && status < 300) return { ok: true, status, sentText };
    return { ok: false, status, error: json?.description || `telegram_http_${status}` };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

async function sendDiscord(token: string, chatId: string, text: string): Promise<PlatformSendResult> {
  const base = process.env.HERMIT_DISCORD_API_URL || 'https://discord.com/api/v10';
  const sentText = text.slice(0, DISCORD_MAX_LEN);
  try {
    const { status, json } = await postJson(
      `${base}/channels/${chatId}/messages`,
      { content: sentText },
      { Authorization: `Bot ${token}` }
    );
    if (status >= 200 && status < 300) return { ok: true, status, sentText };
    return { ok: false, status, error: json?.message || `discord_http_${status}` };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

const SENDERS: Record<string, (token: string, chatId: string, text: string) => Promise<PlatformSendResult>> = {
  telegram: sendTelegram,
  discord: sendDiscord,
};

/**
 * Resolve the eligible outbound channel, POST `text` to it, and log the send
 * (direction:'out') on success. Never throws.
 */
export async function sendToChannel(hermitDir: string, text: string): Promise<SendResult> {
  try {
    const config = readConfig(hermitDir);
    if (!config) return { ok: false, error: 'config_read_failed' };

    const target = resolveOutboundChannel(config.channels);
    if (!target) return { ok: false, error: 'no_reachable_channel' };
    const { id: channelId, chat_id: chatId } = target;

    const send = SENDERS[channelId];
    const varName = TOKEN_ENV_VAR[channelId];
    if (!send || !varName) return { ok: false, error: 'unsupported_platform' };

    const chCfg = config.channels[channelId] || {};
    const stateDir = typeof chCfg.state_dir === 'string' && chCfg.state_dir
      ? chCfg.state_dir
      : path.join('.claude.local', 'channels', channelId);
    const envPath = path.join(resolveStateDir(hermitDir, stateDir), '.env');
    const token = readTokenFromEnvFile(envPath, varName);
    if (!token) return { ok: false, error: 'missing_token' };

    const result = await send(token, chatId, text);
    if (!result.ok) return result;

    if (isLoggingEnabled(config)) {
      const logResult = logMessage(hermitDir, {
        source: channelId,
        chat_id: chatId,
        direction: 'out',
        text: result.sentText ?? text,
      });
      if (!logResult.ok) {
        process.stderr.write(`[channel-log] outbound capture failed: ${logResult.error}\n`);
      }
    }

    return { ok: true, status: result.status };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}
