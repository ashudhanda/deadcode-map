'use strict';

/**
 * MCP server tests: speak JSON-RPC over stdio to the real server.
 * Hermetic and offline — temp fixture copies only, no network.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MCP_BIN = path.join(ROOT, 'bin', 'deadcode-map-mcp.js');
const CLI_BIN = path.join(ROOT, 'bin', 'deadcode-map.js');
const PLUGIN_DIR = path.join(ROOT, 'plugins', 'deadcode-map');

/** Minimal JSON-RPC client over a spawned MCP server's stdio. */
class McpClient {
  constructor(script, args) {
    this.proc = spawn(process.execPath, [script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buf = '';
    this.nextId = 1;
    this.pending = new Map();
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (chunk) => {
      this.buf += chunk;
      let idx;
      while ((idx = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, idx).trim();
        this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result);
        }
      }
    });
    this.proc.stderr.on('data', () => { /* server logs go to stderr by design */ });
  }

  async start() {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'deadcode-map-test', version: '0.1.0' },
    });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  async callTool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args });
    assert.ok(Array.isArray(result.content), 'tool result must have content');
    return result;
  }

  toolText(result) {
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, 'text');
    return result.content[0].text;
  }

  close() {
    this.proc.kill('SIGTERM');
  }
}

function copyFixture(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `dcm-mcp-${name}-`));
  fs.cpSync(path.join(ROOT, 'fixtures', name), dir, { recursive: true });
  return dir;
}

async function withClient(script, args, fn) {
  const client = new McpClient(script, args);
  try {
    await client.start();
    await fn(client);
  } finally {
    client.close();
  }
}

test('MCP: initialize reports the server, tools/list has all five tools', async () => {
  await withClient(MCP_BIN, [], async (c) => {
    const tools = await c.request('tools/list', {});
    const names = tools.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['explain_finding', 'fix_safe', 'get_map', 'scan_repo', 'status']);
    for (const t of tools.tools) {
      assert.ok(t.inputSchema && t.inputSchema.type === 'object', `${t.name} needs an input schema`);
    }
    const prompts = await c.request('prompts/list', {});
    assert.ok(prompts.prompts.some((p) => p.name === 'cleanup-dead-code'), 'cleanup-dead-code prompt must be listed');
  });
});

test('MCP: the `deadcode-map mcp` subcommand starts the same server', async () => {
  await withClient(CLI_BIN, ['mcp'], async (c) => {
    const tools = await c.request('tools/list', {});
    assert.ok(tools.tools.some((t) => t.name === 'scan_repo'));
  });
});

