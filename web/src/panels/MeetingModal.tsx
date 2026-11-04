import { useState } from 'react';
import { useOffice } from '../state/store';

export function MeetingModal() {
  const open = useOffice((s) => s.meetingModalOpen);
  const setOpen = useOffice((s) => s.setMeetingModal);
  const instanceMap = useOffice((s) => s.instances);
  const instances = Object.values(instanceMap);
  const send = useOffice((s) => s.send);

  const [title, setTitle] = useState('Alinhamento');
  const [agenda, setAgenda] = useState('');
  const [who, setWho] = useState<string[]>([]);
  const [rounds, setRounds] = useState(3);

  if (!open) return null;

  const toggle = (id: string) =>
    setWho((w) => (w.includes(id) ? w.filter((x) => x !== id) : [...w, id]));

  const start = () => {
    send({ type: 'start_meeting', title, agenda, participants: who, maxRounds: rounds });
    setOpen(false);
    setWho([]);
    setAgenda('');
  };

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div className="modal panel" onClick={(e) => e.stopPropagation()} style={{ width: 480 }}>
        <h2>Convocar reunião</h2>
        <div className="grid" style={{ gridTemplateColumns: '1fr' }}>
          <label>
            título
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label>
            pauta
            <textarea
              rows={3}
              placeholder="o que precisa ser decidido?"
              value={agenda}
              onChange={(e) => setAgenda(e.target.value)}
            />
          </label>
          <label>
            participantes
            <div className="checks">
              {instances
                .filter((i) => i.state !== 'done')
                .map((i) => (
                  <label key={i.id}>
                    <input type="checkbox" checked={who.includes(i.id)} onChange={() => toggle(i.id)} />
                    {i.id}
                  </label>
                ))}
            </div>
          </label>
          <label>
            rodadas (máx.)
            <input
              type="number"
              min={1}
              max={10}
              value={rounds}
              onChange={(e) => setRounds(Number(e.target.value))}
              style={{ width: 80 }}
            />
          </label>
        </div>
        <footer>
          <button onClick={() => setOpen(false)}>Cancelar</button>
          <button className="primary" disabled={who.length === 0 || !agenda.trim()} onClick={start}>
            Iniciar reunião
          </button>
        </footer>
      </div>
    </div>
  );
}
