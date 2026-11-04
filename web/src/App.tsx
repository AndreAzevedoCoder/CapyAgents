import { Scene } from './scene/Scene';
import { TopBar } from './panels/TopBar';
import { Rail } from './panels/Rail';
import { AgentPanel } from './panels/AgentPanel';
import { Approvals } from './panels/Approvals';
import { AgentEditor } from './panels/AgentEditor';
import { MeetingModal } from './panels/MeetingModal';
import { useOffice } from './state/store';

function Toasts() {
  const toasts = useOffice((s) => s.toasts);
  const dismiss = useOffice((s) => s.dismissToast);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast panel ${t.level}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function App() {
  return (
    <>
      <Scene />
      <div className="hud">
        <TopBar />
        <Rail />
        <AgentPanel />
        <Approvals />
        <Toasts />
        <div className="hint">
          arraste para orbitar · scroll para zoom · clique num agente para focar, fora para voltar
        </div>
      </div>
      <AgentEditor />
      <MeetingModal />
    </>
  );
}