test('MCP: scan_repo findings match the CLI scan on the same repo', async () => {
  const dir = copyFixture('js-basic');
  // Write the CLI report OUTSIDE the scanned dir: a report.json inside
  // the repo would itself be scanned (its symbol strings count as
  // references) and change the findings.
  const jsonPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dcm-mcp-cli-')), 'report.json');
  const cli = spawnSync(process.execPath, [CLI_BIN, dir, '--json', jsonPath, '--no-color'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  const cliFindings = JSON.parse(fs.readFileSync(jsonPath, 'utf8')).findings
    .filter((f) => f.grade === 'SAFE' || f.grade === 'REVIEW')
    .map((f) => f.id)
    .sort();
  await withClient(MCP_BIN, [], async (c) => {
    const result = await c.callTool('scan_repo', { path: dir });
    assert.equal(result.isError, undefined, c.toolText(result));
    const payload = JSON.parse(c.toolText(result));
    assert.equal(payload.root, dir);
    assert.equal(payload.summary.byGrade.SAFE, 4);
    assert.equal(payload.summary.byGrade.REVIEW, 9);
    assert.equal(payload.total, cliFindings.length);
    assert.deepEqual(payload.findings.map((f) => f.id).sort(), cliFindings);
    // minGrade SAFE narrows to SAFE only.
    const safeOnly = JSON.parse(c.toolText(await c.callTool('scan_repo', { path: dir, minGrade: 'SAFE' })));
    assert.equal(safeOnly.total, 4);
    assert.ok(safeOnly.findings.every((f) => f.grade === 'SAFE'));
  });
});

test('MCP: explain_finding returns the full record with evidence and deleteDiff', async () => {
  const dir = copyFixture('js-basic');
  await withClient(MCP_BIN, [], async (c) => {
    const scanned = JSON.parse(c.toolText(await c.callTool('scan_repo', { path: dir })));
    const target = scanned.findings.find((f) => f.symbol === 'unusedImport');
    assert.ok(target, 'unusedImport must be in the scan');
    const explained = JSON.parse(c.toolText(await c.callTool('explain_finding', { path: dir, findingId: target.id })));
    assert.equal(explained.finding.id, target.id);
    assert.equal(explained.finding.grade, 'SAFE');
    assert.ok(explained.finding.evidence, 'full evidence must be present');
    assert.equal(explained.finding.evidence.importers, 0);
    assert.ok(typeof explained.finding.deleteDiff === 'string' && explained.finding.deleteDiff.length > 0, 'deleteDiff must be present');
    // Unknown id is a clean error, not a crash.
    const missing = await c.callTool('explain_finding', { path: dir, findingId: 'function:nope.js:nope:1' });
    assert.equal(missing.isError, true);
    assert.match(c.toolText(missing), /no finding with id/);
  });
});

test('MCP: scan_repo on a missing path returns an error, not a crash', async () => {
  await withClient(MCP_BIN, [], async (c) => {
    const result = await c.callTool('scan_repo', { path: path.join(os.tmpdir(), 'dcm-does-not-exist-xyz') });
    assert.equal(result.isError, true);
    assert.match(c.toolText(result), /no such directory/);
    // The server is still alive after the error.
    const tools = await c.request('tools/list', {});
    assert.ok(tools.tools.some((t) => t.name === 'scan_repo'));
  });
});

test('MCP: fix_safe with confirm:false refuses and deletes nothing', async () => {
  const dir = copyFixture('js-basic');
  await withClient(MCP_BIN, [], async (c) => {
    const result = await c.callTool('fix_safe', { path: dir, confirm: false });
    assert.equal(result.isError, true);
    assert.match(c.toolText(result), /confirm must be true/);
    assert.ok(fs.existsSync(path.join(dir, 'src', 'dead-file.js')), 'dead file must survive a refused fix');
  });
});

test('MCP: fix_safe with confirm:true deletes SAFE only, in a scratch git repo', async () => {
  const dir = copyFixture('js-basic');
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', dir, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', dir, 'add', '-A']);
  execFileSync('git', ['-C', dir, 'commit', '-qm', 'fixture']);
  await withClient(MCP_BIN, [], async (c) => {
    // A REVIEW id must be refused outright.
    const scanned = JSON.parse(c.toolText(await c.callTool('scan_repo', { path: dir })));
    const review = scanned.findings.find((f) => f.grade === 'REVIEW');
    const refused = await c.callTool('fix_safe', { path: dir, findingIds: [review.id], confirm: true });
    assert.equal(refused.isError, true);
    assert.match(c.toolText(refused), /not SAFE/);
    // All SAFE findings, confirmed.
    const result = await c.callTool('fix_safe', { path: dir, confirm: true });
    assert.equal(result.isError, undefined, c.toolText(result));
    const payload = JSON.parse(c.toolText(result));
    assert.equal(payload.removed, 4);
    assert.ok(payload.deletedFiles.includes('src/dead-file.js'));
    assert.ok(!fs.existsSync(path.join(dir, 'src', 'dead-file.js')), 'dead file should be deleted');
    assert.ok(!fs.existsSync(path.join(dir, 'src', 'dynamic.js')), 'dynamic.js (SAFE file) should be deleted');
    const used = fs.readFileSync(path.join(dir, 'src', 'used.js'), 'utf8');
    assert.ok(used.includes('usedFn'), 'live function must survive fix_safe');
    assert.ok(used.includes('privateDead'), 'REVIEW export must survive fix_safe');
    // The change is uncommitted in git, ready for review.
    const status = execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.ok(status.length > 0, 'git must show the uncommitted fix');
    assert.match(payload.note, /git diff/);
  });
});

