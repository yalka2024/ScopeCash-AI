/**
 * Tool adapter contract tests for ScopeCash AI.
 *
 * Validates that every generated integration tool honours the adapter contract:
 *   - exports name + run()
 *   - reports a valid capability status (mock | live | unimplemented)
 *   - mock mode returns clearly-labeled mock data (`_mock: true`)
 *   - live mode REFUSES when unimplemented (never returns a fake dressed as real)
 *
 * These SAME tests validate YOUR real adapter after you implement realRun() and
 * flip `realImplemented` — so going live is verifiable, not a leap of faith.
 */
const registry = require('../../lib/tool-registry');
const capabilities = require('../../lib/capabilities');

const tools = registry.listTools();

describe('tool registry + capabilities', () => {
  test('registry loads tools', () => {
    expect(Array.isArray(tools)).toBe(true);
  });

  test('capability summary matches the registry', () => {
    expect(capabilities.toolCapabilities().length).toBe(tools.length);
    expect(capabilities.summary().total).toBe(tools.length);
  });
});

describe.each(tools.map((t) => [t.name, t]))('tool adapter: %s', (name, tool) => {
  test('exports name + run()', () => {
    expect(typeof tool.name).toBe('string');
    expect(typeof tool.run).toBe('function');
  });

  // Only generated integration adapters carry the full contract (they have envKey).
  const isAdapter = typeof tool.envKey === 'string' && tool.envKey.length > 0;

  (isAdapter ? test : test.skip)('reports a valid capability status', () => {
    expect(typeof tool.status).toBe('function');
    expect(['mock', 'live', 'unimplemented']).toContain(tool.status());
  });

  (isAdapter ? test : test.skip)('mock mode returns labeled mock data', async () => {
    const prev = process.env[tool.envKey];
    delete process.env[tool.envKey];                 // default → mock
    const out = await tool.run({ _probe: true }, {});
    expect(out && out._mock).toBe(true);
    if (prev === undefined) delete process.env[tool.envKey]; else process.env[tool.envKey] = prev;
  });

  (isAdapter ? test : test.skip)('live mode never returns mock-tagged data', async () => {
    const prev = process.env[tool.envKey];
    process.env[tool.envKey] = 'live';
    let out;
    let threw = false;
    try { out = await tool.run({ _probe: true }, {}); }
    catch (e) { threw = true; }   // refusing (unimplemented / unconfigured) is correct — not a fake
    finally {
      if (prev === undefined) delete process.env[tool.envKey]; else process.env[tool.envKey] = prev;
    }
    if (!threw) expect(out && out._mock).not.toBe(true);
  });
});

