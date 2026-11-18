import type { CSSProperties } from 'react';
import { isEvidencePath, readCardData, statuses } from './card-data.js';

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

const tones = {
  PASS: '#26a269',
  FAIL: '#e05252',
  UNVERIFIED: '#cb9425',
  ERROR: '#b970d6',
};
const border = '1px solid color-mix(in srgb, currentColor 18%, transparent)';
const cardStyle: CSSProperties = {
  display: 'grid',
  gap: 12,
  border,
  borderRadius: 10,
  padding: 14,
  marginBlock: 6,
  color: 'inherit',
  fontSize: '0.875rem',
  lineHeight: 1.45,
  overflowWrap: 'anywhere',
};
const rowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: 8,
};
const muted: CSSProperties = { opacity: 0.76 };

function ResultBadge({ status }: { status: keyof typeof tones }) {
  const accent = tones[status];
  return (
    <span
      style={{
        padding: '2px 7px',
        borderRadius: 6,
        borderLeft: `3px solid ${accent}`,
        background: `color-mix(in srgb, ${accent} 13%, transparent)`,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {status}
    </span>
  );
}

function FileLink({
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
      title={path}
      style={{
        color: 'inherit',
        border,
        borderRadius: 6,
        background: 'transparent',
        padding: '3px 8px',
        cursor: 'pointer',
      }}
      onClick={() => open(path)}
    >
      {label}
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
      <section aria-label="DoneGauge acceptance" style={cardStyle}>
        <strong>
          {block.isError ? 'DoneGauge · check unavailable' : 'DoneGauge'}
        </strong>
        <div style={{ whiteSpace: 'pre-wrap', ...muted }}>{message}</div>
      </section>
    );
  }

  return (
    <section aria-label="DoneGauge acceptance" style={cardStyle}>
      <header>
        <div style={{ ...rowStyle, justifyContent: 'space-between' }}>
          <strong>DoneGauge</strong>
          <strong>{data.finalStatus}</strong>
        </div>
        <div style={muted}>{data.task}</div>
      </header>
      <div
        aria-label="Acceptance status counts"
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(98px, 1fr))',
          gap: 6,
        }}
      >
        {statuses.map((status) => (
          <div key={status} style={{ ...rowStyle, gap: 5 }}>
            <ResultBadge status={status} />
            <strong>{data.summary[status]}</strong>
          </div>
        ))}
      </div>
      {data.warnings.map((warning, index) => (
        <div key={index} style={muted}>
          {warning}
        </div>
      ))}
      <div>
        {data.criteria.map((criterion, index) => (
          <details
            key={`${criterion.id}-${index}`}
            style={{ borderTop: border, padding: '8px 0' }}
          >
            <summary style={{ cursor: 'pointer' }}>
              <ResultBadge status={criterion.status} />{' '}
              <strong>{criterion.id}</strong>
              <span style={{ ...muted, marginLeft: 7 }}>
                {criterion.reason}
              </span>
            </summary>
            <div style={{ display: 'grid', gap: 6, margin: '8px 0 0 12px' }}>
              {criterion.execution && (
                <div>Execution · {criterion.execution}</div>
              )}
              <div>
                Evidence ID · <code>{criterion.evidenceId || 'None'}</code>
              </div>
              {criterion.targetTests > 0 && (
                <div>
                  JUnit targets executed · {criterion.executedTargetTests}/
                  {criterion.targetTests}
                </div>
              )}
              {criterion.targetTestResults.length > 0 && (
                <ul style={{ paddingInlineStart: 20, margin: 0 }}>
                  {criterion.targetTestResults.map((item, itemIndex) => (
                    <li key={itemIndex}>
                      {item.className ? `${item.className} › ` : ''}
                      {item.name} · {item.outcome}
                    </li>
                  ))}
                </ul>
              )}
              {isEvidencePath(criterion.testEvidencePath, data.runId) && (
                <div style={rowStyle}>
                  <FileLink
                    label="JUnit XML"
                    path={criterion.testEvidencePath}
                    open={openFile}
                  />
                  <code style={muted}>{criterion.testEvidencePath}</code>
                </div>
              )}
            </div>
          </details>
        ))}
      </div>
      <footer style={rowStyle}>
        <FileLink
          label="Markdown report"
          path={data.reports.markdown}
          open={openFile}
        />
        <FileLink
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
  slots: {
    inject(name: typeof slot, register: () => void): void;
    register(
      binding: { name: typeof slot; key: string },
      component: typeof DoneGaugeCard,
    ): void;
  };
}

export function apply(ctx: ClientContext): void {
  ctx.slots.inject(slot, () => {
    ctx.slots.register({ name: slot, key: 'donegauge_check' }, DoneGaugeCard);
  });
}
