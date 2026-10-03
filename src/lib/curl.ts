import type { FormField, Pair, Variable, Workspace } from '../types';
import { newRequest, uid } from './workspace';

const MAX_BYTES = 1024 * 1024;
const MAX_TOKENS = 10000;
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const SAFE_SWITCHES = new Set(['--http1.1', '--globoff', '--path-as-is']);
const OPTIONS = new Map([
  ['-X', 'method'], ['--request', 'method'], ['-H', 'header'], ['--header', 'header'],
  ['-d', 'data'], ['--data', 'data'], ['--data-raw', 'raw'], ['--json', 'json'],
  ['--url', 'url'], ['-u', 'user'], ['--user', 'user'], ['-F', 'form'], ['--form', 'form'],
  ['--form-string', 'formString'], ['--max-time', 'timeout'],
]);

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Restricted POSIX lexer, never a shell. Operators inside quotes are literal data. */
function tokenize(text: string): string[] {
  check(typeof text === 'string' && text.length <= MAX_BYTES, 'cURL 输入大小超过 1 MiB 上限');
  check(new TextEncoder().encode(text).byteLength <= MAX_BYTES, 'cURL 输入大小超过 1 MiB 上限');
  check(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text), 'cURL 包含非法控制字符');
  // Even quoted substitutions are rejected rather than suggesting they will run.
  check(!text.includes('`') && !text.includes('$('), 'cURL 不允许命令替换或子命令');
  const input = text.trim();
  const args: string[] = [];
  let token = '', started = false, quote: "'" | '"' | null = null;
  const flush = () => {
    if (!started) return;
    args.push(token);
    check(args.length <= MAX_TOKENS, 'cURL 参数数量超过上限');
    token = ''; started = false;
  };
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else token += c;
      continue;
    }
    if (c === '\\') {
      check(i + 1 < input.length, 'cURL 转义或续行未完成');
      const next = input[i + 1];
      if (next === '\n') { i++; continue; }
      if (next === '\r' && input[i + 2] === '\n') { i += 2; continue; }
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) token += '\\';
      else { token += next; i++; started = true; }
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else {
        check(c !== '$', 'cURL 不允许 Shell 变量展开');
        token += c;
      }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (c === ' ' || c === '\t') { flush(); continue; }
    check(!/[\n\r|&;<>()$#]/.test(c), 'cURL 不允许 Shell 执行运算符、变量、注释或未转义换行');
    token += c; started = true;
  }
  check(quote === null, 'cURL 引号未闭合');
  flush();
  check(args[0] === 'curl', '请输入以 curl 开始的单条命令');
  return args.slice(1);
}

function sensitive(key: string) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /(?:authorization|cookie|token|apikey|secret|password|passwd|credential|sessionid|signature)$/.test(normalized)
    || ['key', 'auth', 'session', 'sid', 'pwd', 'xcsrf', 'xcsrftoken', 'xsrftoken'].includes(normalized);
}

function allocateIds(workspace: Workspace) {
  const used = new Set([
    ...workspace.projects, ...workspace.environments, ...workspace.services, ...workspace.bindings,
    ...workspace.folders, ...workspace.requests, ...workspace.variables,
    ...workspace.services.flatMap(s => s.headers ?? []),
    ...workspace.requests.flatMap(r => [...r.headers, ...r.query, ...(r.form ?? [])]),
  ].map(e => e.id));
  return () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = uid();
      if (!used.has(id)) { used.add(id); return id; }
    }
    throw new Error('无法分配新的导入 ID，请重试');
  };
}

