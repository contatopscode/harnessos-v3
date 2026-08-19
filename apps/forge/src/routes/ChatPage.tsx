import { PagePlaceholder } from '../components/PagePlaceholder';

export function ChatPage() {
  return (
    <PagePlaceholder
      title="Chat"
      description="Console de chat com o agente (mesmo chat do HarnessOS Web, mas com hook pra gravar cost no ledger do FORGE)."
      bullets={[
        'Stream SSE do agente',
        'Tools (leitura, edição, bash) — read-only no PR2',
        'Gravação automática de cost em /api/forge/costs (PR5)',
      ]}
    />
  );
}
