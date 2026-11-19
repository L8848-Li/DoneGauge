import { resolve } from 'node:path';
import { sha256 } from '../dist/src/core/config.js';
import { discoverTests } from '../dist/src/review/discovery.js';
import { createPlan } from '../dist/src/review/plan.js';
import {
  prepareRequest,
  requestProposal,
  proposalFrom,
} from '../dist/src/review/planner.js';

const duplicate = 'duplicate email is rejected';
const login = 'login after registration';
const password = 'password is hashed with per-user salt';
const total = 'test_exact_total';
const negative = 'test_negative_price';
const samples = {
  'node-registration': [
    ['同一邮箱注册两次应该拒绝第二次', duplicate],
    ['The registered password must not be stored as plain text', password],
    ['注册用户能用正确密码登录', login],
    ['Login shows an actionable message for a weak signup password', null],
    ['相同密码的不同用户应使用不同的盐', password],
    ['Reject a sign-up using the same email padded with whitespace', duplicate],
    ['No real browser should show a blank page after login', null],
    ['邮箱仅大小写不同也不能创建第二个账户', duplicate],
    ['A mistyped password must not sign the user in', login],
    ['Forgotten passwords can be reset by email', null],
  ],
  'python-cart': [
    ['小数价格相加必须精确', total],
    ['Reject the entire order if a line item has a negative price', negative],
    ['Empty baskets have a zero total', total],
    ['Checkout must reject unknown currency codes', null],
    ['购物车总价为正也不能抵消一个负价格的非法性', negative],
    ['0.10 plus 0.20 costs exactly 0.30', total],
    ['折扣券过期时显示具体原因', null],
    ['Zero-priced items must not change the sum', total],
    ['A basket containing 2.00 and -1.00 must be rejected', negative],
    [
      'Negative quantity is not the same as negative price: reject quantities below zero',
      null,
    ],
  ],
};
const [flag, approved, ...extra] = process.argv.slice(2);
if ((flag !== undefined && (flag !== '--send' || !approved)) || extra.length)
  throw new Error(
    'Usage: node scripts/evaluate-planner.mjs [--send DISCLOSURE_DIGEST]',
  );
const batch = [];
const signal = new globalThis.AbortController().signal;
for (const [project, rows] of Object.entries(samples)) {
  const root = resolve(import.meta.dirname, '../examples', project);
  const { candidates } = await discoverTests(root, signal);
  for (const [index, [task, target]] of rows.entries()) {
    const id = project + '-' + (index + 1);
    const plan = createPlan(task, candidates);
    if (target && !candidates.some((candidate) => candidate.name === target))
      throw new Error(
        'Fixture label no longer matches a discovered test: ' + target,
      );
    batch.push({
      id,
      split: index < 7 ? 'development' : 'holdout',
      request: prepareRequest(root, id, plan, candidates, false),
      plan,
      candidates,
      target,
    });
  }
}
const digest = sha256(
  JSON.stringify(batch.map((entry) => entry.request.digest)),
);
if (!flag) {
  console.log(
    JSON.stringify(
      {
        sent: false,
        count: batch.length,
        digest,
        requests: batch.map(({ id, request }) => ({
          id,
          endpoint: request.endpoint,
          body: request.body,
        })),
      },
      null,
      2,
    ),
  );
} else {
  if (digest !== approved)
    throw new Error(
      'Batch changed; inspect a fresh disclosure before sending.',
    );
  const results = [];
  for (const { id, split, plan, candidates, target, request } of batch) {
    const content = await requestProposal(request, request.digest, signal, {
      key: process.env.DONEGAUGE_PLANNER_KEY,
    });
    const proposal = proposalFrom(content, request, id, plan);
    const recommended = proposal.items
      .filter((item) => item.candidateId)
      .map(
        (item) =>
          candidates.find((candidate) => candidate.id === item.candidateId)
            .name,
      );
    results.push({
      id,
      split,
      task: plan.task,
      target,
      recommended,
      items: proposal.items,
      correct: recommended.filter((name) => name === target).length,
      matched:
        target === null
          ? recommended.length === 0
          : recommended.includes(target),
    });
  }
  const metrics = ['development', 'holdout'].map((split) => {
    const rows = results.filter((row) => row.split === split);
    return {
      split,
      tasks: rows.length,
      expectedDecisionMatched: rows.filter((row) => row.matched).length,
      relevantBindings: rows.reduce((sum, row) => sum + row.correct, 0),
      totalBindings: rows.reduce((sum, row) => sum + row.recommended.length, 0),
      unsupportedBindings: rows
        .filter((row) => row.target === null)
        .reduce((sum, row) => sum + row.recommended.length, 0),
    };
  });
  console.log(
    JSON.stringify(
      { model: batch[0].request.body.model, metrics, results },
      null,
      2,
    ),
  );
}
