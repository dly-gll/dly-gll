from pathlib import Path
import json

SERVER = Path('server.js')
PACKAGE = Path('package.json')
GITIGNORE = Path('.gitignore')
ESLINT = Path('eslint.config.js')
TMP = Path('tmp.txt')

s = SERVER.read_text(encoding='utf-8')

startup_guard = '''// ===== 生产环境启动校验 =====\nif (process.env.NODE_ENV === "production") {\n  const errors = [];\n  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {\n    errors.push("SESSION_SECRET must be set and at least 32 characters in production");\n  }\n  if (!process.env.DEFAULT_ADMIN_PASSWORD || process.env.DEFAULT_ADMIN_PASSWORD.length < 8) {\n    errors.push("DEFAULT_ADMIN_PASSWORD must be set and at least 8 characters in production");\n  }\n  if (errors.length) {\n    console.error("Startup validation failed:");\n    errors.forEach(e => console.error("  - " + e));\n    process.exit(1);\n  }\n}\n\n'''
if not s.startswith('// ===== 生产环境启动校验 ====='):
    s = startup_guard + s

old = ".run('admin', hashPassword(process.env.DEFAULT_ADMIN_PASSWORD || 'admin123'), 'admin', new Date().toISOString());"
new = ".run('admin', hashPassword(process.env.DEFAULT_ADMIN_PASSWORD || crypto.randomBytes(16).toString('hex')), 'admin', new Date().toISOString());"
if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit('admin password fallback anchor not found')

old = "secret: process.env.SESSION_SECRET || 'diecut-schedule-secret-change-me',"
new = "secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),"
if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit('session secret fallback anchor not found')

old = '''// 中间件\napp.use((req, res, next) => {\n  res.setHeader('X-Content-Type-Options', 'nosniff');\n  res.setHeader('X-Frame-Options', 'SAMEORIGIN');\n  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');\n  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');\n  next();\n});'''
new = '''// 中间件\napp.use((req, res, next) => {\n  res.setHeader('X-Content-Type-Options', 'nosniff');\n  res.setHeader('X-Frame-Options', 'SAMEORIGIN');\n  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');\n  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');\n  res.setHeader('X-XSS-Protection', '1; mode=block');\n  res.setHeader('X-Download-Options', 'noopen');\n  res.setHeader('X-DNS-Prefetch-Control', 'off');\n  if (process.env.NODE_ENV === 'production') {\n    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');\n  }\n  next();\n});'''
if old in s:
    s = s.replace(old, new, 1)
elif new not in s:
    raise SystemExit('security header middleware anchor not found')

SERVER.write_text(s, encoding='utf-8')

package_obj = {
  "name": "diecut-smart-scheduler",
  "version": "5.1.0",
  "private": True,
  "description": "模切行业智能排程系统 - V5.1 交期优先修订版",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "check": "node --check server.js",
    "serve": "NODE_ENV=production node server.js",
    "lint": "eslint .",
    "lint:fix": "eslint . --fix"
  },
  "engines": {"node": ">=18"},
  "dependencies": {
    "better-sqlite3": "^11.7.0",
    "body-parser": "^1.20.3",
    "express": "^4.21.2",
    "express-session": "^1.18.1",
    "socket.io": "^4.8.1",
    "xlsx": "^0.18.5"
  },
  "devDependencies": {
    "@eslint/js": "^9.0.0",
    "eslint": "^9.0.0"
  }
}
PACKAGE.write_text(json.dumps(package_obj, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')

GITIGNORE.write_text('''# Dependencies\nnode_modules/\n\n# Environment\n.env\n.env.local\n.env.*.local\n\n# Database\ndata.db\ndata.db-shm\ndata.db-wal\n*.sqlite\n\n# Logs\n*.log\nnpm-debug.log*\n\n# OS files\n.DS_Store\nThumbs.db\nDesktop.ini\n\n# IDE\n.vscode/\n.idea/\n*.swp\n*.swo\n*~\n\n# Temporary files\ntmp.txt\n*.tmp\n*.bak\n''', encoding='utf-8')

# CommonJS flat-config form: same rule set, compatible with the CommonJS server.js project.
ESLINT.write_text('''const js = require("@eslint/js");\n\nmodule.exports = [\n  js.configs.recommended,\n  {\n    languageOptions: {\n      ecmaVersion: 2022,\n      sourceType: "commonjs",\n      globals: {\n        process: "readonly",\n        console: "readonly",\n        __dirname: "readonly",\n        __filename: "readonly",\n        module: "readonly",\n        require: "readonly",\n        exports: "readonly",\n        Buffer: "readonly",\n        setTimeout: "readonly",\n        setInterval: "readonly",\n        clearTimeout: "readonly",\n        clearInterval: "readonly",\n        URL: "readonly",\n        URLSearchParams: "readonly",\n        fetch: "readonly",\n        Response: "readonly",\n        Request: "readonly",\n        Headers: "readonly",\n      },\n    },\n    rules: {\n      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],\n      "no-console": "off",\n      "no-constant-condition": "warn",\n      "no-empty": ["warn", { allowEmptyCatch: true }],\n      "no-prototype-builtins": "warn",\n      "no-undef": "error",\n      "no-unreachable": "error",\n      "eqeqeq": ["error", "always"],\n      "no-var": "error",\n      "prefer-const": "warn",\n      "curly": ["warn", "multi-line"],\n      "no-throw-literal": "error",\n      "no-new-wrappers": "error",\n      "no-eval": "error",\n      "no-implied-eval": "error",\n    },\n  },\n  {\n    ignores: ["node_modules/", "public/", "data.db*", "*.min.js"],\n  },\n];\n''', encoding='utf-8')

if TMP.exists():
    TMP.unlink()

print('security hardening patch applied')