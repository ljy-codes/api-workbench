import type { RequestHistoryEntry } from '../types';
import { ExactNumber, isExactNumber, parseExactJson, stringifyExactJson } from './json-exact';

export interface InvestigationReportOptions {
  symptom?: string; steps?: string;
  includeRequestBody?: boolean; includeResponseBody?: boolean; includeResponseHeaders?: boolean;
}
const REDACTED = '[已隐藏]';
const sensitive = /authorization|cookie|token|secret|passw|passwd|credential|api.?key|access.?key|session|phone|mobile|email|id.?card|密码|密钥|手机|身份证/i;
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const shellQuote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";
const numericValue = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const numericText = /(^|[^\w.+-])(-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?![\w.+-])/g;
const urlText = /(?:\bhttps?:|\b[a-z][a-z\d+.-]*:\/\/|\/\/|\/|\.\.?\/|\?)[^\s"'<>`]*/gi;

function redactUrl(source: string, allowRelative = false): string {
  try {
    const absolute = /^[a-z][a-z\d+.-]*:/i.test(source);
    // Explicit HTTP schemes may normalize single, back or missing slashes.
    // Parse without a base so their authority cannot become a relative path.
    const url = new URL(source, allowRelative && !absolute ? 'https://report.invalid/' : undefined);
    if (!['http:', 'https:'].includes(url.protocol)) return '[地址已省略]';
    const prefix = absolute ? url.origin
      : source.startsWith('//') ? `//${url.host}` : '';
    // Origin excludes userinfo. Neither query names/values nor fragment survive.
    const query = [...url.searchParams].map(() => `parameter=${REDACTED}`);
    return `${prefix}${url.pathname}${query.length ? '?' + query.join('&') : ''}`;
  } catch { return '[地址已省略]'; }
}

export function buildInvestigationReport(entry: RequestHistoryEntry, options: InvestigationReportOptions): { html: string; preview: string } {
  // No workspace or resolved variable values enter this boundary. Known literal
  // values from this snapshot are also removed if echoed under a different key.
  const privateValues = [
    ...entry.temporaryVariables.map(pair => pair.value),
    ...entry.request.query.map(pair => pair.value),
    ...entry.request.headers.map(pair => pair.value),
    ...Object.entries(entry.request.auth ?? {}).filter(([key]) => ['token', 'password', 'value', 'username'].includes(key)).map(([, value]) => value),
    ...(entry.request.form ?? []).filter(field => field.kind === 'file')
      .flatMap(field => [field.value, field.value.replace(/\\/g, '/')]),
    ...(entry.request.form ?? []).filter(field => field.kind === 'text').map(field => field.value),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0);
  let bodySecretsSafe = true;
  if (entry.request.bodyType === 'json' && entry.request.body.trim()) {
    try {
      // Collect before any sections are rendered, including when the request
      // body is excluded. Sensitive objects/arrays protect their descendants.
      const collect = (item: unknown, hidden = false): void => {
        if (isExactNumber(item)) {
          if (hidden) privateValues.push(item.raw);
        } else if (typeof item === 'string') {
          if (hidden && item) privateValues.push(item);
        } else if (Array.isArray(item)) {
          for (const child of item) collect(child, hidden);
        } else if (item && typeof item === 'object') {
          for (const [key, child] of Object.entries(item)) collect(child, hidden || sensitive.test(key));
        }
      };
      collect(parseExactJson(entry.request.body));
    } catch {
      // An invalid/oversized JSON body cannot supply a complete secret set.
      bodySecretsSafe = false;
    }
  }
  const unique = [...new Set(privateValues)];
  let withinBudget = bodySecretsSafe && unique.length <= 128 && unique.reduce((size, value) => size + value.length, 0) <= 20_000;
  const privateNumbers = new Set<string>();
  const literals: string[] = [];
  if (withinBudget) {
    for (const value of unique) {
      if (!numericValue.test(value.trim())) { literals.push(value); continue; }
      // Compare exact coefficient/exponent, including exponent notation and -0.
      // An unprocessable numeric secret fails closed under the same budget.
      try { privateNumbers.add(new ExactNumber(value.trim()).canonical); }
      catch { withinBudget = false; break; }
    }
  }
  const knownPattern = withinBudget && literals.length
    ? new RegExp(literals.sort((a, b) => b.length - a.length).map(value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : undefined;
  const scrub = (value: string) => {
    if (!withinBudget) return REDACTED;
    let text = knownPattern ? value.replace(knownPattern, REDACTED) : value;
    text = text.replace(urlText, source => /^(?:https?:|(?:[a-z][a-z\d+.-]*:)?\/\/)/i.test(source) || /[?#]/.test(source)
      ? redactUrl(source, true) : source);
    if (privateNumbers.size) {
      text = text.replace(numericText, (_, prefix: string, token: string) => {
        try { return prefix + (privateNumbers.has(new ExactNumber(token).canonical) ? REDACTED : token); }
        catch { return prefix + REDACTED; }
      });
    }
    return text.replace(/\{\{[^{}\r\n]*\}\}/g, '[变量]')
      .replace(/\bBearer\s+[^\s"'<>,;]+/gi, 'Bearer [已隐藏]');
  };
  const safeUrl = scrub(redactUrl(entry.url));
  const jsonBody = (source: string): string => {
    if (!source) return '（空正文）';
    if (!withinBudget) return '（脱敏预算不足，已省略正文）';
    try {
      const value = parseExactJson(source);
      const sanitize = (item: unknown): unknown => {
        if (isExactNumber(item)) return privateNumbers.has(item.canonical) ? REDACTED : item;
        if (typeof item === 'string') return scrub(item);
        if (Array.isArray(item)) return item.map(sanitize);
        if (item && typeof item === 'object') {
          // Preserve untouched source tokens/order; keys can also echo secrets.
          const object = item as Record<string, unknown>;
          for (const [key, child] of Object.entries(object)) {
            const safeKey = scrub(key);
            const safeValue = sensitive.test(key) ? REDACTED : sanitize(child);
            if (safeKey !== key) delete object[key];
            object[safeKey] = safeValue;
          }
        }
        return item;
      };
      return stringifyExactJson(sanitize(value));
    } catch { return '（无法安全解析为受限 JSON，已省略正文）'; }
  };
  const requestBody = options.includeRequestBody
    ? entry.request.bodyType === 'json' ? jsonBody(entry.request.body)
      : entry.request.bodyType === 'none' ? '（无请求正文）'
        : entry.request.bodyType === 'form' || entry.request.bodyType === 'multipart'
          ? (entry.request.form ?? []).filter(field => field.enabled).map(field => `${scrub(field.key)}: ${field.kind === 'file' ? '[文件需重新选择]' : REDACTED}`).join('\n') || '（空表单）'
          : '（无法安全解析为 JSON，已省略非结构化请求正文）'
    : '（未包含请求正文）';
  const responseBody = options.includeResponseBody
    ? entry.response?.truncated ? '（响应不完整，已省略正文）'
      : entry.response ? jsonBody(entry.response.body) : '（无响应正文）'
    : '（未包含响应正文）';
  const headers = options.includeResponseHeaders
    ? entry.response?.headers.map(header => `${scrub(header.key)}: ${sensitive.test(header.key) ? REDACTED : scrub(header.value)}`).join('\n') || '（无响应 Headers）'
    : '（未包含响应 Headers）';
  const d = entry.diagnostics ?? entry.response?.diagnostics;
  const timing = d ? [
    `结果分类：${d.outcome}`,
    `总体：${d.totalMs} ms`,
    ...(d.preparationMs === undefined ? [] : [`准备配置：${d.preparationMs} ms`]),
    ...(d.headersMs === undefined ? [] : [`等待响应头（含连接 / TLS / 上传）：${d.headersMs} ms`]),
    ...(d.downloadMs === undefined ? [] : [`接收正文：${d.downloadMs} ms`]),
    ...(d.httpVersion ? [`协议：${scrub(d.httpVersion)}`] : []),
    ...(d.remoteAddress ? [`远端：${scrub(d.remoteAddress)}`] : []),
    ...(d.receivedBytes === undefined ? [] : [`已接收：${d.receivedBytes} bytes`]),
  ].join('\n') : '此记录未采集分段指标。';
  // This is explicitly a credential-free template, not a wire capture.
  const curl = [
    'cURL 模板（POSIX shell；需自行补齐参数、变量、服务公共配置及正文）：',
    `curl --request ${shellQuote(scrub(entry.request.method))} --url ${shellQuote(safeUrl)}${entry.request.bodyType !== 'none' ? " --data '[请补齐正文]'" : ''}`,
    '鉴权、请求 Headers、Query 值及本地文件未导出。',
  ].join('\n');
  const sections = [
    { title: '执行概览', text: [
      `项目：${scrub(entry.projectName)}`, `服务：${scrub(entry.serviceName)}`,
      `环境：${scrub(entry.environmentName)}`, `接口：${scrub(entry.request.name)}`,
      `执行 ID：${scrub(entry.id)}`, `时间：${new Date(entry.startedAt).toISOString()}`,
      `请求：${scrub(entry.request.method)} ${safeUrl}`,
      entry.response ? `HTTP 状态：${entry.response.status} ${scrub(entry.response.statusText)}` : `未完成：${scrub(entry.error ?? '未收到响应')}`,
      entry.response?.truncated ? '响应超过接收上限，已接收字节不代表完整大小。' : '',
    ].filter(Boolean).join('\n') },
    { title: '问题现象', text: scrub((options.symptom ?? '').slice(0, 4000)) || '未填写' },
    { title: '复现步骤', text: scrub((options.steps ?? '').slice(0, 8000)) || '未填写' },
    { title: '网络诊断', text: timing },
    { title: '请求正文', text: requestBody },
    { title: '响应 Headers', text: headers },
    { title: '响应正文', text: responseBody },
    { title: '复现模板', text: curl },
    { title: '分享前核对', text: '自动脱敏覆盖常见凭据字段、请求参数值、模板变量和文件路径。请核对路径、字段名、普通业务文本和自行填写的步骤。此文件仅包含主动选中的本次记录，不含工作区或变量表。' },
  ];
  const preview = sections.map(section => `${section.title}\n${section.text}`).join('\n\n');
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>EnvDock · 问题排查包</title>
<style>body{font:14px/1.7 system-ui,sans-serif;color:#334155;background:#f1f5f9;margin:0;padding:32px}main{max-width:1000px;margin:auto}h1{font-size:26px}h2{font-size:16px;color:#476783;margin-top:0}section{padding:20px 24px;background:#fff;border:1px solid #dce4eb;border-radius:10px;margin:16px 0}pre{font:13px/1.7 Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}small{color:#64748b}@media print{body{padding:0;background:white}section{break-inside:avoid}}</style>
</head><body><main><h1>EnvDock · 问题排查包</h1><small>1.2.0 · 仅此执行记录 · 本地生成</small>${sections.map(section => `<section><h2>${escapeHtml(section.title)}</h2><pre>${escapeHtml(section.text)}</pre></section>`).join('')}</main></body></html>`;
  return { html, preview };
}
