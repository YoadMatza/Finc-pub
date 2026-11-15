import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  workerUp: vi.fn(async () => true),
  workerPost: vi.fn(async () => ({ status: 200, body: [] as unknown })),
}));
vi.mock('./worker-client.js', () => ({ workerUp: client.workerUp, workerPost: client.workerPost, workerHealth: vi.fn(async () => null) }));

const { hostPath, registerSyncCommands, syncRoute } = await import('./sync.js');

describe('finc sync: where it runs (security research P1-13)', () => {
  it('without a running worker everything runs locally, as before', () => {
    expect(syncRoute({ showBrowser: false }, false)).toEqual({ route: 'local' });
    expect(syncRoute({ showBrowser: true }, false)).toEqual({ route: 'local' });
  });

  it('with a running worker it delegates (dump and dry run go through the worker too)', () => {
    expect(syncRoute({ showBrowser: false }, true)).toEqual({ route: 'delegate' });
  });

  it('--show-browser while the worker runs is refused, with how to do it instead', () => {
    const r = syncRoute({ showBrowser: true }, true);
    expect(r.route).toBe('refuse');
    if (r.route !== 'refuse') return;
    expect(r.message).toContain('docker compose stop worker');
    expect(r.message).toContain('FINC_HOST=1');
  });
});

describe('finc sync asks workerUp, not /health (a 401 or a slow worker never means a local Chromium)', () => {
  const run = async (...args: string[]) => {
    const program = new Command();
    program.exitOverride();
    registerSyncCommands(program);
    await program.parseAsync(['node', 'finc', 'sync', ...args]);
  };
  afterEach(() => vi.clearAllMocks());

  it('delegates --dump --dry-run to the worker when workerUp says it is up', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await run('max', '--dump', '--dry-run', '-m', '2');
    expect(client.workerUp).toHaveBeenCalledOnce();
    expect(client.workerPost).toHaveBeenCalledWith('/sync', { institutions: ['max'], months: 2, dump: true, dryRun: true });
  });

  it('refuses --show-browser when workerUp says it is up, and posts nothing', async () => {
    await expect(run('max', '--show-browser')).rejects.toThrow('docker compose stop worker');
    expect(client.workerPost).not.toHaveBeenCalled();
  });
});

describe('dump paths printed for the PC', () => {
  it('maps a file under the container data dir to the host data dir', () => {
    expect(hostPath('/data/dumps/max-1.json', '/data', 'D:\\projects\\finc\\data')).toBe('D:\\projects\\finc\\data\\dumps\\max-1.json');
    expect(hostPath('/data/dumps/max-1.json', '/data/', 'D:\\finc\\data\\')).toBe('D:\\finc\\data\\dumps\\max-1.json');
  });
  it('leaves other paths and runs without FINC_HOST_DATA_DIR alone', () => {
    expect(hostPath('/database/x.json', '/data', 'D:\\finc\\data')).toBe('/database/x.json');
    expect(hostPath('/data/dumps/max-1.json', '/data', undefined)).toBe('/data/dumps/max-1.json');
    expect(hostPath('/data/dumps/max-1.json', '/data', '  ')).toBe('/data/dumps/max-1.json');
  });
});
