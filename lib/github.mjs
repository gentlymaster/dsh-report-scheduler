/**
 * github.mjs — 插件宿主侧的 GitHub API 客户端（零依赖）
 *
 * 为什么不用全局 fetch：
 *   本机 DNS 对 github.com / api.github.com 会间歇性解析失败，需要 DoH 兜底直连。
 *   Node 的全局 fetch 无法注入自定义 lookup，所以这里用 node:https 实现。
 */
import { request as httpsRequest } from 'node:https';
import dns from 'node:dns/promises';

const DOH_ENDPOINTS = [
  'https://dns.alidns.com/resolve?name=HOST&type=A',
  'https://doh.pub/dns-query?name=HOST&type=A',
  'https://cloudflare-dns.com/dns-query?name=HOST&type=A',
];

/** 用公共 DoH 解析主机名；系统 DNS 可用时优先系统。 */
export async function resolveHost(host) {
  try {
    const r = await dns.lookup(host, { all: true });
    if (r.length > 0) return { via: 'system', ip: r[0].address };
  } catch { /* 落到 DoH */ }
  for (const tpl of DOH_ENDPOINTS) {
    try {
      const res = await fetch(tpl.replace('HOST', host), { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const body = await res.json();
      const ip = (body.Answer ?? []).find((a) => a.type === 1)?.data;
      if (ip) return { via: tpl.split('/')[2], ip };
    } catch { /* 下一个端点 */ }
  }
  return undefined;
}

/** 单次 HTTPS 请求。 */
function httpsJson(url, { method = 'GET', token, body, timeoutMs = 30000, ip }) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
    const headers = {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-report-scheduler',
      'x-github-api-version': '2022-11-28',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
    };
    const req = httpsRequest({
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      ...(ip ? { lookup: (_h, options, cb) => (options && options.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)) } : {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: res.statusCode ?? 0, text, json });
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`超时 ${timeoutMs}ms`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** 带重试与 DoH 兜底的 GitHub API 调用。 */
export function createGitHub(token) {
  async function api(path, init = {}, attempt = 1) {
    const url = path.startsWith('http') ? path : `https://api.github.com${path}`;
    try {
      const res = await httpsJson(url, { ...init, token });
      if (res.status >= 200 && res.status < 300) return res.json ?? res.text;
      const message = res.json?.message ?? res.text.slice(0, 200);
      const error = new Error(`HTTP ${res.status}: ${message}`);
      error.status = res.status;
      error.body = res.json;
      throw error;
    } catch (error) {
      // 网络层错误才重试（含 DoH 兜底）；4xx 直接抛出
      if (error.status !== undefined) throw error;
      if (attempt >= 4) throw error;
      const host = new URL(url).hostname;
      const resolved = await resolveHost(host);
      if (resolved && resolved.via !== 'system') {
        try {
          const res = await httpsJson(url, { ...init, token, ip: resolved.ip });
          if (res.status >= 200 && res.status < 300) return res.json ?? res.text;
          const message = res.json?.message ?? res.text.slice(0, 200);
          const err2 = new Error(`HTTP ${res.status}: ${message}`);
          err2.status = res.status;
          throw err2;
        } catch (inner) {
          if (inner.status !== undefined) throw inner;
        }
      }
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      return api(path, init, attempt + 1);
    }
  }
  return { api };
}

/** 读取仓库里某个文件（存在则返回内容与 sha）。 */
export async function readRepoFile(gh, owner, repo, path, branch) {
  try {
    const data = await gh.api(`/repos/${owner}/${repo}/contents/${path}?ref=${branch}`);
    if (data && typeof data === 'object' && data.content) {
      return { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
    }
    return undefined;
  } catch (error) {
    if (String(error).includes('404')) return undefined;
    throw error;
  }
}

/** 写入仓库文件（自动带 sha 以更新）。 */
export async function writeRepoFile(gh, owner, repo, path, branch, content, message) {
  const existing = await readRepoFile(gh, owner, repo, path, branch);
  const body = {
    message: message ?? `chore: 更新 ${path}`,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch,
    ...(existing ? { sha: existing.sha } : {}),
  };
  return gh.api(`/repos/${owner}/${repo}/contents/${path}`, { method: 'PUT', body });
}
