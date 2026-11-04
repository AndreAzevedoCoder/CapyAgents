import { useOffice } from '../state/store';
import { STATE_COLORS, STATE_LABELS } from '../stateColors';

function Team() {
  const instanceMap = useOffice((s) => s.instances);
  const instances = Object.values(instanceMap);
  const agents = useOffice((s) => s.agents);
  const selectedId = useOffice((s) => s.selectedId);
  const select = useOffice((s) => s.select);
  const send = useOffice((s) => s.send);
  const openEditor = useOffice((s) => s.openEditor);

  return (
    <section className="panel">
      <h3>
        Equipe
        <button onClick={() => openEditor(null)}>novo agente</button>
      </h3>
      {agents.map((def) => (
        <div key={def.config.name}>
          {instances
            .filter((i) => i.agent === def.config.name)
            .map((i) => (
              <button
                key={i.id}
                className={`member${i.id === selectedId ? ' selected' : ''}`}
                onClick={() => select(i.id)}
              >
                <span className="dot" style={{ background: STATE_COLORS[i.state] }} />
                <span className="who">
                  {i.id}
                  <small>
                    {STATE_LABELS[i.state]}
                    {i.task ? ` · ${i.task}` : ''}
                  </small>
                </span>
                <span className="cost">${i.costUsd.toFixed(3)}</span>
              </button>
            ))}
          <button
            className="member"
            style={{ color: 'var(--muted)', fontSize: 12 }}
            onClick={() => send({ type: 'spawn_instance', agent: def.config.name })}
            title={`Nova instância de ${def.config.name}`}
          >
            <span className="dot" style={{ background: 'transparent', border: '1px dashed var(--muted)' }} />
            <span className="who">+ {def.config.name}</span>
            <span
              className="cost"
              role="button"
              onClick={(e) => {
                e.stopPropagation();
                openEditor(def.config.name);
              }}
            >
              editar
            </span>
          </button>
        </div>
      ))}
    </section>
  );
}

function Pipelines() {
  const pipelines = useOffice((s) => s.pipelines);
  const runMap = useOffice((s) => s.runs);
  const runs = Object.values(runMap);
  const send = useOffice((s) => s.send);

  return (
    <section className="panel">
      <h3>Pipelines</h3>
      {pipelines.map((p) => (
        <div className="runrow" key={p.name}>
          <div className="title">
            <span title={p.description}>{p.name}</span>
            <button className="primary" onClick={() => send({ type: 'start_pipeline', pipeline: p.name })}>
              iniciar
            </button>
          </div>
        </div>
      ))}
      {runs
        .slice()
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 5)
        .map((run) => (
          <div className="runrow" key={run.id}>
            <div className="title">
              <span>{run.pipeline}</span>
              <span className="st">{run.status}</span>
            </div>
            <div className="steps">
              {run.steps.map((s) => (
                <span
                  key={s.stepId}
                  className={`stepchip ${s.status}`}
                  title={s.error ?? s.output?.slice(0, 400) ?? s.status}
                >
                  {s.stepId}
                  {s.instanceId ? ` · ${s.instanceId}` : ''}
                </span>
              ))}
            </div>
            {(run.status === 'running' || run.status === 'paused') && (
              <div className="actions">
                {run.status === 'running' ? (
                  <button onClick={() => send({ type: 'pipeline_control', runId: run.id, action: 'pause' })}>
                    pausar
                  </button>
                ) : (
                  <button onClick={() => send({ type: 'pipeline_control', runId: run.id, action: 'resume' })}>
                    retomar
                  </button>
                )}
                <button
                  className="danger"
                  onClick={() => send({ type: 'pipeline_control', runId: run.id, action: 'cancel' })}
                >
                  cancelar
                </button>
                <span className="st" style={{ marginLeft: 'auto', color: 'var(--muted)', fontSize: 11 }}>
                  ${run.costUsd.toFixed(3)}
                </span>
              </div>
            )}
          </div>
        ))}
    </section>
  );
}

function Meetings() {
  const meetingMap = useOffice((s) => s.meetings);
  const meetings = Object.values(meetingMap);
  const setMeetingModal = useOffice((s) => s.setMeetingModal);
  const active = meetings.filter((m) => m.status !== 'done' && m.status !== 'cancelled');
  const recent = meetings
    .filter((m) => m.status === 'done')
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, 3);

  return (
    <section className="panel">
      <h3>
        Reuniões
        <button onClick={() => setMeetingModal(true)}>convocar</button>
      </h3>
      {active.length === 0 && recent.length === 0 && (
        <div style={{ color: 'var(--muted)', fontSize: 12 }}>nenhuma reunião</div>
      )}
      {active.map((m) => (
        <div className="meetrow" key={m.id}>
          <div>
            {m.title} — rodada {m.currentRound}/{m.maxRounds}
          </div>
          <div className="who">{m.participants.join(', ')}</div>
        </div>
      ))}
      {recent.map((m) => (
        <div className="meetrow" key={m.id} title={m.summary ?? ''}>
          <div style={{ color: 'var(--muted)' }}>{m.title} — encerrada</div>
        </div>
      ))}
    </section>
  );
}

export function Rail() {
  return (
    <div className="rail">
      <Team />
      <Pipelines />
      <Meetings />
    </div>
  );
}
