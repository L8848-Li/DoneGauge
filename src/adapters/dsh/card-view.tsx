import {
  byReviewPriority,
  isEvidencePath,
  readCardData,
  statuses,
} from './card-data.js';
import stylesheet from './card.css';

interface ToolViewProps {
  phase: 'preparing' | 'start' | 'result';
  block: {
    meta?: unknown;
    isError?: boolean;
    content?: readonly { type: string; text?: string }[];
    error?: { reason?: string };
  };
  openFile: (path: string) => void;
}

function FileButton({
  label,
  path,
  open,
}: {
  label: string;
  path: string;
  open: ToolViewProps['openFile'];
}) {
  return (
    <button
      type="button"
      className="dg-file"
      title={path}
      onClick={() => open(path)}
    >
      {label}
      <span aria-hidden="true">↗</span>
    </button>
  );
}

function DoneGaugeCard({ phase, block, openFile }: ToolViewProps) {
  const data =
    phase === 'result' && !block.isError ? readCardData(block.meta) : undefined;
  if (!data) {
    const message =
      phase === 'result'
        ? block.content
            ?.flatMap((item) =>
              item.type === 'text' && typeof item.text === 'string'
                ? [item.text]
                : [],
            )
            .join('\n') ||
          block.error?.reason ||
          'The tool did not return a displayable result.'
        : 'Checking acceptance…';
    return (
      <section
        aria-label="DoneGauge acceptance"
        className="dg-card"
        data-outcome={block.isError ? 'review' : undefined}
      >
        <header className="dg-header">
          <strong>
            {block.isError ? 'DoneGauge · Check unavailable' : 'DoneGauge'}
          </strong>
          <div
            className="dg-message"
            role={phase === 'result' ? undefined : 'status'}
          >
            {message}
          </div>
        </header>
      </section>
    );
  }

  const verified = data.finalStatus === 'VERIFIED';
  return (
    <section
      aria-label="DoneGauge acceptance"
      className="dg-card"
      data-outcome={verified ? 'verified' : 'review'}
    >
      <header className="dg-header">
        <div className="dg-heading">
          <span className="dg-mark" aria-hidden="true">
            {verified ? '✓' : '!'}
          </span>
          <div className="dg-identity">
            <strong>DoneGauge</strong>
            <div className="dg-task">{data.task}</div>
          </div>
          <strong className="dg-outcome">{data.finalStatus}</strong>
        </div>
        <div className="dg-progress" aria-hidden="true">
          {statuses
            .filter((status) => data.summary[status] > 0)
            .map((status) => (
              <span
                key={status}
                data-status={status}
                style={{ flexGrow: data.summary[status] }}
              />
            ))}
        </div>
        <dl className="dg-counts" aria-label="Acceptance status counts">
          {statuses.map((status) => (
            <div key={status} className="dg-count" data-status={status}>
              <dt>{status}</dt>
              <dd>{data.summary[status]}</dd>
            </div>
          ))}
        </dl>
      </header>
      {data.warnings.length > 0 && (
        <ul className="dg-warnings" aria-label="Verification warnings">
          {data.warnings.map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      )}
      <div className="dg-criteria">
        {byReviewPriority(data.criteria).map((criterion, index) => {
          const hasXml = isEvidencePath(criterion.testEvidencePath, data.runId);
          return (
            <details
              className="dg-criterion"
              data-status={criterion.status}
              key={`${criterion.id}-${index}`}
            >
              <summary>
                <span className="dg-badge">{criterion.status}</span>
                <span className="dg-criterion-label">
                  <strong>{criterion.id}</strong>{' '}
                  <span>{criterion.reason}</span>
                </span>
                <span className="dg-chevron" aria-hidden="true" />
              </summary>
              <div className="dg-detail">
                <dl className="dg-facts">
                  {criterion.execution && (
                    <div>
                      <dt>Execution</dt>
                      <dd>{criterion.execution}</dd>
                    </div>
                  )}
                  <div>
                    <dt>Evidence ID</dt>
                    <dd>
                      {criterion.evidenceId ? (
                        <code>{criterion.evidenceId}</code>
                      ) : (
                        'No execution evidence'
                      )}
                    </dd>
                  </div>
                  {criterion.targetTests > 0 && (
                    <div>
                      <dt>JUnit targets executed</dt>
                      <dd>
                        {criterion.executedTargetTests}/{criterion.targetTests}
                      </dd>
                    </div>
                  )}
                </dl>
                {criterion.targetTestResults.length > 0 && (
                  <ul className="dg-tests">
                    {criterion.targetTestResults.map((item, itemIndex) => (
                      <li key={itemIndex}>
                        <span>
                          {item.className ? `${item.className} › ` : ''}
                          {item.name}
                        </span>
                        <strong>{item.outcome}</strong>
                      </li>
                    ))}
                  </ul>
                )}
                {hasXml && (
                  <div className="dg-xml">
                    {criterion.testEvidenceAvailable === false ? (
                      <span>JUnit XML unavailable</span>
                    ) : (
                      <FileButton
                        label="JUnit XML"
                        path={criterion.testEvidencePath}
                        open={openFile}
                      />
                    )}
                    <code>{criterion.testEvidencePath}</code>
                  </div>
                )}
              </div>
            </details>
          );
        })}
      </div>
      <footer className="dg-footer" aria-label="Local reports">
        <FileButton
          label="Markdown report"
          path={data.reports.markdown}
          open={openFile}
        />
        <FileButton
          label="JSON report"
          path={data.reports.json}
          open={openFile}
        />
      </footer>
    </section>
  );
}

const slot = 'tool.call.toolview';
export const inject = ['slots'];

interface ClientContext {
  on(event: 'dispose', listener: () => void): unknown;
  slots: {
    inject(name: typeof slot, register: () => void): void;
    register(
      binding: { name: typeof slot; key: string },
      component: typeof DoneGaugeCard,
    ): void;
  };
}

export function apply(ctx: ClientContext): void {
  if (typeof document !== 'undefined') {
    const style = document.createElement('style');
    style.dataset.plugin = 'donegauge';
    style.textContent = stylesheet;
    document.head.append(style);
    ctx.on('dispose', () => style.remove());
  }
  ctx.slots.inject(slot, () => {
    ctx.slots.register({ name: slot, key: 'donegauge_check' }, DoneGaugeCard);
    ctx.slots.register(
      { name: slot, key: 'donegauge_review_run' },
      DoneGaugeCard,
    );
  });
}