function parseUrl(value: string): { baseUrl: string; path: string; query: [string, string][] } {
  check(!/[\s\\#\u0000-\u001f\u007f]/.test(value), 'cURL URL 不允许空白、反斜线、控制字符或片段');
  const match = /^(https?):\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?$/i.exec(value);
  check(match && !match[2].includes('@'), 'cURL URL 必须为不带用户凭据的 HTTP/HTTPS 地址');
  const [, scheme, authority, rawPath, rawQuery] = match;
  check(!/[{}]/.test(authority), 'cURL 不支持 URL 范围展开');
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error('cURL URL 格式或端口无效'); }
  check(parsed.hostname && !parsed.username && !parsed.password, 'cURL URL 主机或凭据无效');
  const path = rawPath || '/';
  check(path.startsWith('/') && !path.startsWith('//'), 'cURL 路径不支持双斜线起始');
  check(!/[{}[\]]/.test(path), 'cURL 不支持 URL 模板或范围展开');
  for (const segment of path.split('/')) {
    check(!/%(?![a-f0-9]{2})/i.test(segment), 'cURL 路径百分号编码无效');
    const decoded = segment.replace(/%([a-f0-9]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    check(decoded !== '.' && decoded !== '..' && !/[\\\u0000-\u001f\u007f]/.test(decoded), 'cURL 路径含点段、反斜线或控制字符，无法安全导入');
  }
  const query: [string, string][] = [];
  const decode = (s: string) => {
    try { return decodeURIComponent(s.replace(/\+/g, ' ')); }
    catch { throw new Error('cURL Query 百分号编码或 UTF-8 无效'); }
  };
  if (rawQuery !== undefined) {
    check(rawQuery !== '', 'cURL 空 Query 标记无法由当前模型无损表示');
    check(!/[{}[\]]/.test(rawQuery), 'cURL 不支持 Query 范围展开');
    for (const item of rawQuery.split('&')) {
      const index = item.indexOf('=');
      check(index >= 0, 'cURL 空 Query 段或无等号参数无法由当前模型无损表示');
      query.push([decode(item.slice(0, index)), decode(item.slice(index + 1))]);
      check(query.length <= MAX_TOKENS, 'cURL Query 数量超过上限');
    }
  }
  // Do not use URL.origin: it discards an explicitly specified default port.
  return { baseUrl: `${scheme.toLowerCase()}://${authority}`, path, query };
}

function timeoutMs(value: string) {
  check(/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value), 'cURL max-time 必须为十进制秒数');
  const [whole, fraction = ''] = value.split('.');
  check(!/[1-9]/.test(fraction.slice(3)), 'cURL max-time 不能小于毫秒精度');
  // Decimal arithmetic avoids rejecting e.g. 1.001 due to float multiplication.
  const ms = Number(whole) * 1000 + Number(fraction.slice(0, 3).padEnd(3, '0'));
  check(Number.isSafeInteger(ms) && ms >= 1 && ms <= 300000, 'cURL max-time 必须在 1..300000 毫秒范围内');
  return ms;
}

/**
 * 导入为当前活动项目/环境下的全新服务、绑定和接口草稿，不保存、不联网、不执行命令。
 * 支持 POSIX 单/双引号、转义/续行、单 URL、-X/--request、-H/--header、
 * -d/--data/--data-raw、--json、--url、-u/--user、基础 -F/--form/--form-string。
 * --head/-I 导入为无正文 HEAD；与任何非 HEAD 显式方法或正文选项组合均拒绝，
 * 不因参数顺序或后续方法覆盖而静默改变语义。
 * --http1.1/--globoff/--path-as-is 为安全兼容开关；--max-time 转为 1..300000 ms。
 * Content-Type: 抑制默认头，Name; 表示显式空 Header；其他 Header 删除指令不支持。
 * 长选项支持 =，短选项支持紧贴值。不支持任何未列出的参数或 Shell 扩展。
 * -d/--json 的 @文件、Header 文件、交互密码、混合正文模式、复杂 multipart
 * 元数据/多文件均明确拒绝；基础上传文件路径清空且禁用，须由用户重新选择。
 * 当前 DTO 无法无损表示空 Query 标记/空段/无等号参数，故拒绝这些输入；
 * 编码由请求引擎重新生成，不保证签名 URL 的原始 Query 字节表示。
 * 凭据仅进入新 request 作用域的 isSecret 变量，须交由现有 DPAPI 保存链路处理。
 * UI 应提示检查普通正文等业务数据中的秘密；Query 保留解码后的有序重复项。
 */
export function importCurl(workspace: Workspace, text: string, serviceName?: string): Workspace {
  const args = tokenize(text);
  const project = workspace.projects.find(p => p.id === workspace.activeProjectId);
  check(project, '请先选择要导入的活动项目');
  const environment = workspace.environments.find(e => e.id === project.activeEnvironmentId && e.projectId === project.id);
  check(environment, '请先为活动项目选择有效环境');
  check(serviceName === undefined || (typeof serviceName === 'string' && serviceName.trim().length > 0 && serviceName.length <= 1024), '导入服务名称不能为空或超过上限');
  const allocate = allocateIds(workspace);
  const serviceId = allocate();
  const request = newRequest(serviceId, null, allocate());
  request.name = 'cURL 导入';
  const variables: Variable[] = [];
  const names = new Set(workspace.variables.map(v => v.name));
  let secretSequence = 0;
  const secret = (value: string) => {
    let name: string;
    do { name = `curl_secret_${++secretSequence}`; } while (names.has(name));
    names.add(name);
    variables.push({ id: allocate(), projectId: project.id, scope: 'request', ownerId: request.id, name, value, isSecret: true });
    return `{{${name}}}`;
  };
  const literal = (value: string) => {
    check(!value.includes('{{'), 'cURL 普通字段含工作区模板标记，无法保证字面量语义');
    return value;
  };
  const pair = (key: string, value: string): Pair => ({
    id: allocate(), key: literal(key), value: sensitive(key) ? secret(value) : literal(value), enabled: true,
  });
  let url: string | undefined, method: string | undefined, user: string | undefined;
  let head = false, hasNonHeadMethod = false;
  let suppressContentType = false;
  let mode: 'data' | 'json' | 'form' | undefined;
  const body: string[] = [];
  const form: FormField[] = [];
  const setMode = (next: NonNullable<typeof mode>) => {
    check(mode === undefined || mode === next, 'cURL 不支持混合正文模式');
    mode = next;
  };
  const setUrl = (value: string) => {
    check(url === undefined, 'cURL 只支持单个 URL，不支持多个传输');
    url = value;
  };
  let positionalOnly = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--' && !positionalOnly) { positionalOnly = true; continue; }
    if (positionalOnly || !arg.startsWith('-')) { setUrl(arg); continue; }
    if (SAFE_SWITCHES.has(arg)) continue;
    if (arg === '--head' || arg === '-I') { head = true; continue; }
    let flag = arg, value: string | undefined;
    if (arg.startsWith('--')) {
      const index = arg.indexOf('=');
      if (index >= 0) { flag = arg.slice(0, index); value = arg.slice(index + 1); }
    } else if (arg.length > 2) { flag = arg.slice(0, 2); value = arg.slice(2); }
    const option = OPTIONS.get(flag);
    check(option, '不支持此 cURL 参数；请仅使用文档列出的选项');
    if (value === undefined) {
      check(i + 1 < args.length, 'cURL 参数缺少值');
      value = args[++i];
    }
    switch (option) {
      case 'url': setUrl(value); break;
      case 'method':
        check(TOKEN.test(value) && value.length <= 64, 'cURL 请求方法无效');
        if (value !== 'HEAD') hasNonHeadMethod = true;
        method = value;
        break;
      case 'timeout':
        request.timeoutMs = timeoutMs(value);
        break;
      case 'header': {
        check(!value.startsWith('@'), 'cURL 不支持从文件读取 Header');
        const emptyHeader = value.endsWith(';') && !value.includes(':');
        const index = emptyHeader ? value.length - 1 : value.indexOf(':');
        check(index > 0 && TOKEN.test(value.slice(0, index)) && !/[\r\n\u0000]/.test(value), 'cURL Header 格式无效');
        const key = value.slice(0, index);
        check(!['host', 'content-length', 'transfer-encoding'].includes(key.toLowerCase()), 'cURL 此 Header 由请求引擎管理，不能手动导入');
        const headerValue = value.slice(index + 1).replace(/^[ \t]+/, '');
        if (headerValue.length === 0 && !emptyHeader) {
          check(key.toLowerCase() === 'content-type', 'cURL 仅支持 Content-Type 的默认 Header 删除指令');
          suppressContentType = true;
          break;
        }
        request.headers.push(pair(key, headerValue));
        break;
      }
      case 'user':
        check(user === undefined, 'cURL 不支持重复用户鉴权参数');
        check(value.includes(':'), 'cURL 用户鉴权必须包含用户名和密码，不支持交互输入');
        check(!/[\u0000-\u001f\u007f]/.test(value), 'cURL 用户鉴权不允许控制字符');
        user = value;
        break;
      case 'data':
      case 'raw':
      case 'json':
        setMode(option === 'json' ? 'json' : 'data');
        check(option === 'raw' || !value.startsWith('@'), 'cURL 不支持从文件或标准输入读取正文，请使用内联正文');
        body.push(literal(value));
        break;
      case 'form':
      case 'formString': {
        setMode('form');
        const index = value.indexOf('=');
        check(index > 0, 'cURL 表单必须使用字段名=值');
        const key = literal(value.slice(0, index));
        const content = value.slice(index + 1);
        const formString = option === 'formString';
        check(!/[;\r\n"]/.test(key), 'cURL 表单字段名不支持控制字符或元数据');
        check(formString || (!content.includes(';') && !content.startsWith('"')), 'cURL 只支持基础表单，不支持表单元数据或内部引号');
        const file = !formString && (content.startsWith('@') || content.startsWith('<'));
        if (file) check(content.length > 1 && !/[,"\r\n]/.test(content), 'cURL 不支持多文件或带引号的复杂文件表达式');
        check(formString || (!content.startsWith('(') && key !== ')'), 'cURL 不支持嵌套 multipart');
        form.push({ id: allocate(), key, value: file ? '' : sensitive(key) ? secret(content) : literal(content), enabled: !file, kind: file ? 'file' : 'text' });
        break;
      }
    }
  }
  check(url !== undefined && url !== '', 'cURL 缺少请求 URL');
  check(!head || (!hasNonHeadMethod && mode === undefined), 'cURL HEAD 与其他请求方法或正文参数冲突，无法安全导入');
  const parsed = parseUrl(url);
  request.path = parsed.path;
  request.query = parsed.query.map(([key, value]) => pair(key, value));
  request.method = head ? 'HEAD' : method ?? (mode === undefined ? 'GET' : 'POST');
  if (user !== undefined) {
    check(!request.headers.some(p => p.key.toLowerCase() === 'authorization'), 'cURL 用户鉴权与 Authorization Header 冲突');
    const separator = user.indexOf(':');
    request.auth = { kind: 'basic', username: secret(user.slice(0, separator)), password: secret(user.slice(separator + 1)) };
  }
  const defaultHeader = (key: string, value: string) => {
    if (!request.headers.some(p => p.key.toLowerCase() === key.toLowerCase())) request.headers.push(pair(key, value));
  };
  if (mode === 'data' || mode === 'json') {
    request.body = body.join(mode === 'data' ? '&' : '');
    request.bodyType = mode === 'json' && !suppressContentType ? 'json' : 'text';
    if (!suppressContentType) defaultHeader('Content-Type', mode === 'json' ? 'application/json' : 'application/x-www-form-urlencoded');
    if (mode === 'json') defaultHeader('Accept', 'application/json');
  } else if (mode === 'form') {
    check(!suppressContentType && !request.headers.some(p => p.key.toLowerCase() === 'content-type'), 'cURL multipart 不支持手动 Content-Type，请由引擎生成 boundary');
    request.bodyType = 'multipart';
    request.form = form;
  }
  return {
    ...workspace,
    services: [...workspace.services, { id: serviceId, projectId: project.id, name: serviceName?.trim() ?? 'cURL 导入服务' }],
    bindings: [...workspace.bindings, { id: allocate(), projectId: project.id, serviceId, environmentId: environment.id, baseUrl: parsed.baseUrl, enabled: true }],
    requests: [...workspace.requests, request],
    variables: [...workspace.variables, ...variables],
  };
}