test('MCP: get_map returns a summary and the map resource serves full HTML', async () => {
  const dir = copyFixture('js-basic');
  await withClient(MCP_BIN, [], async (c) => {
    const summary = JSON.parse(c.toolText(await c.callTool('get_map', { path: dir })));
    assert.ok(summary.nodes > 0);
    assert.ok(summary.edges >= 0);
    assert.equal(summary.summary.byGrade.SAFE, 4);
    assert.match(summary.mapResource, /^deadcode:\/\/map\//);
    const res = await c.request('resources/read', { uri: summary.mapResource });
    assert.equal(res.contents.length, 1);
    assert.equal(res.contents[0].mimeType, 'text/html');
    assert.match(res.contents[0].text, /<!DOCTYPE html>/);
    assert.match(res.contents[0].text, /deadcode-map/);
    assert.match(res.contents[0].text, /SAFE/);
  });
});

test('MCP: status returns counts, baseline presence, git flag and test command', async () => {
  const dir = copyFixture('js-basic');
  await withClient(MCP_BIN, [], async (c) => {
    const before = JSON.parse(c.toolText(await c.callTool('status', { path: dir })));
    assert.equal(before.summary.byGrade.SAFE, 4);
    assert.equal(before.baseline.present, false);
    assert.equal(before.gitRepo, false);
    assert.equal(before.filesScanned, 7);
    // Write a baseline and init git: status must reflect both.
    spawnSync(process.execPath, [CLI_BIN, dir, '--update-baseline', '--no-color'], { encoding: 'utf8' });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const after = JSON.parse(c.toolText(await c.callTool('status', { path: dir })));
    assert.equal(after.baseline.present, true);
    assert.ok(after.baseline.entries > 0);
    assert.equal(after.gitRepo, true);
  });
});

test('MCP: cleanup-dead-code prompt tells the agent the safe workflow', async () => {
  await withClient(MCP_BIN, [], async (c) => {
    const got = await c.request('prompts/get', { name: 'cleanup-dead-code', arguments: { path: '/tmp/example' } });
    const text = got.messages.map((m) => m.content.text).join('\n');
    assert.match(text, /scan_repo/);
    assert.match(text, /SAFE findings first/);
    assert.match(text, /--prove/);
    assert.match(text, /Never delete a REVIEW/);
  });
});

test('Plugin: plugin.json, marketplace.json and .mcp.json parse; SKILL.md has frontmatter', () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(plugin.name, 'deadcode-map');
  assert.equal(plugin.version, require('../package.json').version);
  assert.equal(plugin.author.name, 'Ashu');
  assert.equal(plugin.license, 'MIT');
  assert.ok(plugin.mcpServers['deadcode-map'], 'plugin.json must declare the MCP server');
  const serverEntry = plugin.mcpServers['deadcode-map'];
  assert.equal(serverEntry.type, 'stdio');
  assert.equal(serverEntry.command, 'node');
  assert.ok(Array.isArray(serverEntry.args) && serverEntry.args.length === 1);
  // The file the config points at must exist in the repo.
  const target = serverEntry.args[0].replace('${CLAUDE_PLUGIN_ROOT}', path.join(PLUGIN_DIR));
  assert.ok(fs.existsSync(target), `MCP server file must exist: ${target}`);

  // The repo root is the marketplace: .claude-plugin/marketplace.json
  // lists the plugin at ./plugins/deadcode-map.
  const marketplace = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(marketplace.name, 'deadcode-map');
  assert.equal(marketplace.owner.name, 'ashudhanda');
  assert.deepEqual(marketplace.plugins, [{ name: 'deadcode-map', source: './plugins/deadcode-map' }]);

  const mcp = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, '.mcp.json'), 'utf8'));
  assert.deepEqual(mcp.mcpServers, plugin.mcpServers);

  const skill = fs.readFileSync(path.join(PLUGIN_DIR, 'skills', 'deadcode-map', 'SKILL.md'), 'utf8');
  assert.ok(skill.startsWith('---\n'), 'SKILL.md must start with frontmatter');
  const frontmatter = skill.slice(4, skill.indexOf('\n---', 4));
  assert.match(frontmatter, /^name: deadcode-map$/m);
  assert.match(frontmatter, /^description: /m);
  assert.ok(skill.split('\n').length < 500, 'SKILL.md must stay under ~500 lines');
});
