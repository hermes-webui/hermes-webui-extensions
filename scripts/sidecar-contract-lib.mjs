import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const CANON_FILES = ['sidecar_base.py', 'sidecar.py'];
const REQUIRED_VENDORED_FILES = [...CANON_FILES, 'sidecar.json', 'routes_impl.py'];
const NODE_SERVER_PATTERNS = [
  /\bfrom\s*['"](?:node:)?(?:http|https|http2|net)['"]/,
  /\bimport\s+(?:[A-Za-z_$][\w$]*|\*\s+as\s+[A-Za-z_$][\w$]*|\{[^}]*\b(?:createServer|Server)\b[^}]*\})\s+from\s*['"](?:node:)?(?:http|https|http2|net)['"]/,
  /\brequire\s*\(\s*['"](?:node:)?(?:http|https|http2|net)['"]\s*\)/,
  /\bnew\s+(?:[A-Za-z_$][\w$]*\.)?Server\s*\(/,
  /\b(?:http|https|http2|net)\.createServer\s*\(/,
  /\bcreateServer\s*\(/,
  /\b(?:Bun|Deno)\.serve\s*\(/,
  /\b(?:express|fastify)\s*\([^)]*\)\s*\.listen\s*\(/,
  /\b[A-Za-z_$][\w$]*\.listen\s*\(/
];

const SERVER_PATTERNS = new Map([
  ['.py', [
    /\bfrom\s+http\.server\s+import\b/,
    /\bimport\s+http\.server\b/,
    /\b(?:from\s+socketserver\s+import|import\s+socketserver\b)/,
    /\bfrom\s+wsgiref\.simple_server\s+import\b/,
    /\b(?:from\s+flask\s+import|import\s+flask\b)/,
    /\b(?:from\s+fastapi\s+import|import\s+fastapi\b)/,
    /\b(?:from\s+aiohttp\s+import\s+web|import\s+aiohttp\.web\b)/,
    /\bThreadingHTTPServer\s*\(/,
    /\bHTTPServer\s*\(/,
    /\bmake_server\s*\(/,
    /\bsocketserver\.\w*Server\s*\(/,
    /\bapp\.run\s*\(/,
    /\buvicorn\.run\s*\(/
  ]],
  ['.js', NODE_SERVER_PATTERNS],
  ['.mjs', NODE_SERVER_PATTERNS],
  ['.cjs', NODE_SERVER_PATTERNS],
  ['.ts', NODE_SERVER_PATTERNS],
  ['.tsx', NODE_SERVER_PATTERNS],
  ['.rs', [/\bTcpListener::bind\s*\(/, /\bServer::bind\s*\(/]],
  ['.go', [
    /\bhttp\.ListenAndServe(?:TLS)?\s*\(/,
    /\b[A-Za-z_][A-Za-z0-9_]*\.ListenAndServe(?:TLS)?\s*\(/,
    /\b(?:http|net)\.Serve\s*\(/,
    /\b[A-Za-z_][A-Za-z0-9_]*\.Serve\s*\(/,
    /\bnet\.Listen\s*\(/
  ]],
  ['.java', [/\bHttpServer\.create\s*\(/, /\bnew\s+ServerSocket\s*\(/]],
  ['.kt', [/\bHttpServer\.create\s*\(/, /\bServerSocket\s*\(/]],
  ['.cs', [/\bnew\s+HttpListener\s*\(/]],
  ['.rb', [/\bTCPServer\.new\s*\(/, /\bWEBrick::HTTPServer\.new\s*\(/]]
]);

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function hasTopLevelRegister(filePath) {
  const check = [
    'import ast, pathlib, sys',
    'try:',
    '    tree = ast.parse(pathlib.Path(sys.argv[1]).read_text(encoding="utf-8"))',
    'except (OSError, SyntaxError, UnicodeError):',
    '    raise SystemExit(1)',
    'def is_route_factory(expr):',
    '    return (',
    '        isinstance(expr, ast.Call)',
    '        and isinstance(expr.func, ast.Attribute)',
    '        and expr.func.attr == "route"',
    '        and isinstance(expr.func.value, ast.Name)',
    '        and expr.func.value.id == "app"',
    '    )',
    'class NamedExprFinder(ast.NodeVisitor):',
    '    def __init__(self):',
    '        self.bindings = []',
    '    def visit_NamedExpr(self, node):',
    '        if isinstance(node.target, ast.Name) and node.target.id == "register":',
    '            self.bindings.append(node)',
    '        self.visit(node.value)',
    '    def visit_Lambda(self, node):',
    '        for default in [*node.args.defaults, *node.args.kw_defaults]:',
    '            if default is not None: self.visit(default)',
    'class BindingFinder(ast.NodeVisitor):',
    '    def __init__(self):',
    '        self.bindings = []',
    '    def scan_namedexpr(self, expressions):',
    '        finder = NamedExprFinder()',
    '        for expression in expressions:',
    '            if expression is not None: finder.visit(expression)',
    '        self.bindings.extend(finder.bindings)',
    '    def annotations(self, args):',
    '        values = [*args.posonlyargs, *args.args, *args.kwonlyargs]',
    '        values.extend(item for item in [args.vararg, args.kwarg] if item)',
    '        return [item.annotation for item in values]',
    '    def visit_FunctionDef(self, node):',
    '        if node.name == "register": self.bindings.append(node)',
    '        self.scan_namedexpr([*node.decorator_list, *node.args.defaults,',
    '                             *node.args.kw_defaults, *self.annotations(node.args),',
    '                             node.returns])',
    '    visit_AsyncFunctionDef = visit_FunctionDef',
    '    def visit_ClassDef(self, node):',
    '        if node.name == "register": self.bindings.append(node)',
    '        self.scan_namedexpr([*node.decorator_list, *node.bases,',
    '                             *(keyword.value for keyword in node.keywords)])',
    '    def visit_Name(self, node):',
    '        if node.id == "register" and isinstance(node.ctx, (ast.Store, ast.Del)):',
    '            self.bindings.append(node)',
    '    def visit_Import(self, node):',
    '        for alias in node.names:',
    '            if (alias.asname or alias.name.split(".")[0]) == "register":',
    '                self.bindings.append(node)',
    '    def visit_ImportFrom(self, node):',
    '        for alias in node.names:',
    '            if alias.name == "*" or (alias.asname or alias.name) == "register":',
    '                self.bindings.append(node)',
    '    def visit_ExceptHandler(self, node):',
    '        if node.name == "register": self.bindings.append(node)',
    '        self.generic_visit(node)',
    '    def visit_MatchAs(self, node):',
    '        if node.name == "register": self.bindings.append(node)',
    '        self.generic_visit(node)',
    '    def visit_MatchStar(self, node):',
    '        if node.name == "register": self.bindings.append(node)',
    '    def visit_MatchMapping(self, node):',
    '        if node.rest == "register": self.bindings.append(node)',
    '        self.generic_visit(node)',
    '    def visit_Lambda(self, node):',
    '        self.scan_namedexpr([*node.args.defaults, *node.args.kw_defaults])',
    '    def visit_ListComp(self, node): self.scan_namedexpr([node])',
    '    def visit_SetComp(self, node): self.scan_namedexpr([node])',
    '    def visit_DictComp(self, node): self.scan_namedexpr([node])',
    '    def visit_GeneratorExp(self, node): self.scan_namedexpr([node])',
    'control_flow = (ast.If, ast.For, ast.AsyncFor, ast.While, ast.Try,',
    '                ast.With, ast.AsyncWith, ast.Assert)',
    'optional_control_flow = tuple(',
    '    item for item in (getattr(ast, "TryStar", None), getattr(ast, "Match", None))',
    '    if item is not None',
    ')',
    'if any(isinstance(node, (ast.Raise,) + control_flow + optional_control_flow)',
    '       for node in tree.body):',
    '    raise SystemExit(1)',
    'if any(isinstance(node, ast.Global) and "register" in node.names',
    '       for node in ast.walk(tree)):',
    '    raise SystemExit(1)',
    'finder = BindingFinder()',
    'for node in tree.body:',
    '    finder.visit(node)',
    'bindings = finder.bindings',
    'if (len(bindings) != 1 or not isinstance(bindings[0], ast.FunctionDef)',
    '        or bindings[0] not in tree.body or bindings[0].decorator_list):',
    '    raise SystemExit(1)',
    'node = bindings[0]',
    'positional = [*node.args.posonlyargs, *node.args.args]',
    'if (len(positional) != 1 or positional[0].arg != "app"',
    '        or node.args.vararg or node.args.kwarg or node.args.kwonlyargs',
    '        or node.args.defaults):',
    '    raise SystemExit(1)',
    'for statement in node.body:',
    '    if isinstance(statement, (ast.Raise, ast.Return)):',
    '        break',
    '    if isinstance(statement, control_flow + optional_control_flow):',
    '        break',
    '    if isinstance(statement, ast.FunctionDef):',
    '        if any(is_route_factory(decorator) for decorator in statement.decorator_list):',
    '            raise SystemExit(0)',
    '    elif (isinstance(statement, ast.Expr)',
    '          and isinstance(statement.value, ast.Call)',
    '          and is_route_factory(statement.value.func)):',
    '        raise SystemExit(0)',
    'raise SystemExit(1)'
  ].join('\n');
  const result = spawnSync('python3', ['-c', check, filePath], {
    stdio: 'ignore'
  });
  return result.status === 0;
}

function parseUnitDirectives(source) {
  const directives = [];
  let section = '';
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    const sectionMatch = /^\[([^\]]+)]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    const directiveMatch = /^([A-Za-z][A-Za-z0-9]*)\s*=(.*)$/.exec(line);
    if (directiveMatch) {
      directives.push({
        section,
        name: directiveMatch[1],
        value: directiveMatch[2].trim(),
        raw: line
      });
    }
  }
  return directives;
}

function walkFiles(dir) {
  if (!existsSync(dir)) return [];
  const files = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, item.name);
    if (item.isDirectory()) files.push(...walkFiles(target));
    else if (item.isFile()) files.push(target);
  }
  return files;
}

function pathHasSymlink(root, relativePath) {
  let current = root;
  for (const segment of relativePath.split('/')) {
    current = path.join(current, segment);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return true;
  }
  return false;
}

export function symlinksUnder(dir, prefix = '') {
  if (!existsSync(dir)) return [];
  const symlinks = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
    const target = path.join(dir, item.name);
    if (item.isSymbolicLink()) symlinks.push(relativePath);
    else if (item.isDirectory()) symlinks.push(...symlinksUnder(target, relativePath));
  }
  return symlinks;
}

function importShadowCollisions(runtimeDir) {
  if (!existsSync(runtimeDir) || !lstatSync(runtimeDir).isDirectory()) return [];
  return readdirSync(runtimeDir, { withFileTypes: true })
    .filter((item) => ['sidecar_base', 'routes_impl'].some((moduleName) => (
      item.name !== `${moduleName}.py`
      && (item.name === moduleName || item.name.startsWith(`${moduleName}.`))
    )))
    .map((item) => item.name);
}

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value);
  return normalized === value && normalized !== '.' && normalized !== '..' && !normalized.startsWith('../');
}

function extensionEntries(repoRoot) {
  const extensionsRoot = path.join(repoRoot, 'extensions');
  if (!existsSync(extensionsRoot)) return [];
  return readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .map((item) => {
      const root = path.join(extensionsRoot, item.name);
      const metadataPath = path.join(root, 'extension.json');
      let metadata = null;
      let parseError = null;
      if (existsSync(metadataPath)) {
        try {
          metadata = readJson(metadataPath);
        } catch (error) {
          parseError = error.message;
        }
      }
      return { id: item.name, root, metadata, parseError };
    });
}

function declaredSidecarEntries(repoRoot) {
  return extensionEntries(repoRoot).filter((entry) => hasSidecarCapability(entry));
}

function hasSidecarCapability(entry) {
  return Array.isArray(entry.metadata?.capabilities)
    && entry.metadata.capabilities.includes('loopback-sidecar');
}

function vendoredDir(entry) {
  if (!hasSidecarCapability(entry)) return null;
  const runtime = entry.metadata?.sidecar?.runtime;
  if (runtime?.kind !== 'vendored' || !isSafeRelativePath(runtime.path)) return null;
  return path.join(entry.root, runtime.path.split('/').join(path.sep));
}

function relative(repoRoot, filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join('/');
}

function expectedPort(sidecar) {
  try {
    const url = new URL(sidecar.origin);
    if (url.port) return Number(url.port);
    return url.protocol === 'https:' ? 443 : 80;
  } catch (_) {
    return null;
  }
}

function vendoredOriginIsCanonical(sidecar) {
  if (typeof sidecar?.origin !== 'string') return false;
  const match = /^http:\/\/127\.0\.0\.1:([1-9]\d*)$/.exec(sidecar.origin.trim());
  if (!match) return false;
  const port = Number(match[1]);
  return Number.isInteger(port) && port <= 65535;
}

function commandTokens(command) {
  return (command.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+/g) || [])
    .map((token) => {
      if ((token.startsWith('"') && token.endsWith('"'))
          || (token.startsWith("'") && token.endsWith("'"))) {
        return token.slice(1, -1);
      }
      return token;
    });
}

function normalizedUnitPath(value) {
  if (typeof value !== 'string' || !value) return null;
  let unquoted = value.trim();
  if ((unquoted.startsWith('"') && unquoted.endsWith('"'))
      || (unquoted.startsWith("'") && unquoted.endsWith("'"))) {
    unquoted = unquoted.slice(1, -1);
  }
  return path.posix.normalize(unquoted.replaceAll('\\', '/'));
}

function runsCanonicalEntrypoint(
  directive,
  runtimePath,
  workingDirectory,
  installDirectory
) {
  const equals = directive.indexOf('=');
  if (equals < 0) return false;
  const command = directive.slice(equals + 1).trim();
  const tokens = commandTokens(command);
  if (tokens.length === 0) return false;

  if (tokens[0] !== '/usr/bin/python3') return false;
  tokens.shift();
  let sawNoSite = false;
  let sawUnbuffered = false;
  while (tokens.length > 0 && tokens[0].startsWith('-')) {
    if (tokens[0] === '-S' && !sawNoSite) sawNoSite = true;
    else if (tokens[0] === '-u' && !sawUnbuffered) sawUnbuffered = true;
    else return false;
    tokens.shift();
  }
  if (!sawNoSite || tokens.length !== 1 || path.basename(tokens[0]) !== 'sidecar.py') return false;
  const scriptToken = tokens[0];

  const normalizedRuntime = path.posix.normalize(runtimePath);
  const normalizedInstallDirectory = normalizedUnitPath(installDirectory);
  const normalizedWorkingDirectory = normalizedUnitPath(workingDirectory);
  if (normalizedInstallDirectory === null || normalizedWorkingDirectory === null) {
    return false;
  }
  const expectedWorkingDirectory = path.posix.join(
    normalizedInstallDirectory,
    normalizedRuntime
  );
  if (normalizedWorkingDirectory !== expectedWorkingDirectory) {
    return false;
  }
  const normalizedScript = normalizedUnitPath(scriptToken);
  return normalizedScript === 'sidecar.py'
    || normalizedScript === `${normalizedWorkingDirectory}/sidecar.py`;
}

export function checkScaffoldSync(repoRoot, { write = false } = {}) {
  const canonicalDir = path.join(repoRoot, 'examples', 'sidecar-scaffold');
  const canonical = new Map();
  const failures = [];
  for (const name of CANON_FILES) {
    const filePath = path.join(canonicalDir, name);
    if (!existsSync(filePath)) failures.push(`MISSING  ${relative(repoRoot, filePath)} (canonical scaffold file)`);
    else canonical.set(name, readFileSync(filePath));
  }

  let vendoredCount = 0;
  let externalCount = 0;
  let synced = 0;
  for (const entry of declaredSidecarEntries(repoRoot)) {
    const runtime = entry.metadata?.sidecar?.runtime;
    if (runtime?.kind === 'external') {
      externalCount += 1;
      continue;
    }
    if (runtime?.kind !== 'vendored') {
      failures.push(`INVALID  extensions/${entry.id}/extension.json sidecar.runtime.kind must be vendored or external`);
      continue;
    }
    vendoredCount += 1;
    const dir = vendoredDir(entry);
    if (!dir) {
      failures.push(`INVALID  extensions/${entry.id}/extension.json sidecar.runtime.path must be safe and relative`);
      continue;
    }
    if (pathHasSymlink(entry.root, entry.metadata.sidecar.runtime.path)) {
      failures.push(`INVALID  ${relative(repoRoot, dir)} runtime path must not contain symlinks`);
      continue;
    }
    for (const symlink of symlinksUnder(dir)) {
      failures.push(
        `INVALID  ${relative(repoRoot, path.join(dir, symlink))} runtime tree must not contain symlinks`
      );
    }
    for (const collision of importShadowCollisions(dir)) {
      failures.push(
        `INVALID  ${relative(repoRoot, path.join(dir, collision))} shadows a canonical Python module`
      );
    }
    if (!vendoredOriginIsCanonical(entry.metadata.sidecar)) {
      failures.push(`INVALID  extensions/${entry.id}/extension.json vendored sidecar.origin must use http://127.0.0.1 with an explicit port`);
    }
    if (entry.metadata.sidecar.health_path !== '/health') {
      failures.push(`INVALID  extensions/${entry.id}/extension.json vendored sidecar.health_path must be /health`);
    }

    for (const name of REQUIRED_VENDORED_FILES) {
      const destination = path.join(dir, name);
      let destinationStat = null;
      try {
        destinationStat = lstatSync(destination);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (destinationStat !== null && !destinationStat.isFile()) {
        failures.push(`INVALID  ${relative(repoRoot, destination)} must be a regular file`);
        continue;
      }
      if (write && CANON_FILES.includes(name) && canonical.has(name)) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(destination, canonical.get(name));
        synced += 1;
        continue;
      }
      if (destinationStat === null) {
        failures.push(`MISSING  ${relative(repoRoot, destination)} (vendored scaffold incomplete)`);
        continue;
      }
      if (CANON_FILES.includes(name) && canonical.has(name)
          && !readFileSync(destination).equals(canonical.get(name))) {
        failures.push(`DRIFT    ${relative(repoRoot, destination)} (differs from canonical examples/sidecar-scaffold/${name})`);
      }
      if (name === 'routes_impl.py' && !hasTopLevelRegister(destination)) {
        failures.push(`INVALID  ${relative(repoRoot, destination)} must define top-level synchronous register(app)`);
      }
    }

    const configPath = path.join(dir, 'sidecar.json');
    if (!existsSync(configPath) || !lstatSync(configPath).isFile()) continue;
    let config;
    try {
      config = readJson(configPath);
    } catch (error) {
      failures.push(`INVALID  ${relative(repoRoot, configPath)} (${error.message})`);
      continue;
    }
    const sidecar = entry.metadata.sidecar;
    if (config.id !== entry.metadata.id) {
      failures.push(`MISMATCH ${relative(repoRoot, configPath)} id must match extension.json id`);
    }
    if (config.port !== expectedPort(sidecar)) {
      failures.push(`MISMATCH ${relative(repoRoot, configPath)} port must match extension.json sidecar.origin`);
    }
    if (config.proxy_auth !== sidecar.proxy_auth) {
      failures.push(`MISMATCH ${relative(repoRoot, configPath)} proxy_auth must match extension.json sidecar.proxy_auth`);
    }
  }
  return { failures, vendoredCount, externalCount, synced };
}

export function checkSidecarUsage(repoRoot) {
  const failures = [];
  const warnings = [];
  const entries = extensionEntries(repoRoot);
  const canonicalBasePath = path.join(repoRoot, 'examples', 'sidecar-scaffold', 'sidecar_base.py');
  const canonicalBase = existsSync(canonicalBasePath) ? readFileSync(canonicalBasePath) : null;
  for (const entry of entries) {
    const entryFiles = walkFiles(entry.root);
    const allowedServerFile = vendoredDir(entry)
      ? path.join(vendoredDir(entry), 'sidecar_base.py')
      : null;
    for (const filePath of entryFiles) {
      const patterns = SERVER_PATTERNS.get(path.extname(filePath).toLowerCase());
      if (!patterns) continue;
      const contents = readFileSync(filePath);
      if (filePath === allowedServerFile) {
        if (canonicalBase !== null && contents.equals(canonicalBase)) continue;
        failures.push(
          `DRIFT    ${relative(repoRoot, filePath)} (server-file exemption requires byte identity with canonical sidecar_base.py)`
        );
        continue;
      }
      const source = contents.toString('utf8');
      for (const pattern of patterns) {
        if (pattern.test(source)) {
          failures.push(
            `ROGUE SERVER  ${relative(repoRoot, filePath)} matches ${pattern} — server code must use the canonical vendored scaffold or live in the declared external repository.`
          );
        }
      }
    }

    const dir = vendoredDir(entry);
    if (!dir) continue;
    if (pathHasSymlink(entry.root, entry.metadata.sidecar.runtime.path)) {
      failures.push(
        `INVALID RUNTIME  ${relative(repoRoot, dir)} — vendored runtime path must not contain symlinks`
      );
      continue;
    }
    for (const symlink of symlinksUnder(dir)) {
      failures.push(
        `INVALID RUNTIME  ${relative(repoRoot, path.join(dir, symlink))} — runtime tree must not contain symlinks`
      );
    }
    for (const dropInPath of entryFiles.filter((filePath) => (
      /(?:^|[/\\])[^/\\]+\.service\.d[/\\][^/\\]+\.conf$/.test(filePath)
    ))) {
      failures.push(
        `DISALLOWED DROP-IN  ${relative(repoRoot, dropInPath)} — vendored launch behavior must live in one reviewed .service unit`
      );
    }
    for (const unitPath of entryFiles.filter((filePath) => /\.(service|container)$/.test(filePath))) {
      if (unitPath.endsWith('.container')) {
        failures.push(
          `UNSUPPORTED CONTAINER  ${relative(repoRoot, unitPath)} — vendored Python sidecars must use a validated .service unit or declare an external runtime`
        );
        continue;
      }
      const source = readFileSync(unitPath, 'utf8');
      const directive = 'ExecStart';
      const workingDirectoryDirective = 'WorkingDirectory';
      const mainSection = 'Service';
      const unitDirectives = parseUnitDirectives(source);
      const mainDirectives = unitDirectives.filter((item) => item.section === mainSection);
      const allowedServiceDirectives = new Set([
        'Type', 'WorkingDirectory', 'Environment', 'ExecStart', 'Restart', 'RestartSec'
      ]);
      for (const item of mainDirectives) {
        if (!allowedServiceDirectives.has(item.name)
            || (item.name === 'Type' && item.value !== 'simple')
            || (item.name === 'Environment'
              && !/^(?:HERMES_WEBUI_STATE_DIR|HERMES_EXT_INSTALL_DIR)=\S+$/.test(item.value))) {
          failures.push(
            `DISALLOWED ${item.name}  ${relative(repoRoot, unitPath)} — service directives are restricted to the canonical launch environment`
          );
        }
      }
      const execs = mainDirectives
        .filter((item) => item.name === directive)
        .map((item) => item.raw);
      const workingDirectories = mainDirectives
        .filter((item) => item.name === workingDirectoryDirective);
      const workingDirectory = workingDirectories.length > 0
        ? workingDirectories.at(-1).value
        : null;
      const stateDirectories = mainDirectives
        .filter((item) => item.name === 'Environment')
        .map((item) => /^HERMES_WEBUI_STATE_DIR=(\S+)$/.exec(item.value)?.[1])
        .filter(Boolean);
      const stateDirectory = stateDirectories.length > 0
        ? stateDirectories.at(-1)
        : '%h/.hermes/webui';
      const installDirectories = mainDirectives
        .filter((item) => item.name === 'Environment')
        .map((item) => /^HERMES_EXT_INSTALL_DIR=(\S+)$/.exec(item.value)?.[1])
        .filter(Boolean);
      const installDirectory = installDirectories.length > 0
        ? installDirectories.at(-1)
        : path.posix.join(stateDirectory, 'extensions', entry.id);
      for (const [name, value] of [
        ...(stateDirectories.length > 0 && stateDirectory !== '%h/.hermes/webui'
          ? [['HERMES_WEBUI_STATE_DIR', stateDirectory]]
          : []),
        ...(installDirectories.length > 0
          ? [['HERMES_EXT_INSTALL_DIR', installDirectory]]
          : [])
      ]) {
        const normalized = normalizedUnitPath(value);
        if (!(normalized?.startsWith('/') || normalized === '%h' || normalized?.startsWith('%h/'))) {
          failures.push(
            `BAD ${name}  ${relative(repoRoot, unitPath)} — custom directories must be absolute or %h-anchored`
          );
        } else {
          warnings.push(
            `REVIEW ${relative(repoRoot, unitPath)} ${name}=${value} — confirm this is an operator-controlled, non-broadly-writable directory`
          );
        }
      }
      if (execs.length === 0) {
        failures.push(`MISSING ${directive}  ${relative(repoRoot, unitPath)} — must use /usr/bin/python3 -S [-u] sidecar.py`);
        continue;
      }
      if (execs.length > 1) {
        failures.push(`MULTIPLE ${directive}  ${relative(repoRoot, unitPath)} — exactly one launch command is allowed`);
        continue;
      }
      for (const exec of execs) {
        if (!runsCanonicalEntrypoint(
          exec,
          entry.metadata.sidecar.runtime.path,
          workingDirectory,
          installDirectory
        )) {
          failures.push(
            `BAD ${directive}  ${relative(repoRoot, unitPath)} — must use /usr/bin/python3 -S [-u] sidecar.py, got: ${exec.trim()}`
          );
        }
      }
    }
  }
  return { failures, warnings, scannedCount: entries.length };
}
