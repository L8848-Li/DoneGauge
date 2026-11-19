import { writeFile, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export const name = 'donegauge-host-smoke';
export const inject = ['tools', 'agents', 'approval'];
const path = (file) => join(import.meta.dirname, file);
async function publish(file, value) {
  await writeFile(path(file + '.tmp'), JSON.stringify(value));
  await rename(path(file + '.tmp'), path(file));
}

export function apply(ctx) {
  const invoke = async (name, args, agent) =>
    (
      await ctx.tools.execute({
        calls: [
          {
            type: 'tool-call',
            id: randomUUID(),
            name,
            arguments: JSON.stringify(args),
          },
        ],
        signal: globalThis.AbortSignal.timeout(10000),
        ...(agent ? { agent } : {}),
      })
    ).results[0].result;
  const native = async () => {
    const handle = await ctx.agents.create({
      sessionId: randomUUID(),
      meta: { cwd: process.cwd() },
    });
    const { agent } = handle;
    const decisions = [];
    let decision = 'rejected';
    const answer = agent.ctx.on(
      'approval/request',
      async (req, next) => {
        if (req.toolName !== 'donegauge_review_run' || req.agent !== agent)
          return next();
        decisions.push(decision);
        return decision;
      },
      { prepend: true },
    );
    try {
      agent.session.append('turn/start', { turn: 1 });
      const select = async (task) => {
        const preview = await invoke('donegauge_review', { task }, agent);
        if (preview.isError) throw new Error(JSON.stringify(preview));
        return { draft: preview.value.draft, revision: preview.value.revision };
      };
      const args = await select('login after registration');
      const run = (args) => invoke('donegauge_review_run', args, agent);
      const denied = await run(args);
      decision = 'cancelled';
      const cancelled = await run(args);
      decision = 'allowed-once';
      const passed = await run(args);
      const failed = await run(
        await select(
          'login after registration in the regressed implementation',
        ),
      );
      return { denied, cancelled, passed, failed, decisions };
    } finally {
      answer();
      agent.session.append('turn/end', {
        turn: 1,
        reason: { kind: 'completed' },
      });
      await handle.dispose();
    }
  };
  const work = async () => {
    for (let attempt = 0; attempt < 100; attempt++) {
      await delay(50);
      if (!ctx.tools.get('donegauge_review_result')) continue;
      let baseline;
      try {
        baseline = await invoke('donegauge_check', {});
      } catch (error) {
        if (error.name === 'ToolExecutorUnavailableError') continue;
        throw error;
      }
      const preview = await invoke('donegauge_review', {
        task: 'login after registration; manual requirement',
      });
      if (preview.isError) throw new Error(JSON.stringify(preview));
      const { draft, revision } = preview.value;
      const refused = await invoke('donegauge_review_run', { draft, revision });
      await publish('draft.json', { draft });
      for (let poll = 0; poll < 200; poll++) {
        const shared = await readFile(path('cli-run.json'), 'utf8').catch(
          () => null,
        );
        if (!shared) {
          await delay(50);
          continue;
        }
        const handback = await invoke('donegauge_review_result', {
          draft,
          runId: JSON.parse(shared).runId,
        });
        return publish('host-result.json', {
          results: [{ result: baseline }],
          guidance: { preview, refused, handback, native: await native() },
        });
      }
      throw new Error('Timed out waiting for the CLI handoff.');
    }
    throw new Error('Host tools did not become ready.');
  };
  void work().catch((error) =>
    publish('host-result.json', { error: error.message }),
  );
}
