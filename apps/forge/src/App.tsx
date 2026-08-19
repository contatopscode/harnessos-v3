import type { JSX } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router';
import { AppShell } from './components/AppShell';
import { LoginPage } from './routes/LoginPage';
import { ClientesPage } from './routes/ClientesPage';
import { ProjetosPage } from './routes/ProjetosPage';
import { DemandasPage } from './routes/DemandasPage';
import { PipelinesPage } from './routes/PipelinesPage';
import { SubAgentsPage } from './routes/SubAgentsPage';
import { SkillsPage } from './routes/SkillsPage';
import { CustosPage } from './routes/CustosPage';
import { TracesPage } from './routes/TracesPage';
import { ChatPage } from './routes/ChatPage';
import { NotFoundPage } from './routes/NotFoundPage';

export function App(): JSX.Element {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<AppShell />}>
          <Route path="/" element={<Navigate to="/projetos" replace />} />
          <Route path="/clientes" element={<ClientesPage />} />
          <Route path="/projetos" element={<ProjetosPage />} />
          <Route path="/demandas" element={<DemandasPage />} />
          <Route path="/pipelines" element={<PipelinesPage />} />
          <Route path="/subagents" element={<SubAgentsPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/custos" element={<CustosPage />} />
          <Route path="/traces" element={<TracesPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
