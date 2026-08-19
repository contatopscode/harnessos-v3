import { PagePlaceholder } from '../components/PagePlaceholder';

export function SkillsPage() {
  return (
    <PagePlaceholder
      title="Skills"
      description="Catálogo de skills (procedimentos reutilizáveis que o agente pode invocar). Instalados via botão 1-clique no Console do HarnessOS."
      bullets={[
        'Lista de skills (do @archon/core/skills)',
        'Botão "Instalar em todos os projetos"',
        'Detalhe com SKILL.md + metadata',
      ]}
    />
  );
}
